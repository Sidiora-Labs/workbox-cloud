import { beforeEach, describe, it, expect, vi } from "vitest";
import type { ExecutionContext } from "../../../context";
const state = vi.hoisted(() => ({
  row: undefined as any,
  rows: [] as any[],
  allowed: true,
  commands: [] as string[],
  deferred: [] as (() => unknown)[],
  locked: false,
  credential: undefined as any,
  createCredential: vi.fn(),
  updateCredential: vi.fn(),
  unitPresent: true,
  serviceActive: false,
  hostBusy: false,
}));
vi.mock("../../config/env", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("../external-deployments/providers/workbox", () => ({
  createWorkboxProvider: (options: any) => ({
    preflight: async () => ({ ready: true, reachable: true }),
    listSandboxes: () => options.request("http://127.0.0.1:8791/v1/sandboxes", { method: "GET" }),
    createSandbox: () => options.request("http://127.0.0.1:8791/v1/sandboxes", { method: "POST" }),
  }),
}));
vi.mock("@repo/db", () => ({
  repos: {
    workboxHost: {
      find: async () => state.row,
      list: async () => state.rows,
      byServer: async () => state.row,
      update: async (_org: string, _id: string, patch: any) => Object.assign(state.row, patch),
      create: async (data: any) =>
        (state.row = { ...data, createdAt: new Date(), updatedAt: new Date() }),
    },
    credential: {
      markInvalid: vi.fn(),
      listByOrg: async () => (state.credential ? [state.credential] : []),
      update: state.updateCredential,
      create: state.createCredential,
    },
  },
}));
vi.mock("../../lib/authorization", () => ({
  authorization: {
    authorize: async () => {
      if (!state.allowed) throw Error("denied");
    },
    checkPermissionOnResource: async () => state.allowed,
  },
}));
vi.mock("../system/server-provisioning", () => ({
  withServerProvisioning: async (_c: any, _s: string, work: () => unknown) => {
    if (state.locked) throw Error("busy");
    state.locked = true;
    try {
      return await work();
    } finally {
      state.locked = false;
    }
  },
}));
vi.mock("../../lib/server-execution", () => ({
  withServerExecution: async (_o: string, _s: string, work: any) =>
    work({
      exists: async () => state.unitPresent,
      readFile: async () => JSON.stringify({ id: "host", organizationId: "org" }),
      exec: async (command: string) => {
        state.commands.push(command);
        if (command.includes("is-active") && state.serviceActive) throw Error("still active");
        return "0123456789abcdef0123456789abcdef";
      },
    }),
}));
vi.mock("../../lib/background-work", () => ({
  deferBackgroundWork: async (work: () => unknown) => {
    state.deferred.push(work);
  },
}));
vi.mock("../../lib/credential-encryption", () => ({
  encryptSecretField: (value: string) => "encrypted:" + value,
  decryptSecretField: (value: string) => value.replace("encrypted:", ""),
}));
vi.mock("../credentials/credential.service", () => ({ writeCredentialSecrets: () => "encrypted" }));
vi.mock("./installer", () => ({
  WORKBOX_REVISION: "revision",
  WORKBOX_PORT: 8791,
  WORKBOX_HOME: "/opt/workbox-cloud-host",
  WORKBOX_CONFIG: "/etc/workbox-cloud-host",
  WORKBOX_UNIT: "workbox-cloud-host.service",
  hostSteps: () => [],
  probeWorkboxHost: async () => ({
    accepted: true,
    checks: [],
    blockers: [],
    identity: "0123456789abcdef0123456789abcdef",
  }),
  rootExecutor: async (e: any) => e,
  assertWorkboxHostIdle: async () => {
    if (state.hostBusy) throw Error("host operation still running");
  },
  runManagedWorkboxCommand: async (executor: any, command: string) => executor.exec(command),
  privateRequest: vi.fn(),
  installWorkboxHost: vi.fn(),
}));
import {
  listWorkboxHosts,
  getWorkboxHost,
  createWorkboxHost,
  managedWorkboxClient,
  actOnWorkboxHost,
} from "./service";
const ctx = { organizationId: "org", userId: "user" } as ExecutionContext;
const row = () => ({
  id: "host",
  organizationId: "org",
  serverId: "server",
  name: "My host",
  rootfs: "minimal",
  version: "revision",
  status: "ready",
  connectionId: "cred",
  progress: [],
  error: null,
  tokenEnc: "encrypted:secret",
  hostIdentity: "0123456789abcdef0123456789abcdef",
  generation: 1,
  leaseUntil: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
beforeEach(() => {
  state.row = undefined;
  state.rows = [];
  state.allowed = true;
  state.commands = [];
  state.deferred = [];
  state.locked = false;
  state.credential = undefined;
  state.unitPresent = true;
  state.serviceActive = false;
  state.hostBusy = false;
  state.createCredential.mockReset();
  state.updateCredential.mockReset();
});
describe("managed Workbox host safety", () => {
  it("filters inaccessible hosts and does not reveal tokens or host markers", async () => {
    state.rows = [row()];
    let result = await listWorkboxHosts(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("tokenEnc");
    expect(result[0]).not.toHaveProperty("hostIdentity");
    state.allowed = false;
    expect(await listWorkboxHosts(ctx)).toEqual([]);
  });
  it("returns an existing installation without creating duplicate work", async () => {
    state.row = row();
    const result = await createWorkboxHost(ctx, {
      serverId: "server",
      name: "other",
      rootfs: "agents",
      confirm: true,
    });
    expect(result.id).toBe("host");
    expect(state.deferred).toHaveLength(0);
  });
  it("marks an expired interrupted lease as failed for explicit retry", async () => {
    state.row = { ...row(), status: "installing", leaseUntil: new Date(0) };
    const result = await getWorkboxHost(ctx, "host");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("interrupted");
  });
  it("rejects managed transport without original scoped authority", async () => {
    state.row = row();
    const client = await managedWorkboxClient(
      "org",
      { managedHostId: "host", serverId: "server" },
      "secret",
    );
    await expect(client.listSandboxes()).rejects.toThrow();
    expect(state.commands).toHaveLength(0);
  });
  it("rejects stale server bindings before connecting", async () => {
    state.row = row();
    await expect(
      managedWorkboxClient("org", { managedHostId: "host", serverId: "another" }, "secret", ctx),
    ).rejects.toThrow("not ready");
    expect(state.commands).toHaveLength(0);
  });
  it("serializes concurrent retry admission and reuses a credential after interrupted registration", async () => {
    state.row = { ...row(), status: "failed", connectionId: null };
    state.credential = {
      id: "existing-credential",
      provider: "workbox",
      selector: "managed:host",
      publicFields: { managedHostId: "host", serverId: "server" },
    };
    const results = await Promise.allSettled([
      actOnWorkboxHost(ctx, "host", { action: "retry" }),
      actOnWorkboxHost(ctx, "host", { action: "retry" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.deferred).toHaveLength(1);
    await state.deferred[0]!();
    expect(state.createCredential).not.toHaveBeenCalled();
    expect(state.updateCredential).toHaveBeenCalled();
    expect(state.row.connectionId).toBe("existing-credential");
    expect(state.row.status).toBe("ready");
  });
  it("resumes an owned unit removal only when systemd confirms it inactive", async () => {
    state.row = row();
    state.unitPresent = false;
    const removed = await actOnWorkboxHost(ctx, "host", { action: "remove", confirm: true });
    expect(removed.status).toBe("removed");
    expect(state.commands.some((command) => command.includes("is-active"))).toBe(true);
    state.row = row();
    state.serviceActive = true;
    await expect(
      actOnWorkboxHost(ctx, "host", { action: "remove", confirm: true }),
    ).rejects.toThrow("still active");
    expect(state.row.status).toBe("ready");
  });
  it("rejects retry, start, stop and removal while a prior remote operation still owns the host lock", async () => {
    state.hostBusy = true;
    for (const action of ["retry", "start", "stop", "remove"] as const) {
      state.row = { ...row(), status: action === "retry" ? "failed" : "ready" };
      await expect(actOnWorkboxHost(ctx, "host", { action, confirm: true })).rejects.toThrow(
        "still running",
      );
      expect(state.row.generation).toBe(1);
      expect(state.row.status).toBe(action === "retry" ? "failed" : "ready");
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.deferred).toHaveLength(0);
    expect(state.commands).toHaveLength(0);
  });
  it("rejects sandbox creation while an orphaned host lifecycle command owns the lock", async () => {
    state.row = row();
    state.hostBusy = true;
    const client = await managedWorkboxClient(
      "org",
      { managedHostId: "host", serverId: "server" },
      "secret",
      ctx,
    );
    await expect(client.createSandbox({ name: "demo" } as any)).rejects.toThrow("still running");
  });
});

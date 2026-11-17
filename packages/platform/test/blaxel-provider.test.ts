import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialProvider, splitCredentialValues } from "@repo/core";
import type { ExternalTargetInput } from "@repo/contracts";
import {
  createBlaxelExternalAdapter,
  blaxelRequest,
} from "../src/engine/modules/external-deployments/providers/blaxel";
import { verifyCredentialValues } from "../src/engine/modules/credentials/verify";
import { safeFetch } from "../src/engine/lib/safe-fetch";
vi.mock("../src/engine/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
const context = { organizationId: "org-one" };
const target: ExternalTargetInput = {
  provider: "blaxel",
  workloadKind: "blaxel-sandbox",
  connectionId: "connection-one",
  providerIdentity: { workspaceId: "workspace-one" },
  resource: {
    name: "coding-sandbox",
    region: "us-pdx-1",
    memoryMb: "4096",
    ports: "3000",
    ttl: "1h",
  },
};
const adapter = () =>
  createBlaxelExternalAdapter(async () => ({
    publicFields: { workspaceId: "workspace-one" },
    secrets: { apiKey: "private-key" },
  }));
const reply = (status = 200, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as never;
beforeEach(() => vi.mocked(safeFetch).mockReset());

describe("Blaxel provider", () => {
  it("encrypts the API key and verifies a workspace with bounded read-only discovery", async () => {
    const provider = getCredentialProvider("blaxel")!;
    const values = splitCredentialValues(provider, {
      workspaceId: "workspace-one",
      apiKey: "private-key",
    });
    expect(values.publicFields).not.toHaveProperty("apiKey");
    vi.mocked(safeFetch).mockResolvedValue(reply(200, { data: [], meta: { total: 0 } }));
    expect(await verifyCredentialValues(provider, { selector: null, ...values })).toEqual({
      ok: true,
    });
    expect(safeFetch).toHaveBeenCalledWith(
      "https://api.blaxel.ai/v0/sandboxes?limit=1",
      expect.objectContaining({
        maxRedirects: 0,
        headers: expect.objectContaining({
          Authorization: "Bearer private-key",
          "X-Blaxel-Workspace": "workspace-one",
          "Blaxel-Version": "2026-04-28",
          "User-Agent": "workbox-cloud/1.0",
        }),
      }),
    );
  });
  it("keeps provider errors secret-safe", async () => {
    vi.mocked(safeFetch).mockResolvedValue(reply(403, { message: "private-key" }));
    const result = await verifyCredentialValues(getCredentialProvider("blaxel")!, {
      selector: null,
      publicFields: { workspaceId: "workspace-one" },
      secrets: { apiKey: "private-key" },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-key");
  });
  it("separates sandbox execution from preview application hosting", async () => {
    const client = adapter();
    expect((await client.capabilities(context, target)).supported).toContain("exec");
    const app = { ...target, workloadKind: "service" as const };
    const plan = await client.plan(context, {
      target: app,
      image: "app/my-image:v1",
      idempotencyKey: "plan-app-001",
    });
    expect(plan.accepted).toBe(true);
    expect(plan.warnings.join(" ")).toContain("private preview");
    expect(plan.capability.supported).not.toContain("exec");
    expect(
      (
        await client.plan(context, {
          target: app,
          image: "ghcr.io/org/app:v1",
          idempotencyKey: "plan-app-002",
        })
      ).accepted,
    ).toBe(false);
  });
  it("creates a sandbox using native runtime configuration and preserves submitted environment", async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(reply(404))
      .mockResolvedValueOnce(
        reply(200, { metadata: { name: "coding-sandbox" }, status: "DEPLOYING" }),
      );
    const client = adapter();
    const plan = await client.plan(context, { target, idempotencyKey: "plan-create-001" });
    const result = await client.apply(
      context,
      { planId: plan.planId, idempotencyKey: "apply-create-001", confirm: true },
      {
        ...plan,
        image: "blaxel/base-image:latest",
        environment: { PROJECT_MODE: "test" },
      } as never,
    );
    expect(result.status).toBe("provisioning");
    const body = JSON.parse(vi.mocked(safeFetch).mock.calls[1]![1]!.body!);
    expect(body.spec).toEqual({
      enabled: true,
      region: "us-pdx-1",
      runtime: {
        image: "blaxel/base-image:latest",
        memory: 4096,
        envs: [{ name: "PROJECT_MODE", value: "test" }],
        ports: [{ target: 3000, protocol: "HTTP" }],
        ttl: "1h",
      },
    });
    expect(body.metadata.labels).toMatchObject({ workboxOrganizationId: "org-one" });
  });
  it("refuses to adopt an unrelated existing sandbox with the same name", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      reply(200, { metadata: { name: "coding-sandbox", labels: {} }, status: "DEPLOYED" }),
    );
    const client = adapter();
    const plan = await client.plan(context, { target, idempotencyKey: "plan-existing-001" });
    await expect(
      client.apply(
        context,
        { planId: plan.planId, idempotencyKey: "apply-existing-001", confirm: true },
        plan,
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_TARGET_CONFLICT" });
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched workspace and invalid ports without mutations", async () => {
    const client = adapter();
    await expect(
      client.plan(context, {
        target: { ...target, providerIdentity: { workspaceId: "other" } },
        idempotencyKey: "plan-wrong-001",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_IDENTITY_MISMATCH" });
    expect(
      (
        await client.plan(context, {
          target: { ...target, resource: { ...target.resource, ports: "80", ttl: "1m" } },
          idempotencyKey: "plan-port-001",
        })
      ).accepted,
    ).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it("preserves argv boundaries when executing sandbox commands", async () => {
    const client = adapter();
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(
        reply(200, {
          metadata: { name: "coding-sandbox", url: "https://sbx-one.us-pdx-1.bl.run" },
          status: "DEPLOYED",
        }),
      )
      .mockResolvedValueOnce(
        reply(200, { status: "completed", stdout: "ok", stderr: "", exitCode: 0 }),
      );
    const plan = await client.plan(context, { target, idempotencyKey: "plan-exec-001" });
    const op = {
      id: "op",
      organizationId: context.organizationId,
      targetId: plan.target.targetId,
      kind: "apply",
      workloadKind: "blaxel-sandbox",
      status: "ready",
      idempotencyKey: "exec-test-001",
      target: plan.target,
      createdAt: plan.target.capturedAt,
      updatedAt: plan.target.capturedAt,
    } as const;
    const result = await client.exec!(context, op, {
      argv: ["printf", "%s", "$(whoami); 'literal'"],
      cwd: "/workspace",
    });
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(vi.mocked(safeFetch).mock.calls[1]![1]!.body!);
    expect(body.command).toBe("'printf' '%s' '$(whoami); '\"'\"'literal'\"'\"''");
    expect(body.waitForCompletion).toBe(true);
  });
  it("never sends a credential to a provider-returned arbitrary endpoint", async () => {
    await expect(
      blaxelRequest({ workspaceId: "workspace-one", apiKey: "private-key" }, "process", {
        endpoint: "https://attacker.example",
        method: "POST",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_ENDPOINT_INVALID" });
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it("marks interrupted mutations as unknown and preserves asynchronous deletion state", async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error("socket reset with private-key"));
    await expect(
      blaxelRequest({ workspaceId: "workspace-one", apiKey: "private-key" }, "sandboxes", {
        method: "POST",
        body: {},
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_UNKNOWN_OUTCOME" });
    const client = adapter();
    const plan = await client.plan(context, { target, idempotencyKey: "plan-delete-001" });
    const op = {
      id: "op",
      organizationId: context.organizationId,
      targetId: plan.target.targetId,
      kind: "apply",
      workloadKind: "blaxel-sandbox",
      status: "ready",
      idempotencyKey: "delete-test-001",
      target: plan.target,
      createdAt: plan.target.capturedAt,
      updatedAt: plan.target.capturedAt,
    } as const;
    vi.mocked(safeFetch).mockResolvedValueOnce(reply(200, { status: "DELETING" }));
    expect((await client.destroy!(context, op)).status).toBe("stopping");
    vi.mocked(safeFetch).mockResolvedValueOnce(reply(404));
    expect((await client.observe(context, { target })).status).toBe("stopped");
  });
});

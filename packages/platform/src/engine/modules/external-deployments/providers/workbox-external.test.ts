import { describe, expect, it } from "vitest";
import type { SafeFetchResponse } from "../../../lib/safe-fetch";
import { createWorkboxExternalAdapter } from "./workbox-external";
import { WorkboxProvider } from "./workbox";

function response(value: unknown, status = 200): SafeFetchResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { "content-type": "application/json" },
    text: async () => JSON.stringify(value),
    json: async () => value,
    bytes: async () => Buffer.from(JSON.stringify(value)),
  };
}

const target = {
  provider: "workbox" as const,
  workloadKind: "workbox-sandbox" as const,
  connectionId: "connection-1",
  providerIdentity: { endpoint: "https://workbox.example.test", organizationId: "org-1" },
  resource: { name: "agent-1", rootfs: "minimal", runtime: "node22" },
};

function providerFor(body: unknown = { id: "sbx-1", desired: "READY" }) {
  return new WorkboxProvider({
    baseUrl: "https://workbox.example.test",
    apiKey: "wbk_test",
    request: async (url, options) => {
      if (url.endsWith("/healthz") || url.endsWith("/readyz")) return response({ ok: true });
      if (url.endsWith("/v1/sandboxes") && options.method === "POST") return response(body, 201);
      if (url.includes("/v1/sandboxes/sbx-1")) return response(body);
      if (url.endsWith("/v1/reconcile")) return response({ ok: true });
      return response({});
    },
  });
}

describe("Workbox external adapter", () => {
  it("projects provider gaps and accepts a ready sandbox plan", async () => {
    const adapter = createWorkboxExternalAdapter(providerFor());
    const context = { organizationId: "org-1" };
    const plan = await adapter.preflight(context, target);
    expect(plan.accepted).toBe(true);
    expect(plan.capability.unsupported.some((entry) => entry.capability === "idle-policy")).toBe(true);
  });

  it("creates a Workbox sandbox with the external operation identity", async () => {
    const adapter = createWorkboxExternalAdapter(providerFor({ id: "sbx-1", desired: "READY" }));
    const context = { organizationId: "org-1" };
    const plan = await adapter.plan(context, { target, idempotencyKey: "workbox-create-1" });
    const operation = await adapter.apply(context, { planId: plan.planId, idempotencyKey: "workbox-create-1", confirm: true }, plan);
    expect(operation).toMatchObject({ providerResourceId: "sbx-1", status: "ready", workloadKind: "workbox-sandbox" });
  });

  it("blocks host provisioning during preflight rather than after apply", async () => {
    const adapter = createWorkboxExternalAdapter(providerFor());
    const context = { organizationId: "org-1" };
    const hostTarget = { ...target, workloadKind: "workbox-host" as const };
    const plan = await adapter.preflight(context, hostTarget);
    expect(plan.accepted).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/cgroup v2/);
    expect(plan.capability.supported).not.toContain("apply");
    await expect(adapter.apply(context, { planId: plan.planId, idempotencyKey: "workbox-host-1", confirm: true }, plan)).rejects.toMatchObject({ code: "WORKBOX_HOST_PROVISIONING_UNSUPPORTED" });
  });

  it("maps form resource settings and environment into the actual Workbox create body", async () => {
    let sent: Record<string, unknown> = {};
    const provider = new WorkboxProvider({
      baseUrl: "https://workbox.example.test", apiKey: "wbk_test",
      request: async (url, options) => {
        if (options.method === "POST" && url.endsWith("/v1/sandboxes")) {
          sent = JSON.parse(options.body!);
          return response({ id: "sbx-1", desired: "READY", health: "HEALTHY" }, 201);
        }
        return response({ ok: true });
      },
    });
    const adapter = createWorkboxExternalAdapter(provider);
    const context = { organizationId: "org-1" };
    const input = {
      target: { ...target, resource: { ...target.resource, fromCheckpoint: "checkpoint-1", labels: '{"team":"agents"}', secretRefs: "gateway=API_KEY" } },
      workload: { memoryMB: "512", cpuMillis: "1000", networkMode: "allowlist", networkAllow: "example.com,api.example.com" },
      environment: { APP_ENV: "test" }, idempotencyKey: "workbox-input-1",
    };
    const plan = { ...await adapter.plan(context, input), workload: input.workload, environment: input.environment };
    await adapter.apply(context, { planId: plan.planId, idempotencyKey: input.idempotencyKey, confirm: true }, plan);
    expect(sent).toMatchObject({
      name: "agent-1", rootfs: "minimal", runtime: "node22", fromCheckpoint: "checkpoint-1",
      profile: { env: { APP_ENV: "test" }, limits: { memoryBytes: 536870912, cpuMillis: 1000 }, network: { mode: "allowlist", allow: ["example.com", "api.example.com"] } },
      labels: { team: "agents" }, secretRefs: ["gateway=API_KEY"],
    });
  });

  it("rejects invalid form settings at planning time", async () => {
    const adapter = createWorkboxExternalAdapter(providerFor());
    const context = { organizationId: "org-1" };
    await expect(adapter.plan(context, { target, image: "nginx:latest", idempotencyKey: "workbox-bad-image" })).rejects.toMatchObject({ code: "WORKBOX_IMAGE_UNSUPPORTED" });
    await expect(adapter.plan(context, { target, workload: { memoryMB: "invalid" }, idempotencyKey: "workbox-bad-memory" })).rejects.toMatchObject({ code: "WORKBOX_INPUT_INVALID" });
    await expect(adapter.plan(context, { target: { ...target, resource: { ...target.resource, profile: "{bad-json" } }, idempotencyKey: "workbox-bad-json" })).rejects.toMatchObject({ code: "WORKBOX_INPUT_INVALID" });
  });

  it("rejects environment and arbitrary objects inside public target profiles", async () => {
    const adapter = createWorkboxExternalAdapter(providerFor());
    const context = { organizationId: "org-1" };
    for (const profile of [
      { env: { API_KEY: "do-not-persist-in-target" } },
      { secretRefs: ["private-key"] },
      { limits: { memoryBytes: { secret: "hidden" } } },
      { network: { headers: { Authorization: "hidden" } } },
      { network: { allow: [{ token: "hidden" }] } },
    ]) {
      const unsafeTarget = { ...target, resource: { ...target.resource, profile: JSON.stringify(profile) } };
      await expect(adapter.preflight(context, unsafeTarget)).rejects.toMatchObject({ code: "WORKBOX_INPUT_INVALID" });
      await expect(adapter.plan(context, { target: unsafeTarget, idempotencyKey: "workbox-private-profile" })).rejects.toMatchObject({ code: "WORKBOX_INPUT_INVALID" });
    }
  });

  it("preserves quarantined and unhealthy outcomes instead of claiming readiness", async () => {
    for (const [body, expected] of [
      [{ id: "sbx-1", desired: "QUARANTINED", health: "ABSENT" }, "failed"],
      [{ id: "sbx-1", desired: "READY", health: "SUSPECT" }, "reconciling"],
    ] as const) {
      const adapter = createWorkboxExternalAdapter(providerFor(body));
      const context = { organizationId: "org-1" };
      const plan = await adapter.plan(context, { target, idempotencyKey: "workbox-health-1" });
      expect((await adapter.apply(context, { planId: plan.planId, idempotencyKey: "workbox-health-1", confirm: true }, plan)).status).toBe(expected);
    }
  });
});

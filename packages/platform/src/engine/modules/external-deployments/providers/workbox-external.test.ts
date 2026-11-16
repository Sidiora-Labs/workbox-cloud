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

  it("keeps Workbox hosts as an action-required deployment", async () => {
    const adapter = createWorkboxExternalAdapter(providerFor());
    const context = { organizationId: "org-1" };
    const hostTarget = { ...target, workloadKind: "workbox-host" as const };
    const plan = await adapter.preflight(context, hostTarget);
    const operation = await adapter.apply(context, { planId: plan.planId, idempotencyKey: "workbox-host-1", confirm: true }, plan);
    expect(operation.status).toBe("action_required");
    expect(operation.message).toMatch(/Deploy the Workbox host/);
  });
});

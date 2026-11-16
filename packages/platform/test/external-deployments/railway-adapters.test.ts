import { describe, expect, it, vi } from "vitest";
import {
  createRailwayServiceAdapter,
  normalizeRailwayServiceStatus,
} from "../../src/engine/modules/external-deployments/providers/railway-service";
import {
  createRailwaySandboxAdapter,
  normalizeRailwaySandboxStatus,
} from "../../src/engine/modules/external-deployments/providers/railway-sandbox";

describe("Railway service adapter", () => {
  it("keeps service deployments separate from sandbox resources", async () => {
    const transport = {
      patchEnvironment: vi.fn().mockResolvedValue({}),
      deployService: vi.fn().mockResolvedValue({ deploymentId: "dep-1" }),
      getDeployment: vi.fn().mockResolvedValue({ id: "dep-1", status: "SUCCESS", deploymentStopped: false }),
      getService: vi.fn().mockResolvedValue(null),
      stopDeployment: vi.fn().mockResolvedValue(true),
      redeploy: vi.fn().mockResolvedValue({ deploymentId: "dep-2" }),
    };
    const adapter = createRailwayServiceAdapter(transport);
    const result = await adapter.apply({
      target: { projectId: "p", environmentId: "e", serviceId: "s" },
      patch: { source: { image: "ghcr.io/example/app:1" } },
      idempotencyKey: "op-1",
    });
    expect(result).toMatchObject({ provider: "railway", workloadKind: "service", deploymentId: "dep-1", status: "ready" });
    expect(transport.deployService).toHaveBeenCalledWith({ serviceId: "s", environmentId: "e", idempotencyKey: "op-1" });
  });

  it("normalizes provider states", () => {
    expect(normalizeRailwayServiceStatus("BUILDING")).toBe("provisioning");
    expect(normalizeRailwayServiceStatus("CRASHED")).toBe("failed");
    expect(normalizeRailwayServiceStatus("SUCCESS")).toBe("ready");
  });
});

describe("Railway Sandbox adapter", () => {
  it("requires idempotency and preserves sandbox capabilities", async () => {
    const transport = {
      create: vi.fn().mockResolvedValue({ id: "sbx-1", status: "RUNNING", networkIsolation: "PRIVATE", idleTimeoutMinutes: 20 }),
      list: vi.fn(),
      get: vi.fn(),
      exec: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      checkpoint: vi.fn(),
      fork: vi.fn(),
    };
    const adapter = createRailwaySandboxAdapter(transport);
    await expect(adapter.create({ target: { projectId: "p", environmentId: "e" }, idempotencyKey: "op-1" })).resolves.toMatchObject({
      workloadKind: "railway-sandbox",
      status: "running",
      networkIsolation: "PRIVATE",
      idleTimeoutMinutes: 20,
    });
    expect(adapter.capabilities.supportsCheckpoints).toBe(true);
  });

  it("does not collapse sandbox lifecycle into service status", () => {
    expect(normalizeRailwaySandboxStatus("RUNNING")).toBe("running");
    expect(normalizeRailwaySandboxStatus("SUSPENDED")).toBe("stopped");
    expect(normalizeRailwaySandboxStatus("DELETED")).toBe("destroyed");
  });
});

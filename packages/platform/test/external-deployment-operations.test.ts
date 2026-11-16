import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialFindById: vi.fn(),
  targetFindByFingerprint: vi.fn(),
  targetFindById: vi.fn(),
  targetCreate: vi.fn(),
  targetUpdate: vi.fn(),
  operationFindById: vi.fn(),
  operationFindByIdempotency: vi.fn(),
  operationCreate: vi.fn(),
  operationUpdate: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    credential: { findById: mocks.credentialFindById },
    externalDeployment: {
      findTargetByFingerprint: mocks.targetFindByFingerprint,
      findTargetById: mocks.targetFindById,
      createTarget: mocks.targetCreate,
      updateTarget: mocks.targetUpdate,
      findOperationById: mocks.operationFindById,
      findOperationByIdempotency: mocks.operationFindByIdempotency,
      createOperation: mocks.operationCreate,
      updateOperation: mocks.operationUpdate,
    },
  },
}));

vi.mock("../src/engine/modules/credentials/credential.service", () => ({
  readCredentialSecrets: () => ({ apiToken: "redacted-test-secret" }),
}));

import { createExternalDeploymentDependencies } from "../src/engine/modules/external-deployments/external.operations";
import { ExternalProviderRegistry, type ExternalProviderAdapter } from "../src/external-deployments";

const context = {
  organizationId: "org_1",
  userId: "user_1",
  traceId: "trace_1",
} as never;

const target = {
  id: "target_1",
  organizationId: "org_1",
  credentialId: "cred_1",
  provider: "railway",
  workloadKind: "railway-sandbox",
  providerIdentity: { workspaceId: "workspace_1" },
  resource: { projectId: "project_1", environmentId: "env_1" },
  fingerprint: "fp",
  displayName: "Sandbox",
  capabilities: null,
  status: "active",
  lastPreflightAt: null,
  lastError: null,
  createdAt: new Date("2026-11-16T12:00:00.000Z"),
  updatedAt: new Date("2026-11-16T12:00:00.000Z"),
};

function reset() {
  vi.clearAllMocks();
  mocks.credentialFindById.mockResolvedValue({
    id: "cred_1",
    organizationId: "org_1",
    provider: "railway",
    status: "active",
    selector: null,
    publicFields: {},
    secretsEnc: "enc1:test",
  });
  mocks.targetFindByFingerprint.mockResolvedValue(target);
  mocks.targetFindById.mockResolvedValue(target);
  mocks.targetUpdate.mockResolvedValue(target);
}

describe("external deployment operations", () => {
  it("returns explicit capability blockers when no provider adapter is configured", async () => {
    reset();
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    const result = await deps.collection.preflight(context, {
      provider: "railway",
      workloadKind: "railway-sandbox",
      connectionId: "cred_1",
      providerIdentity: { workspaceId: "workspace_1" },
      resource: { projectId: "project_1", environmentId: "env_1" },
    });
    expect(result.accepted).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/adapter is not configured/i);
    expect(mocks.targetUpdate).toHaveBeenCalledWith("org_1", "target_1", expect.objectContaining({ status: "blocked" }));
  });

  it("persists an idempotent unsupported apply result instead of returning an unavailable operation", async () => {
    reset();
    const planRow = {
      id: "plan_1",
      organizationId: "org_1",
      targetId: "target_1",
      operation: "plan",
      workloadKind: "railway-sandbox",
      idempotencyKey: "plan:railway:0001",
      status: "unsupported",
      request: { target: { provider: "railway", workloadKind: "railway-sandbox", connectionId: "cred_1", providerIdentity: {}, resource: {} } },
      providerRequestId: null,
      providerResourceId: null,
      providerStatus: null,
      observed: null,
      errorCode: "EXTERNAL_CAPABILITY_UNSUPPORTED",
      errorMessage: "adapter missing",
      createdAt: new Date("2026-11-16T12:00:00.000Z"),
      updatedAt: new Date("2026-11-16T12:00:00.000Z"),
      finishedAt: new Date("2026-11-16T12:00:00.000Z"),
    };
    const applyRow = { ...planRow, id: "apply_1", operation: "apply", idempotencyKey: "apply:railway:0001", status: "unsupported", errorCode: "EXTERNAL_PROVIDER_UNAVAILABLE", errorMessage: "The provider adapter is not configured on this control plane." };
    mocks.operationFindById.mockResolvedValue(planRow);
    mocks.operationFindByIdempotency.mockResolvedValue(undefined);
    mocks.operationCreate.mockResolvedValue(applyRow);
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    const result = await deps.collection.apply(context, { planId: "plan_1", idempotencyKey: "apply:railway:0001", confirm: true });
    expect(result.status).toBe("unsupported");
    expect(result.errorCode).toBe("EXTERNAL_PROVIDER_UNAVAILABLE");
    expect(mocks.operationCreate).toHaveBeenCalledWith(expect.objectContaining({ operation: "apply", status: "unsupported" }));
  });

  it("keeps optional provider gaps as plan warnings instead of blocking creation", async () => {
    reset();
    mocks.operationFindByIdempotency.mockResolvedValue(undefined);
    mocks.operationCreate.mockResolvedValue({
      id: "plan_2",
      targetId: "target_1",
      operation: "plan",
      workloadKind: "railway-sandbox",
      status: "queued",
      request: {},
    });
    const adapter: ExternalProviderAdapter = {
      provider: "railway",
      workloads: ["railway-sandbox"],
      capabilities: async () => ({
        provider: "railway",
        workloadKind: "railway-sandbox",
        checkedAt: "2026-11-16T12:00:00.000Z",
        supported: ["discover", "preflight", "apply", "observe", "destroy"],
        unsupported: [{ capability: "exec", reason: "SDK transport is not configured" }],
        limits: {},
        observedIdentity: {},
      }),
      preflight: async () => { throw new Error("not used"); },
      plan: async () => { throw new Error("not used"); },
      apply: async () => { throw new Error("not used"); },
      observe: async () => { throw new Error("not used"); },
    };
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry([adapter]));
    const result = await deps.collection.plan(context, {
      target: {
        provider: "railway",
        workloadKind: "railway-sandbox",
        connectionId: "cred_1",
        providerIdentity: { workspaceId: "workspace_1" },
        resource: { projectId: "project_1", environmentId: "env_1" },
      },
      idempotencyKey: "plan:railway:0002",
    });
    expect(result.accepted).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/SDK transport/);
  });
});

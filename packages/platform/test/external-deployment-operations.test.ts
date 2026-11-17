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
  operationList: vi.fn(),
  targetList: vi.fn(),
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
      updateObservation: (_org: string, _id: string, _date: Date, _operation: string, patch: unknown) => mocks.operationUpdate(_org, _id, patch),
      listOperations: mocks.operationList,
      listTargets: mocks.targetList,
    },
  },
}));

vi.mock("../src/engine/modules/credentials/credential.service", () => ({
  readCredentialSecrets: () => ({ apiToken: "redacted-test-secret" }),
}));

import { createExternalDeploymentDependencies } from "../src/engine/modules/external-deployments/external.operations";
import { ExternalProviderRegistry, type ExternalProviderAdapter } from "../src/external-deployments";
import { decryptSecretField } from "../src/engine/lib/credential-encryption";

const inputTarget = { provider: "railway", workloadKind: "railway-sandbox", connectionId: "cred_1", providerIdentity: { workspaceId: "workspace_1" }, resource: { projectId: "project_1", environmentId: "env_1" } } as const;

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
  vi.resetAllMocks();
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

function checkedPlan() {
  return { planId: "provider_plan", target: { ...inputTarget, targetId: "target_1", organizationId: "org_1", capturedAt: new Date().toISOString() }, capability: { provider: "railway" as const, workloadKind: "railway-sandbox" as const, checkedAt: new Date().toISOString(), supported: ["preflight", "apply", "observe"] as Array<"preflight" | "apply" | "observe">, unsupported: [{ capability: "exec" as const, reason: "SDK transport is not configured" }], limits: {}, observedIdentity: {} }, accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now() + 900_000).toISOString() };
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

  it("rejects a blocked plan before a provider mutation", async () => {
    reset();
    mocks.operationFindById.mockResolvedValue({ id: "plan_1", targetId: "target_1", operation: "plan", status: "unsupported", request: { target: inputTarget }, createdAt: new Date() });
    mocks.operationFindByIdempotency.mockResolvedValue(undefined);
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    await expect(deps.collection.apply(context, { planId: "plan_1", idempotencyKey: "apply:railway:0001", confirm: true })).rejects.toMatchObject({ code: "EXTERNAL_PLAN_BLOCKED" });
    expect(mocks.operationCreate).not.toHaveBeenCalled();
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
      preflight: async () => checkedPlan(),
      plan: async () => checkedPlan(),
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

  it("runs provider preflight and plan with the requested source", async () => {
    reset();
    const preflight = vi.fn(async () => checkedPlan());
    const plan = vi.fn(async () => checkedPlan());
    const adapter = { provider: "railway", workloads: ["railway-sandbox"], capabilities: async () => checkedPlan().capability, preflight, plan, apply: vi.fn(), observe: vi.fn() } as ExternalProviderAdapter;
    mocks.operationCreate.mockResolvedValue({ id: "plan_3" });
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry([adapter]));
    const input = { target: inputTarget, image: "example/test:latest", environment: { CONFIG: "value" }, idempotencyKey: "plan:railway:0003" };
    expect((await deps.collection.plan(context, input)).accepted).toBe(true);
    expect(preflight).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledWith(expect.anything(), input);
    const savedRequest = mocks.operationCreate.mock.calls[0][0].request;
    expect(savedRequest).not.toHaveProperty("environment");
    expect(savedRequest.environmentEnc).toMatch(/^enc1:/);
    expect(JSON.parse(decryptSecretField(savedRequest.environmentEnc)!)).toEqual(input.environment);
  });

  it("rejects an expired plan before creating an apply operation", async () => {
    reset();
    mocks.operationFindById.mockResolvedValue({ id: "plan_1", targetId: "target_1", operation: "plan", status: "queued", request: { target: inputTarget, accepted: true, expiresAt: new Date(0).toISOString() }, createdAt: new Date() });
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    await expect(deps.collection.apply(context, { planId: "plan_1", idempotencyKey: "apply:railway:0001", confirm: true })).rejects.toMatchObject({ code: "EXTERNAL_PLAN_EXPIRED" });
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("rejects revoked credentials before applying a reviewed plan", async () => {
    reset();
    mocks.operationFindById.mockResolvedValue({ id: "plan_1", targetId: "target_1", operation: "plan", status: "queued", request: { target: inputTarget, accepted: true, expiresAt: checkedPlan().expiresAt }, createdAt: new Date() });
    mocks.credentialFindById.mockResolvedValue({ provider: "railway", status: "invalid" });
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    await expect(deps.collection.apply(context, { planId: "plan_1", idempotencyKey: "apply:railway:0001", confirm: true })).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("uses the created resource identity when observing an operation", async () => {
    reset();
    const observedRow = { id: "apply_1", organizationId: "org_1", targetId: "target_1", operation: "apply", workloadKind: "railway-sandbox", idempotencyKey: "apply:railway:0001", status: "provisioning", request: { target: inputTarget }, providerResourceId: "sandbox_new", createdAt: new Date(), updatedAt: new Date() };
    mocks.operationFindById.mockResolvedValue(observedRow);
    mocks.operationUpdate.mockResolvedValue({ ...observedRow, status: "ready" });
    const observe = vi.fn(async () => ({ ...observedRow, status: "ready", target: checkedPlan().target }));
    const adapter = { provider: "railway", workloads: ["railway-sandbox"], capabilities: vi.fn(), preflight: vi.fn(), plan: vi.fn(), apply: vi.fn(), observe } as unknown as ExternalProviderAdapter;
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry([adapter]));
    const result = await deps.collection.observe(context, { target: inputTarget, operationId: "apply_1" });
    expect(observe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ target: expect.objectContaining({ resource: expect.objectContaining({ sandboxId: "sandbox_new" }) }) }));
    expect(result.target.resource.sandboxId).toBe("sandbox_new");
    expect(mocks.targetFindByFingerprint).not.toHaveBeenCalled();
  });

  it("lists organization-scoped operations without returning saved source or environment", async () => {
    reset();
    mocks.targetList.mockResolvedValue([target]);
    mocks.operationList.mockResolvedValue([{ id: "apply_1", organizationId: "org_1", targetId: "target_1", operation: "apply", workloadKind: "railway-sandbox", idempotencyKey: "apply:railway:0001", status: "ready", request: { target: inputTarget, environment: { SECRET: "never-return" } }, providerResourceId: "sandbox_new", createdAt: new Date(), updatedAt: new Date() }]);
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    const result = await deps.collection.operations(context, { targetId: "target_1", limit: 20 });
    expect(mocks.operationList).toHaveBeenCalledWith("org_1", "target_1", 20);
    expect(result[0].target.resource.sandboxId).toBe("sandbox_new");
    expect(JSON.stringify(result)).not.toContain("never-return");
  });
  it("keeps environment values encrypted at rest and decrypts only for apply", async () => {
    reset();
    const draft = checkedPlan();
    const adapter = { provider: "railway", workloads: ["railway-sandbox"], capabilities: async () => draft.capability, preflight: async () => draft, plan: async () => draft, apply: vi.fn(async () => ({ status: "ready", target: draft.target, providerResourceId: "sandbox_new" })), observe: vi.fn() } as unknown as ExternalProviderAdapter;
    mocks.operationCreate.mockImplementation(async (value) => ({ ...value, id: "op_new", createdAt: new Date(), updatedAt: new Date() }));
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry([adapter]));
    await deps.collection.plan(context, { target: inputTarget, environment: { SECRET: "plain-runtime-value" }, idempotencyKey: "plan:railway:0033" });
    const persistedPlan = await mocks.operationCreate.mock.results[0].value;
    mocks.operationFindById.mockResolvedValue(persistedPlan);
    mocks.operationUpdate.mockImplementation(async (_org, _id, patch) => ({ id: "op_new", organizationId: "org_1", targetId: target.id, operation: "apply", workloadKind: target.workloadKind, request: persistedPlan.request, idempotencyKey: "apply:railway:0033", createdAt: new Date(), updatedAt: new Date(), ...patch }));
    const result = await deps.collection.apply(context, { planId: "op_new", idempotencyKey: "apply:railway:0033", confirm: true });
    expect(adapter.apply).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ environment: { SECRET: "plain-runtime-value" } }));
    expect(JSON.stringify(mocks.operationCreate.mock.calls)).not.toContain("plain-runtime-value");
    expect(result.target.capability?.supported).toContain("apply");
  });

  it("rejects secret-bearing target selectors", async () => {
    reset();
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    await expect(deps.collection.plan(context, { target: { ...inputTarget, resource: { ...inputTarget.resource, environment: '{"TOKEN":"secret"}' } }, idempotencyKey: "plan:railway:0044" })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.targetCreate).not.toHaveBeenCalled();
  });

  it("persists deletion and rejects subsequent exec or observe", async () => {
    reset();
    const destroyed = { id: "apply_1", organizationId: "org_1", targetId: "target_1", operation: "destroy", workloadKind: "railway-sandbox", idempotencyKey: "apply:railway:0001", status: "stopped", request: { target: inputTarget }, providerResourceId: "sandbox_new", createdAt: new Date(), updatedAt: new Date() };
    const active = { ...destroyed, operation: "apply", status: "ready" };
    mocks.operationFindById.mockResolvedValue(active);
    mocks.operationUpdate.mockResolvedValue(destroyed);
    const destroy = vi.fn(async () => ({ ...destroyed, target: checkedPlan().target }));
    const adapter = { provider: "railway", workloads: ["railway-sandbox"], destroy } as unknown as ExternalProviderAdapter;
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry([adapter]));
    expect((await deps.collection.destroy(context, { operationId: "apply_1", confirm: true })).kind).toBe("destroy");
    expect(mocks.operationUpdate).toHaveBeenCalledWith("org_1", "apply_1", expect.objectContaining({ operation: "destroy" }));
    mocks.operationFindById.mockResolvedValue(destroyed);
    await expect(deps.collection.exec(context, { operationId: "apply_1", argv: ["true"] })).rejects.toMatchObject({ code: "EXTERNAL_WORKLOAD_DELETED" });
    await expect(deps.collection.observe(context, { operationId: "apply_1", target: inputTarget })).rejects.toMatchObject({ code: "EXTERNAL_WORKLOAD_DELETED" });
  });

  it("rejects nested environment in profile selectors", async () => {
    reset();
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    await expect(deps.collection.plan(context, { target: { ...inputTarget, resource: { ...inputTarget.resource, profile: '{"memory":512,"env":{"TOKEN":"secret"}}' } }, idempotencyKey: "plan:railway:0045" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects changed configuration using an existing plan idempotency key", async () => {
    reset();
    const draft = checkedPlan();
    const provider = { provider: "railway", workloads: ["railway-sandbox"], preflight: async () => draft, plan: async () => draft } as unknown as ExternalProviderAdapter;
    mocks.operationCreate.mockImplementation(async (value) => ({ ...value, id: "plan_1", createdAt: new Date() }));
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry([provider]));
    await deps.collection.plan(context, { target: inputTarget, image: "image:one", idempotencyKey: "plan:railway:0046" });
    mocks.operationFindByIdempotency.mockResolvedValue(await mocks.operationCreate.mock.results[0].value);
    await expect(deps.collection.plan(context, { target: inputTarget, image: "image:two", idempotencyKey: "plan:railway:0046" })).rejects.toMatchObject({ code: "EXTERNAL_IDEMPOTENCY_CONFLICT" });
  });

  it("reports expired apply workers as reconciling without reapplying", async () => {
    reset();
    mocks.targetList.mockResolvedValue([target]);
    mocks.operationList.mockResolvedValue([{ id: "apply_1", organizationId: "org_1", targetId: "target_1", operation: "apply", workloadKind: "railway-sandbox", idempotencyKey: "apply:railway:0001", status: "provisioning", request: { target: inputTarget }, providerResourceId: null, leaseOwner: "lost-worker", leaseUntil: new Date(0), createdAt: new Date(), updatedAt: new Date() }]);
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry());
    const result = await deps.collection.operations(context, {});
    expect(result[0].status).toBe("reconciling");
    expect(result[0].message).toMatch(/worker stopped/);
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("persists delete intent before a provider timeout and retains its resource", async () => {
    reset();
    const active = { id: "apply_1", organizationId: "org_1", targetId: "target_1", operation: "apply", workloadKind: "railway-sandbox", idempotencyKey: "apply:railway:0001", status: "ready", request: { target: inputTarget }, providerResourceId: "sandbox_new", createdAt: new Date(), updatedAt: new Date() };
    mocks.operationFindById.mockResolvedValue(active);
    mocks.operationUpdate.mockImplementation(async (_org, _id, patch) => ({ ...active, ...patch }));
    const destroy = vi.fn(async () => {
      expect(mocks.operationUpdate).toHaveBeenCalledWith("org_1", "apply_1", expect.objectContaining({ operation: "destroy", status: "stopping" }));
      throw new Error("request timed out");
    });
    const adapter = { provider: "railway", workloads: ["railway-sandbox"], destroy } as unknown as ExternalProviderAdapter;
    const deps = createExternalDeploymentDependencies(new ExternalProviderRegistry([adapter]));
    const result = await deps.collection.destroy(context, { operationId: "apply_1", confirm: true });
    expect(result).toMatchObject({ kind: "destroy", status: "reconciling", providerResourceId: "sandbox_new" });
  });

});

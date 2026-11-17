import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalTargetInput } from "@repo/contracts";
import { railwayQuery } from "../../src/engine/modules/credentials/provider-api";
import { createRailwayExternalAdapter, graphqlSandboxTransport, railwayConfigPatch } from "../../src/engine/modules/external-deployments/providers/railway-external";

vi.mock("../../src/engine/modules/credentials/provider-api", () => ({ railwayQuery: vi.fn() }));
const query = vi.mocked(railwayQuery);
const access = { provider: "railway" as const, publicFields: {}, secrets: { apiToken: "test-secret" } };
const context = { organizationId: "org-1" };
const target: ExternalTargetInput = { provider: "railway", workloadKind: "railway-sandbox", connectionId: "cred-1", providerIdentity: {}, resource: { projectId: "p-1", environmentId: "e-1", name: "workspace" } };
const adapter = () => createRailwayExternalAdapter(async () => ({ publicFields: {}, secrets: access.secrets }));
beforeEach(() => { query.mockReset(); });

describe("Railway native sandbox protocol", () => {
  it("sends only documented create fields and scoped read/destroy operations", async () => {
    query.mockResolvedValueOnce({ sandboxCreate: { id: "sbx-1", status: "CREATING" } });
    const transport = graphqlSandboxTransport(access, "e-1");
    await transport.create({ target: { projectId: "p-1", environmentId: "e-1" }, name: "local-label", env: { TEST: "one" }, domains: [{ port: 3000 }], networkIsolation: "PRIVATE", idempotencyKey: "workbox-0001" });
    expect(query.mock.calls[0]![2]).toEqual({ input: { environmentId: "e-1", networkIsolation: "PRIVATE", variables: { TEST: "one" }, publicDomains: [{ port: 3000 }] } });
    expect(query.mock.calls[0]![1]).not.toMatch(/projectId|checkpointId|updatedAt|\bstate\b/);
    query.mockResolvedValueOnce({ sandbox: { id: "sbx-1" } });
    await transport.get({ projectId: "p-1", environmentId: "e-1", sandboxId: "sbx-1" });
    expect(query.mock.calls[1]![1]).toContain("environmentId: $environment");
    query.mockResolvedValueOnce({ sandboxDestroy: { id: "sbx-1" } });
    await transport.destroy("sbx-1");
    expect(query.mock.calls[2]![1]).toContain("sandboxDestroy(id: $id, environmentId: $environment)");
  });

  it("quotes exec arguments and cwd instead of concatenating executable input", async () => {
    query.mockResolvedValue({ sandboxExec: { stdout: "hello", stderr: "", exitCode: 0 } });
    const transport = graphqlSandboxTransport(access, "e-1");
    await transport.exec({ sandboxId: "sbx-1", command: ["printf", "a'b;$(unsafe)"], cwd: "/a b" });
    expect(query.mock.calls[0]![2]).toEqual({ id: "sbx-1", environment: "e-1", timeout: 30, command: "cd '/a b' && 'printf' 'a'\\''b;$(unsafe)'" });
  });

  it("reads the paginated connection nodes rather than assuming a flat list", async () => {
    query.mockResolvedValue({ sandboxes: { edges: [{ node: { id: "sbx-1" } }] } });
    await expect(graphqlSandboxTransport(access, "e-1").list({ projectId: "p-1", environmentId: "e-1" })).resolves.toEqual([{ id: "sbx-1" }]);
  });
});

describe("Railway launch planning and service configuration", () => {
  it("rejects public sandbox ports with isolated networking before creating anything", async () => {
    query.mockResolvedValue({ environment: { id: "e-1", projectId: "p-1", unmergedChangesCount: 0, serviceInstances: { edges: [] } } });
    const result = await adapter().plan(context, { target: { ...target, resource: { ...target.resource, ports: "3000", networkIsolation: "ISOLATED" } }, idempotencyKey: "workbox-0001" });
    expect(result.accepted).toBe(false);
    expect(result.blockers).toContain("Public sandbox ports require Private networking.");
    expect(query.mock.calls.every(([, text]) => !text.includes("mutation"))).toBe(true);
  });

  it("permits a new named service while rejecting unknown selected services", async () => {
    query.mockResolvedValue({ environment: { id: "e-1", projectId: "p-1", unmergedChangesCount: 0, serviceInstances: { edges: [] } } });
    const serviceTarget = { ...target, workloadKind: "service" as const };
    const input = { target: serviceTarget, image: "nginx:alpine", idempotencyKey: "workbox-0001" };
    expect((await adapter().plan(context, input)).accepted).toBe(true);
    expect((await adapter().plan(context, { ...input, target: { ...serviceTarget, resource: { ...serviceTarget.resource, serviceId: "foreign" } } })).accepted).toBe(false);
  });

  it("rejects a project outside the credential workspace", async () => {
    query.mockResolvedValue({ project: { workspaceId: "another-workspace" }, environment: { id: "e-1", projectId: "p-1", unmergedChangesCount: 0, serviceInstances: { edges: [] } } });
    const scoped = createRailwayExternalAdapter(async () => ({ publicFields: { workspaceId: "expected-workspace" }, secrets: access.secrets }));
    expect((await scoped.preflight(context, target)).accepted).toBe(false);
  });

  it("retains a created service when the configuration response is lost", async () => {
    query.mockImplementation(async (_access, document) => {
      if (document.includes("environment(id:")) return { environment: { id: "e-1", projectId: "p-1", unmergedChangesCount: 0, serviceInstances: { edges: [] } } } as never;
      if (document.includes("serviceCreate")) return { serviceCreate: { id: "svc-partial" } } as never;
      throw new Error("network interrupted");
    });
    const service = adapter();
    const serviceTarget = { ...target, workloadKind: "service" as const };
    const plan = { ...(await service.plan(context, { target: serviceTarget, image: "nginx:alpine", idempotencyKey: "workbox-0001" })), image: "nginx:alpine" };
    const result = await service.apply(context, { planId: plan.planId, confirm: true, idempotencyKey: "workbox-0001" }, plan);
    expect(result.status).toBe("action_required");
    expect(result.target.resource.serviceId).toBe("svc-partial");
  });

  it("observes a partially created service without inventing a deployment id", async () => {
    query.mockResolvedValue({ environment: { serviceInstances: { edges: [{ node: { id: "instance-1", serviceId: "svc-partial", activeDeployments: [] } }] } } });
    const result = await adapter().observe(context, { target: { ...target, workloadKind: "service", resource: { ...target.resource, serviceId: "svc-partial" } } });
    expect(result.status).toBe("action_required");
    expect(query.mock.calls).toHaveLength(1);
    expect(query.mock.calls[0]![1]).not.toContain("deployment(id:");
  });

  it("serializes the provider EnvironmentConfig shape", () => {
    expect(railwayConfigPatch({ source: { image: "nginx:alpine", dockerfilePath: "Dockerfile" }, startCommand: "run", buildCommand: "build", variables: { PORT: "3000" } })).toEqual({ source: { image: "nginx:alpine", repo: null }, build: { dockerfilePath: "Dockerfile", buildCommand: "build" }, deploy: { startCommand: "run" }, variables: { PORT: { value: "3000" } } });
  });

  it("creates a service, patches configuration, and returns the bound service identity", async () => {
    query.mockImplementation(async (_access, document) => {
      if (document.includes("environment(id:")) return { environment: { id: "e-1", projectId: "p-1", unmergedChangesCount: 0, serviceInstances: { edges: [] } } } as never;
      if (document.includes("serviceCreate")) return { serviceCreate: { id: "svc-new" } } as never;
      if (document.includes("environmentPatchCommit")) return { environmentPatchCommit: "commit-1" } as never;
      if (document.includes("serviceInstanceDeployV2")) return { serviceInstanceDeployV2: "dep-new" } as never;
      if (document.includes("deployment(id:")) return { deployment: { id: "dep-new", status: "DEPLOYING" } } as never;
      throw new Error("Unexpected provider operation");
    });
    const service = adapter();
    const serviceTarget = { ...target, workloadKind: "service" as const };
    const plan = { ...(await service.plan(context, { target: serviceTarget, image: "nginx:alpine", idempotencyKey: "workbox-0001" })), image: "nginx:alpine", environment: { PORT: "3000" } };
    const result = await service.apply(context, { planId: plan.planId, confirm: true, idempotencyKey: "workbox-0001" }, plan);
    expect(result.target.resource).toMatchObject({ serviceId: "svc-new", deploymentId: "dep-new" });
    expect(result.providerResourceId).toBe("dep-new");
    const patchCall = query.mock.calls.find(([, document]) => document.includes("environmentPatchCommit"))!;
    expect(patchCall[1]).not.toContain("{ id }");
    expect(patchCall[2]).toMatchObject({ patch: { services: { "svc-new": { source: { image: "nginx:alpine", repo: null }, variables: { PORT: { value: "3000" } } } } } });
  });
});

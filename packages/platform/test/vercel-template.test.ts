import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalPlan, ExternalPlanInput, ExternalTargetInput } from "@repo/contracts";
import { createVercelTemplateAdapter } from "../src/engine/modules/external-deployments/providers/vercel-template";
import { createVercelApiClient } from "../src/engine/modules/external-deployments/providers/vercel";
import { safeFetch } from "../src/engine/lib/safe-fetch";

vi.mock("../src/engine/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
const ctx = { organizationId: "org-one" };
const target: ExternalTargetInput = { provider: "vercel", workloadKind: "service", connectionId: "credential-one", providerIdentity: { teamId: "team-one" }, resource: { name: "catalog-site", createProject: "true", appTemplateId: "vercel-blog", appRecipeId: "vercel" } };
const source = { repo: "vercel/next.js", ref: "a".repeat(40), rootDirectory: "examples/blog-starter", framework: "nextjs" };
const resolver = async () => ({ id: "credential-one", publicFields: { accountId: "account-one", teamId: "team-one" }, secrets: { apiToken: "secret-token" } });
const request = vi.fn();
const adapter = () => createVercelTemplateAdapter(resolver, { signingKey: "instance-secret", client: () => ({ request }) });
const plan = async (): Promise<ExternalPlan> => ({ planId: "plan-one", target: { ...target, targetId: "target-one", organizationId: ctx.organizationId, capturedAt: new Date().toISOString() }, capability: await adapter().capabilities(ctx, target), accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now() + 60_000).toISOString(), source, environment: { CUSTOM_SECRET: "secret-value" } } as ExternalPlan);
const apply = async () => adapter().apply(ctx, { planId: "plan-one", idempotencyKey: "apply:catalog-one", confirm: true }, await plan());
beforeEach(() => { request.mockReset(); vi.mocked(safeFetch).mockReset(); });

describe("Vercel catalog lifecycle", () => {
  it("rejects existing project names without adopting or mutating the project", async () => {
    request.mockResolvedValue({ id: "old-project", name: "catalog-site" });
    const result = await adapter().plan(ctx, { target, source, idempotencyKey: "plan:catalog-one" });
    expect(result.accepted).toBe(false);
    expect(result.blockers.join(" ")).toContain("already exists");
    await expect(apply()).rejects.toMatchObject({ code: "EXTERNAL_TARGET_CONFLICT" });
    expect(request.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });

  it("creates a scoped project with encrypted env, deploys the pinned repository, and retains signed ownership", async () => {
    request.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockResolvedValueOnce({ id: "dpl-created", projectId: "prj-created", readyState: "QUEUED", url: "catalog-site.vercel.app" });
    const result = await apply();
    expect(request).toHaveBeenNthCalledWith(2, "/v11/projects", { method: "POST", body: { name: "catalog-site", framework: "nextjs", rootDirectory: "examples/blog-starter", environmentVariables: [{ key: "CUSTOM_SECRET", value: "secret-value", type: "encrypted", target: ["production", "preview", "development"] }] } });
    expect(request).toHaveBeenNthCalledWith(3, "/v13/deployments", { method: "POST", body: expect.objectContaining({ project: "prj-created", target: "production", gitSource: { type: "github", org: "vercel", repo: "next.js", ref: source.ref, sha: source.ref } }) });
    expect(result).toMatchObject({ providerResourceId: "dpl-created", status: "provisioning", target: { resource: { projectId: "prj-created", deploymentConfirmed: "true", url: "https://catalog-site.vercel.app" } } });
    expect(result.target.resource.managedProjectProof).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("preserves created-project ownership when deployment fails so deletion remains possible", async () => {
    request.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockRejectedValueOnce(new Error("provider echoed secret-value"));
    const result = await apply();
    expect(result).toMatchObject({ providerResourceId: "prj-created", status: "action_required", errorCode: "EXTERNAL_DEPLOYMENT_UNCONFIRMED", target: { resource: { projectId: "prj-created", deploymentConfirmed: "false" } } });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    request.mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockResolvedValueOnce(null);
    expect(await adapter().destroy!(ctx, result)).toMatchObject({ status: "stopped", providerStatus: "DELETED" });
    expect(request).toHaveBeenLastCalledWith("/v9/projects/prj-created", { method: "DELETE" });
  });

  it("refuses fabricated ownership and cross-tenant replay before provider calls", async () => {
    const fabricated = { ...(await plan()).target, resource: { ...target.resource, projectId: "victim", managedProjectName: "catalog-site", managedProjectProof: "0".repeat(64) } };
    await expect(adapter().observe(ctx, { target: fabricated })).rejects.toMatchObject({ code: "EXTERNAL_PROJECT_NOT_OWNED" });
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockResolvedValueOnce({ id: "dpl-created", readyState: "READY" });
    const created = await apply();
    request.mockReset();
    await expect(adapter().destroy!({ organizationId: "other-org" }, created)).rejects.toMatchObject({ code: "EXTERNAL_PROJECT_NOT_OWNED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses provider identity overrides and unpinned template sources", async () => {
    await expect(adapter().preflight(ctx, { ...target, providerIdentity: { teamId: "other-team" } })).rejects.toMatchObject({ code: "EXTERNAL_TARGET_SCOPE_DENIED" });
    request.mockResolvedValueOnce(null);
    await expect(adapter().plan(ctx, { target, source: { ...source, ref: "main" }, idempotencyKey: "plan:catalog-one" })).rejects.toMatchObject({ code: "CATALOG_SOURCE_INVALID" });
  });

  it("observes and reads bounded events only for the signed project and deployment", async () => {
    request.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockResolvedValueOnce({ id: "dpl-created", projectId: "prj-created", readyState: "QUEUED" });
    const created = await apply();
    request.mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockResolvedValueOnce({ id: "dpl-created", projectId: "prj-created", readyState: "READY", url: "catalog-site.vercel.app" });
    expect(await adapter().observe(ctx, { target: created.target })).toMatchObject({ status: "ready" });
    request.mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockResolvedValueOnce({ id: "dpl-created", projectId: "prj-created", readyState: "READY" }).mockResolvedValueOnce([{ id: "line-one", created: 1700000000000, type: "stdout", payload: { text: "Build completed" } }]);
    const logs = [];
    for await (const entry of adapter().logs!(ctx, created)) logs.push(entry);
    expect(logs).toEqual([{ cursor: "line-one", timestamp: "2023-11-14T22:13:20.000Z", stream: "stdout", message: "Build completed" }]);
  });

  it("refuses a deployment without matching provider-reported project ownership", async () => {
    request.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockResolvedValueOnce({ id: "dpl-created", projectId: "prj-created", readyState: "READY" });
    const created = await apply();
    request.mockResolvedValueOnce({ id: "prj-created", name: "catalog-site" }).mockResolvedValueOnce({ id: "dpl-other", projectId: "prj-other", readyState: "READY" });
    await expect(adapter().observe(ctx, { target: { ...created.target, resource: { ...created.target.resource, deploymentId: "dpl-other" } } })).rejects.toMatchObject({ code: "EXTERNAL_TARGET_SCOPE_DENIED" });
  });
});

describe("Vercel template HTTP semantics", () => {
  it("treats optional GET 404 as absent and DELETE 204 as successful without parsing JSON", async () => {
    const missingJson = vi.fn();
    vi.mocked(safeFetch).mockResolvedValueOnce({ ok: false, status: 404, json: missingJson } as never).mockResolvedValueOnce({ ok: true, status: 204, json: missingJson } as never);
    const client = createVercelApiClient({ connectionId: "one", accountId: "account-one", teamId: "team-one" }, "token");
    expect(await client.request("/v9/projects/missing", { allowMissing: true })).toBeNull();
    expect(await client.request("/v9/projects/owned", { method: "DELETE" })).toBeNull();
    expect(missingJson).not.toHaveBeenCalled();
    expect(safeFetch).toHaveBeenCalledWith("https://api.vercel.com/v9/projects/owned?teamId=team-one", expect.objectContaining({ method: "DELETE" }));
  });
});

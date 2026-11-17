import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalOperation, ExternalTargetInput } from "@repo/contracts";
import { createBuiltinExternalProviderRegistry } from "../src/engine/modules/external-deployments/builtin-registry";
import { safeFetch } from "../src/engine/lib/safe-fetch";
import { Sandbox } from "@vercel/sandbox";

vi.mock("../src/engine/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: vi.fn(), create: vi.fn(), getOrCreate: vi.fn() } }));
const context = { organizationId: "org-control" };
const registry = () => createBuiltinExternalProviderRegistry(async () => ({ id: "c1", publicFields: { accountId: "account", teamId: "team", organizationId: "fly-org" }, secrets: { apiToken: "token", spriteToken: "sprite-token" } }));
const target = (provider: "fly" | "vercel", workloadKind: ExternalTargetInput["workloadKind"], resource: Record<string, string>): ExternalTargetInput => ({ provider, workloadKind, connectionId: "c1", providerIdentity: {}, resource });
const snapshot = (input: ExternalTargetInput) => ({ ...input, targetId: "target1", organizationId: "org-control", capturedAt: new Date().toISOString() });
const operation = (input: ExternalTargetInput): ExternalOperation => ({ id: "operation1", organizationId: "org-control", targetId: "target1", kind: "apply", workloadKind: input.workloadKind, status: "running", idempotencyKey: "apply:0001", target: snapshot(input), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as never;
beforeEach(() => { vi.mocked(safeFetch).mockReset(); vi.mocked(Sandbox.get).mockReset(); vi.mocked(Sandbox.create).mockReset(); vi.mocked(Sandbox.getOrCreate).mockReset(); });

describe("provider execution integration", () => {
  it("rejects caller identity overrides of the selected connection", async () => {
    const fly = target("fly", "fly-machine", { appName: "demo" });
    await expect(registry().get("fly").preflight(context, { ...fly, providerIdentity: { organizationId: "other-org" } })).rejects.toMatchObject({ code: "EXTERNAL_TARGET_SCOPE_DENIED" });
    const vercel = target("vercel", "service", { projectId: "prj1" });
    await expect(registry().get("vercel").preflight(context, { ...vercel, providerIdentity: { teamId: "other-team" } })).rejects.toMatchObject({ code: "EXTERNAL_TARGET_SCOPE_DENIED" });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("maps an actual Fly Machine response to running and carries image/config/environment", async () => {
    const input = target("fly", "fly-machine", { appName: "demo", config: JSON.stringify({ guest: { cpus: 2 } }) });
    vi.mocked(safeFetch).mockResolvedValue(response({ id: "machine-1", state: "started" }));
    const adapter = registry().get("fly");
    const plan = { planId: "plan", target: snapshot(input), capability: await adapter.capabilities(context, input), accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now() + 60000).toISOString(), image: "nginx:alpine", environment: { MODE: "staging" } };
    expect(await adapter.apply(context, { planId: "plan", confirm: true, idempotencyKey: "apply:0001" }, plan)).toMatchObject({ status: "running", providerResourceId: "machine-1" });
    const body = JSON.parse(vi.mocked(safeFetch).mock.calls[0]![1]!.body!);
    expect(body.config).toMatchObject({ image: "nginx:alpine", env: { MODE: "staging" }, guest: { cpu_kind: "shared", cpus: 2 } });
  });

  it("preserves explicitly selected performance CPU kind", async () => {
    const input = target("fly", "fly-machine", { appName: "demo", config: JSON.stringify({ guest: { cpu_kind: "performance", cpus: 1, memory_mb: 2048 } }) });
    vi.mocked(safeFetch).mockResolvedValue(response({ id: "machine-1", state: "started" }));
    const adapter = registry().get("fly");
    const plan = { planId: "plan", target: snapshot(input), capability: await adapter.capabilities(context, input), accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now() + 60000).toISOString(), image: "nginx:alpine" };
    await adapter.apply(context, { planId: "plan", confirm: true, idempotencyKey: "apply:0001" }, plan);
    expect(JSON.parse(vi.mocked(safeFetch).mock.calls[0]![1]!.body!).config.guest.cpu_kind).toBe("performance");
  });

  it("returns a useful fixed provider validation class without echoing secrets", async () => {
    const input = target("fly", "fly-machine", { appName: "demo" });
    vi.mocked(safeFetch).mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "invalid cpu kind '': leaked-secret" }) } as never);
    const adapter = registry().get("fly");
    await expect(adapter.preflight(context, input)).rejects.toMatchObject({ code: "FLY_CPU_INVALID", message: "Fly rejected the CPU kind. Choose shared or performance." });
  });

  it("force-deletes a running Machine only after explicit orchestration confirmation", async () => {
    const input = target("fly", "fly-machine", { appName: "demo", machineId: "machine-running" });
    vi.mocked(safeFetch).mockResolvedValue(response({ ok: true }));
    await registry().get("fly").destroy!(context, { ...operation(input), providerResourceId: "machine-running" });
    expect(safeFetch).toHaveBeenCalledWith("https://api.machines.dev/v1/apps/demo/machines/machine-running?force=true", expect.objectContaining({ method: "DELETE" }));
  });

  it("allocates shared public ingress for a new Fly app and keeps partial machine identity on failure", async () => {
    const input = target("fly", "fly-machine", { appName: "demo", createApp: "true", port: "8080" });
    vi.mocked(safeFetch).mockImplementation(async url => response(String(url).includes("graphql") ? { data: { allocateIpAddress: { ipAddress: { address: "1.2.3.4" } } } } : String(url).includes("machines") ? { id: "machine-public", state: "started" } : { id: "app-public" }));
    const adapter = registry().get("fly");
    const plan = { planId: "plan", target: snapshot(input), capability: await adapter.capabilities(context, input), accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now() + 60000).toISOString(), image: "nginx:alpine" };
    expect(await adapter.apply(context, { planId: "plan", confirm: true, idempotencyKey: "apply:0001" }, plan)).toMatchObject({ status: "running", providerResourceId: "machine-public", target: { resource: { url: "https://demo.fly.dev" } } });
    const ip = vi.mocked(safeFetch).mock.calls.find(([url]) => String(url).includes("graphql"))!;
    expect(JSON.parse(ip[1]!.body!).variables.input.type).toBe("shared_v4");
    vi.mocked(safeFetch).mockImplementation(async url => { if (String(url).includes("graphql")) throw new Error("timeout"); return response(String(url).includes("machines") ? { id: "machine-partial", state: "started" } : { id: "app-public" }); });
    expect(await adapter.apply(context, { planId: "plan", confirm: true, idempotencyKey: "apply:0002" }, plan)).toMatchObject({ status: "action_required", providerResourceId: "machine-partial", target: { resource: { publicIngress: "pending" } } });
  });

  it("creates a Vercel Sandbox without silently reusing an existing name", async () => {
    const input = target("vercel", "vercel-sandbox", { projectId: "prj1", name: "new-sandbox" });
    vi.mocked(Sandbox.create).mockResolvedValue({ name: "new-sandbox", status: "running" } as never);
    const adapter = registry().get("vercel");
    const plan = { planId: "plan", target: snapshot(input), capability: await adapter.capabilities(context, input), accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now() + 60000).toISOString(), image: "vercel/sandbox/universal", environment: { MODE: "test" }, source: { repo: "owner/repository", ref: "main" } };
    await adapter.apply(context, { planId: "plan", confirm: true, idempotencyKey: "apply:0001" }, plan);
    expect(Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ name: "new-sandbox", image: "vercel/sandbox/universal", env: { MODE: "test" }, source: { type: "git", url: "https://github.com/owner/repository.git", revision: "main" } }));
    expect(Sandbox.getOrCreate).not.toHaveBeenCalled();
  });

  it("posts Sprite creation to the collection and does not send unsupported images", async () => {
    const input = target("fly", "fly-sprite", { name: "agent" });
    vi.mocked(safeFetch).mockResolvedValue(response({ name: "agent", status: "warm" }));
    const adapter = registry().get("fly");
    const plan = { planId: "plan", target: snapshot(input), capability: await adapter.capabilities(context, input), accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now() + 60000).toISOString() };
    expect(await adapter.apply(context, { planId: "plan", confirm: true, idempotencyKey: "apply:0001" }, plan)).toMatchObject({ status: "running" });
    expect(safeFetch).toHaveBeenCalledWith("https://api.sprites.dev/v1/sprites", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "agent" }) }));
  });

  it("uses linked Git repository for a project deployment with the actual Vercel body", async () => {
    const input = target("vercel", "service", { projectId: "prj1" });
    vi.mocked(safeFetch).mockImplementation(async (url) => response(String(url).includes("/projects/") ? { id: "prj1", name: "web", link: { type: "github", repoId: 123, productionBranch: "trunk" } } : { id: "dpl1", readyState: "QUEUED" }));
    const adapter = registry().get("vercel");
    const plan = { planId: "plan", target: snapshot(input), capability: await adapter.capabilities(context, input), accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now() + 60000).toISOString() };
    await adapter.apply(context, { planId: "plan", confirm: true, idempotencyKey: "apply:0001" }, plan);
    const request = vi.mocked(safeFetch).mock.calls.find(([url]) => String(url).includes("/deployments"))!;
    expect(JSON.parse(request[1]!.body!)).toMatchObject({ name: "web", project: "prj1", gitSource: { type: "github", repoId: 123, ref: "trunk" } });
    expect(JSON.parse(request[1]!.body!)).not.toHaveProperty("source");
  });

  it("dispatches sandbox exec/delete and observes without resuming", async () => {
    const input = target("vercel", "vercel-sandbox", { projectId: "prj1", name: "sandbox" });
    const runCommand = vi.fn(async () => ({ stdout: async () => "hello", stderr: async () => "", exitCode: 0 }));
    const remove = vi.fn();
    vi.mocked(Sandbox.get).mockResolvedValue({ name: "sandbox", status: "stopped", runCommand, delete: remove } as never);
    const adapter = registry().get("vercel");
    expect((await adapter.observe(context, { target: input })).status).toBe("stopped");
    expect(Sandbox.get).toHaveBeenCalledWith(expect.objectContaining({ resume: false, name: "sandbox", teamId: "team" }));
    expect(await adapter.exec!(context, operation(input), { argv: ["echo", "hello"] })).toMatchObject({ stdout: "hello", exitCode: 0 });
    await adapter.destroy!(context, operation(input));
    expect(remove).toHaveBeenCalledOnce();
  });
});

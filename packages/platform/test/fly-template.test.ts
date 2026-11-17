import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AppError } from "@repo/core";
import { createFlyTemplateAdapter } from "../src/engine/modules/external-deployments/providers/fly-template";
import type { ExternalOperation, ExternalTargetInput, ExternalTargetSnapshot } from "@repo/contracts";
import type { FlyMachinesClient } from "../src/engine/modules/external-deployments/providers/fly";
const image = "registry-1.docker.io/excalidraw/excalidraw@sha256:" + "a".repeat(64);
const context = { organizationId: "org-control" };
const target: ExternalTargetInput = { provider: "fly", workloadKind: "fly-machine", connectionId: "fly-1", providerIdentity: { organizationId: "provider-org" }, resource: { appTemplateId: "excalidraw", appRecipeId: "fly-static", appName: "my-excalidraw", name: "my-excalidraw", createApp: "true", port: "80", vcpus: "1", memoryMb: "256", region: "ams" } };
const snapshot: ExternalTargetSnapshot = { ...target, targetId: "target-one", organizationId: context.organizationId, capturedAt: new Date().toISOString() };
const api = { inspectAppOrNull: vi.fn(), createApp: vi.fn(), create: vi.fn(), allocatePublicIp: vi.fn(), inspectOrNull: vi.fn(), destroy: vi.fn(), list: vi.fn(), listVolumes: vi.fn(), deleteEmptyApp: vi.fn() };
const adapter = () => createFlyTemplateAdapter(async () => ({ id: "fly-1", publicFields: { organizationId: "provider-org" }, secrets: { apiToken: "secret" } }), { signingKey: "instance-secret", client: () => api as unknown as FlyMachinesClient });
async function deploy() {
 const a = adapter();
 return a.apply(context, { planId: "p", idempotencyKey: "deploy:000001", confirm: true }, { planId: "p", target: snapshot, capability: await a.capabilities(context, target), accepted: true, blockers: [], warnings: [], expiresAt: new Date(Date.now()+60000).toISOString(), image } as never);
}
beforeEach(() => {
 for (const mock of Object.values(api)) mock.mockReset();
 api.inspectAppOrNull.mockResolvedValue(undefined); api.createApp.mockResolvedValue({ id: "app-id" });
 api.create.mockResolvedValue({ id: "machine-id", state: "started" });
 api.allocatePublicIp.mockResolvedValue(undefined); api.list.mockResolvedValue([]); api.listVolumes.mockResolvedValue([]);
});
describe("Fly stateless catalog installations", () => {
 it("plans without creating resources and refuses an existing app name", async () => {
  const a = adapter(); expect((await a.plan(context, { target, image, idempotencyKey: "plan:000001" })).accepted).toBe(true);
  expect(api.createApp).not.toHaveBeenCalled(); api.inspectAppOrNull.mockResolvedValue({ id: "other" });
  expect((await a.plan(context, { target, image, idempotencyKey: "plan:000002" })).accepted).toBe(false);
 });
 it("creates a pinned stateless Machine and preserves signed ownership and HTTPS URL", async () => {
  const result = await deploy();
  expect(result).toMatchObject({ status: "running", providerResourceId: "machine-id", target: { resource: { managedAppId: "app-id", machineConfirmed: "true", url: "https://my-excalidraw.fly.dev" } } });
  expect(result.target.resource.managedAppProof).toMatch(/^[a-f0-9]{64}$/);
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ image, guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 }, services: [expect.objectContaining({ internal_port: 80 })] }) }));
  expect(api.create.mock.calls[0]![0].config).not.toHaveProperty("mounts");
 });
 it("retains signed app identity after failed Machine creation so an empty app can be deleted", async () => {
  api.create.mockRejectedValue(new Error("capacity")); const result = await deploy();
  expect(result).toMatchObject({ status: "action_required", providerResourceId: "app-id", target: { resource: { machineConfirmed: "false" } } });
  api.inspectAppOrNull.mockResolvedValueOnce({ id: "app-id", name: "my-excalidraw" }).mockResolvedValue(undefined);
  expect((await adapter().destroy!(context, result)).status).toBe("stopped");
  expect(api.destroy).not.toHaveBeenCalled(); expect(api.deleteEmptyApp).toHaveBeenCalledWith("my-excalidraw");
 });
 it("reports a safe allocation failure while retaining signed Machine and app ownership", async () => {
  api.allocatePublicIp.mockRejectedValue(new AppError("Fly could not confirm the app's public IP allocation.", 502, "FLY_IP_ALLOCATION_FAILED"));
  const result = await deploy();
  expect(result).toMatchObject({ status: "action_required", errorCode: "FLY_IP_ALLOCATION_FAILED", providerResourceId: "machine-id", target: { resource: { managedAppId: "app-id", machineConfirmed: "true" } } });
  expect(result.message).toContain("public IP");
 });
 it("checks Machine ownership then deletes only an empty volume-free owned app", async () => {
  const result = await deploy(); api.inspectAppOrNull.mockResolvedValueOnce({ id: "app-id", name: "my-excalidraw" }).mockResolvedValue(undefined);
  api.inspectOrNull.mockResolvedValue({ id: "machine-id", state: "started", config: { metadata: { "workbox.appProof": result.target.resource.managedAppProof } } });
  expect((await adapter().destroy!(context, result)).status).toBe("stopped");
  expect(api.destroy).toHaveBeenCalledWith("my-excalidraw", "machine-id", expect.any(String));
  expect(api.deleteEmptyApp).toHaveBeenCalledOnce();
 });
 it.each(["machine", "volume"])("retains the app if another %s remains", async kind => {
  const result = await deploy(); api.inspectAppOrNull.mockResolvedValueOnce({ id: "app-id", name: "my-excalidraw" }).mockResolvedValue(undefined); api.inspectOrNull.mockResolvedValue(undefined);
  if(kind === "machine") api.list.mockResolvedValue([{ id: "other-machine", state: "started" }]); else api.listVolumes.mockResolvedValue([{ id: "data" }]);
  expect((await adapter().destroy!(context, result)).status).toBe("action_required");
  expect(api.deleteEmptyApp).not.toHaveBeenCalled();
 });
 it("rejects forged ownership, copied proof from another target, and replaced app identity", async () => {
  const result = await deploy();
  for(const modified of [{ managedAppProof: "0".repeat(64) }, { managedAppName: "other-app" }]) await expect(adapter().destroy!(context, { ...result, target: { ...result.target, resource: { ...result.target.resource, ...modified } } })).rejects.toMatchObject({ code: "EXTERNAL_APP_NOT_OWNED" });
  await expect(adapter().destroy!(context, { ...result, target: { ...result.target, targetId: "other-target" } })).rejects.toMatchObject({ code: "EXTERNAL_APP_NOT_OWNED" });
  api.inspectAppOrNull.mockResolvedValue({ id: "replaced-app", name: "my-excalidraw" });
  await expect(adapter().destroy!(context, result)).rejects.toMatchObject({ code: "EXTERNAL_APP_NOT_OWNED" });
  expect(api.destroy).not.toHaveBeenCalled();
 });
 it("ships two stateless reviewed recipes with explicit version and no storage claim", () => {
  for(const id of ["excalidraw", "it-tools"]){
   const entry=JSON.parse(readFileSync(new URL(`../../core/src/apps/catalog/${id}.json`,import.meta.url),'utf8'));
   expect(entry.schemaVersion).toBe(3); expect(entry.provenance.license).toBeTruthy();
   const recipe=entry.deploymentRecipes.find((r: {provider:string}) => r.provider==='fly');
   expect(recipe.image).toMatch(/@sha256:[a-f0-9]{64}$/);expect(recipe.resource).toMatchObject({createApp:'true',port:'80',memoryMb:'256',vcpus:'1'});
   expect(recipe.requiredCapabilities).not.toContain('persistent-storage');
  }
 });
});

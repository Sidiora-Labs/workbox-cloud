import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@repo/core";
import type { ExternalCapabilityName, ExternalCapabilityProfile, ExternalOperation, ExternalPlan, ExternalPlanInput, ExternalTargetInput, ExternalTargetSnapshot } from "@repo/contracts";
import type { ExternalProviderAdapter, ExternalProviderContext } from "../../../../external-deployments";
import type { BuiltinCredentialResolver } from "../builtin-registry";
import { FlyMachinesClient, normalizeFlyStatus } from "./fly";

type Target = ExternalTargetInput | ExternalTargetSnapshot;
type ExecutionPlan = ExternalPlan & Pick<ExternalPlanInput, "image" | "environment">;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const now = () => new Date().toISOString();
const capabilities: ExternalCapabilityName[] = ["discover", "preflight", "apply", "observe", "destroy", "public-ingress", "private-network"];
export const isFlyTemplateTarget = (target: Target) => target.provider === "fly" && target.workloadKind === "fly-machine" && Boolean(target.resource.appTemplateId);
export interface FlyTemplateOptions { signingKey: string; client?: (token: string, organizationId: string) => FlyMachinesClient }

/** Stateless catalog installations own an app and one Machine, never volumes. */
export function createFlyTemplateAdapter(resolve: BuiltinCredentialResolver, options: FlyTemplateOptions): ExternalProviderAdapter {
  if (!options.signingKey) throw new Error("Fly catalog ownership requires the instance signing key");
  const profile = (target: Target): ExternalCapabilityProfile => ({ provider: "fly", workloadKind: "fly-machine", checkedAt: now(), expiresAt: new Date(Date.now() + 900000).toISOString(), supported: capabilities, unsupported: [], limits: {}, observedIdentity: target.providerIdentity });
  const proof = (context: ExternalProviderContext, target: Target, appId: string, appName: string) => createHmac("sha256", options.signingKey).update(JSON.stringify([context.organizationId, target.connectionId, "targetId" in target ? target.targetId : "", target.resource.appTemplateId, target.resource.appRecipeId, appId, appName])).digest("hex");
  function owned(context: ExternalProviderContext, target: Target) {
    const { managedAppId: appId, managedAppName: appName, managedAppProof: signature } = target.resource;
    if (!appId || !appName || !signature || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(proof(context, target, appId, appName), "hex"))) throw new AppError("Only the Fly app created by this installation can be managed here.", 403, "EXTERNAL_APP_NOT_OWNED");
    return { appId, appName };
  }
  async function client(context: ExternalProviderContext, target: Target) {
    const credential = await resolve(context, target.connectionId, "fly");
    const org = credential.publicFields.organizationId;
    if (!org || !credential.secrets.apiToken) throw new AppError("Reconnect Fly before deploying this app.", 409, "CONNECTION_RECONNECT_REQUIRED");
    if (target.providerIdentity.organizationId && target.providerIdentity.organizationId !== org) throw new AppError("The Fly organization does not match the selected connection.", 403, "EXTERNAL_TARGET_SCOPE_DENIED");
    return (options.client ?? ((token, organizationId) => new FlyMachinesClient({ token, organizationId })))(credential.secrets.apiToken, org);
  }
  function result(context: ExternalProviderContext, target: Target, status: ExternalOperation["status"], resource: Record<string, string>, providerStatus?: string, message?: string): ExternalOperation {
    const snapshot: ExternalTargetSnapshot = { ...target, targetId: "targetId" in target ? target.targetId : target.resource.name ?? target.connectionId, organizationId: context.organizationId, resource: { ...target.resource, ...resource }, capturedAt: now() };
    return { id: "fly-template:" + (resource.machineId ?? resource.managedAppId), targetId: snapshot.targetId, target: snapshot, organizationId: context.organizationId, kind: "apply", workloadKind: "fly-machine", status, idempotencyKey: "fly-template:" + snapshot.targetId, providerResourceId: resource.machineConfirmed === "true" ? resource.machineId : resource.managedAppId, ...(providerStatus ? { providerStatus } : {}), ...(message ? { message } : {}), createdAt: now(), updatedAt: now() };
  }
  function validate(target: Target, image?: string) {
    if (!isFlyTemplateTarget(target) || target.resource.createApp !== "true") throw new AppError("Select a Fly catalog recipe to create a dedicated app.", 400, "CATALOG_RECIPE_REQUIRED");
    if (!/^[a-z][a-z0-9-]{2,62}$/.test(target.resource.appName ?? "")) throw new AppError("Use a Fly app name of 3–63 lowercase letters, numbers, or hyphens.", 400, "EXTERNAL_TARGET_INVALID");
    if (image !== undefined && !/^[-a-zA-Z0-9._/:]+@sha256:[a-f0-9]{64}$/.test(image)) throw new AppError("The catalog recipe requires a reviewed image digest.", 400, "CATALOG_IMAGE_INVALID");
    for (const key of ["port", "vcpus", "memoryMb"]) if (!Number.isInteger(Number(target.resource[key])) || Number(target.resource[key]) <= 0) throw new AppError("The catalog recipe has invalid resource settings.", 400, "CATALOG_RECIPE_INVALID");
    if (target.resource.config) throw new AppError("Fly catalog recipes do not accept custom Machine configuration or volumes.", 400, "CATALOG_RECIPE_INVALID");
  }
  async function inspect(context: ExternalProviderContext, target: Target) {
    const ownership = owned(context, target); const api = await client(context, target);
    const app = record(await api.inspectAppOrNull(ownership.appName));
    if (Object.keys(app).length && (String(app.id) !== ownership.appId || app.name !== ownership.appName)) throw new AppError("The Fly app identity changed since installation.", 403, "EXTERNAL_APP_NOT_OWNED");
    return { api, ownership, exists: Object.keys(app).length > 0 };
  }
  const adapter: ExternalProviderAdapter = {
    provider: "fly", workloads: ["fly-machine"],
    async capabilities(_context, target) { return profile(target); },
    async preflight(context, target) { validate(target); await client(context, target); const capability = profile(target); return { planId: "fly-template-preflight", target: { ...target, targetId: target.resource.name ?? target.connectionId, organizationId: context.organizationId, capturedAt: now() }, capability, accepted: true, blockers: [], warnings: ["This recipe stores application data in your browser and provisions no server-side volume."], expiresAt: capability.expiresAt! }; },
    async plan(context, input) { validate(input.target, input.image); const preflight = await adapter.preflight(context, input.target); const api = await client(context, input.target); if (await api.inspectAppOrNull(input.target.resource.appName!)) return { ...preflight, accepted: false, blockers: ["A Fly app already uses this name. Choose a new name for this installation."] }; return preflight; },
    async apply(context, input, rawPlan) {
      const plan = rawPlan as ExecutionPlan; validate(plan.target, plan.image);
      const api = await client(context, plan.target); const appName = plan.target.resource.appName!;
      // No adoption: only a successful create gives this installation ownership.
      const app = record(await api.createApp(appName, "app:" + input.idempotencyKey));
      const appId = string(app.id);
      if (!appId) throw new AppError("Fly did not confirm the created app ID. Inspect the provider before retrying.", 502, "EXTERNAL_UNKNOWN_OUTCOME");
      let resource: Record<string, string> = { managedAppId: appId, managedAppName: appName, managedAppProof: proof(context, plan.target, appId, appName), machineConfirmed: "false" };
      try {
        const row = record(await api.create({ appName, name: plan.target.resource.name ?? appName, region: plan.target.resource.region, idempotencyKey: input.idempotencyKey, config: { image: plan.image, ...(plan.environment ? { env: plan.environment } : {}), metadata: { "workbox.target": plan.target.targetId, "workbox.appProof": resource.managedAppProof }, guest: { cpu_kind: "shared", cpus: Number(plan.target.resource.vcpus), memory_mb: Number(plan.target.resource.memoryMb) }, services: [{ protocol: "tcp", internal_port: Number(plan.target.resource.port), ports: [{ port: 80, handlers: ["http"] }, { port: 443, handlers: ["tls", "http"] }] }], restart: { policy: "on-failure", max_retries: 3 } } }));
        const machineId = string(row.id);
        if (!machineId) throw new Error("Unconfirmed Machine identity");
        resource = { ...resource, machineId, machineConfirmed: "true" };
        await api.allocatePublicIp(appName, "ip:" + input.idempotencyKey);
        resource = { ...resource, publicIngress: "ready", url: `https://${appName}.fly.dev` };
        return result(context, plan.target, normalizeFlyStatus("fly-machine", row) === "running" ? "running" : "provisioning", resource, string(row.state));
      } catch (error) {
        const code = error instanceof AppError ? error.code : "FLY_DEPLOYMENT_UNCONFIRMED";
        const message = error instanceof AppError ? error.message : "Fly did not confirm the Machine or public IP.";
        return { ...result(context, plan.target, "action_required", resource, undefined, `${message} The dedicated app is retained; inspect or delete this installation before retrying.`), errorCode: code };
      }
    },
    async observe(context, input) {
      const inspected = await inspect(context, input.target);
      const resource = input.target.resource;
      if (!inspected.exists) return result(context, input.target, "stopped", resource, "DELETED");
      if (resource.machineConfirmed !== "true") return result(context, input.target, "action_required", resource, undefined, "This app has no confirmed Machine. Delete the empty installation or inspect it in Fly before retrying.");
      const row = record(await inspected.api.inspectOrNull(inspected.ownership.appName, resource.machineId!));
      if (!Object.keys(row).length) return result(context, input.target, "action_required", resource, "MACHINE_ABSENT", "The installation's Machine is absent. Delete the empty app to finish cleanup.");
      const metadata = record(record(row.config).metadata);
      if (metadata["workbox.appProof"] !== resource.managedAppProof) throw new AppError("The Machine does not belong to this installation.", 403, "EXTERNAL_APP_NOT_OWNED");
      const normalized = normalizeFlyStatus("fly-machine", row);
      return result(context, input.target, resource.publicIngress !== "ready" ? "action_required" : normalized === "running" ? "running" : normalized === "stopped" ? "stopped" : normalized === "failed" ? "failed" : "provisioning", resource, string(row.state));
    },
    async destroy(context, operation) {
      const target = operation.target; const inspected = await inspect(context, target);
      if (!inspected.exists) return { ...operation, status: "stopped", providerStatus: "DELETED" };
      if (target.resource.machineConfirmed === "true") {
        const machine = record(await inspected.api.inspectOrNull(inspected.ownership.appName, target.resource.machineId!));
        if (Object.keys(machine).length && machine.state !== "destroyed") {
          if (record(record(machine.config).metadata)["workbox.appProof"] !== target.resource.managedAppProof) throw new AppError("The Machine does not belong to this installation.", 403, "EXTERNAL_APP_NOT_OWNED");
          await inspected.api.destroy(inspected.ownership.appName, target.resource.machineId!, "destroy:" + operation.id);
        }
      }
      const machines = await inspected.api.list(inspected.ownership.appName); const volumes = await inspected.api.listVolumes(inspected.ownership.appName);
      if (!Array.isArray(machines) || !Array.isArray(volumes)) throw new AppError("Fly did not confirm empty app inventory.", 502, "EXTERNAL_UNKNOWN_OUTCOME");
      if (machines.some(row => record(row).state !== "destroyed") || volumes.length) return { ...operation, status: "action_required", providerStatus: "APP_RETAINED", message: "The Fly app contains another Machine or volume and was retained. Remove those resources explicitly before deleting the app." };
      // Never force-delete an app: the provider must also enforce its empty state.
      await inspected.api.deleteEmptyApp(inspected.ownership.appName);
      const remains = await inspected.api.inspectAppOrNull(inspected.ownership.appName);
      return { ...operation, status: remains ? "stopping" : "stopped", providerStatus: remains ? "DELETING" : "DELETED", updatedAt: now() };
    },
  };
  return adapter;
}

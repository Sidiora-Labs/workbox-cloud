import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@repo/core";
import type {
  ExternalCapabilityName,
  ExternalCapabilityProfile,
  ExternalLogEntry,
  ExternalOperation,
  ExternalPlan,
  ExternalPlanInput,
  ExternalTargetInput,
  ExternalTargetSnapshot,
} from "@repo/contracts";
import type { ExternalProviderAdapter, ExternalProviderContext } from "../../../../external-deployments";
import type { BuiltinCredentialResolver } from "../builtin-registry";
import { createVercelApiClient, normalizeVercelDeployment, type VercelApiClient } from "./vercel";

type Target = ExternalTargetInput | ExternalTargetSnapshot;
type ExecutionPlan = ExternalPlan & Pick<ExternalPlanInput, "source" | "environment" | "image">;
const now = () => new Date().toISOString();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const supported: ExternalCapabilityName[] = ["discover", "preflight", "apply", "observe", "logs", "destroy", "public-ingress"];

export interface VercelTemplateAdapterOptions {
  /** Instance-only key signs provider IDs so raw public target fields cannot claim ownership. */
  signingKey: string;
  client?: (scope: { connectionId: string; accountId: string; teamId?: string }, token: string) => VercelApiClient;
}

export const isVercelTemplateTarget = (target: Target) =>
  target.provider === "vercel" && target.workloadKind === "service" && Boolean(target.resource.appTemplateId);

function capability(target: Target): ExternalCapabilityProfile {
  return { provider: "vercel", workloadKind: "service", checkedAt: now(), expiresAt: new Date(Date.now() + 900_000).toISOString(), supported, unsupported: [], limits: {}, observedIdentity: target.providerIdentity };
}

function snapshot(context: ExternalProviderContext, target: Target, resource: Record<string, string> = {}): ExternalTargetSnapshot {
  return { ...target, targetId: "targetId" in target ? target.targetId : target.resource.name ?? target.connectionId, organizationId: context.organizationId, resource: { ...target.resource, ...resource }, capturedAt: now() };
}

function result(context: ExternalProviderContext, target: Target, status: ExternalOperation["status"], resource: Record<string, string>, deployment?: unknown, message?: string): ExternalOperation {
  const row = record(deployment);
  const id = string(row.id) ?? string(row.uid) ?? resource.projectId;
  return { id: `vercel-template:${id}`, organizationId: context.organizationId, targetId: "targetId" in target ? target.targetId : target.resource.name ?? target.connectionId, kind: "apply", workloadKind: "service", status, idempotencyKey: `vercel-template:${id}`, target: snapshot(context, target, resource), providerResourceId: id, ...(string(row.readyState) ? { providerStatus: string(row.readyState) } : {}), ...(message ? { message } : {}), createdAt: now(), updatedAt: now() };
}

function deploymentStatus(value: unknown): ExternalOperation["status"] {
  const state = normalizeVercelDeployment(value).status;
  return state === "ready" ? "ready" : state === "failed" ? "failed" : state === "canceled" ? "stopped" : state === "queued" || state === "building" ? "provisioning" : "unknown";
}

function sourceSettings(source: Record<string, string> | undefined) {
  const repo = string(source?.repo);
  const ref = string(source?.ref);
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !ref || !/^[a-f0-9]{40}$/i.test(ref))
    throw new AppError("The catalog template must contain a reviewed repository and immutable Git revision.", 400, "CATALOG_SOURCE_INVALID");
  const rootDirectory = source?.rootDirectory;
  if (rootDirectory && (rootDirectory.startsWith("/") || rootDirectory.split("/").includes("..")))
    throw new AppError("The catalog template contains an invalid source directory.", 400, "CATALOG_SOURCE_INVALID");
  const settings: Record<string, unknown> = { framework: source?.framework ?? "nextjs", ...(rootDirectory ? { rootDirectory } : {}) };
  for (const key of ["buildCommand", "installCommand", "outputDirectory"]) if (source?.[key]) settings[key] = source[key];
  const [org, name] = repo.split("/");
  return { repo, ref, settings, gitSource: { type: "github", org, repo: name, ref, sha: ref } };
}

/** Curated Git templates create a dedicated project, retaining its signed ownership on partial failures. */
export function createVercelTemplateAdapter(resolve: BuiltinCredentialResolver, options: VercelTemplateAdapterOptions): ExternalProviderAdapter {
  if (!options.signingKey) throw new Error("Vercel catalog ownership requires the instance signing key");
  async function client(context: ExternalProviderContext, target: Target) {
    const credential = await resolve(context, target.connectionId, "vercel");
    for (const key of ["accountId", "teamId"]) {
      if (target.providerIdentity[key] && target.providerIdentity[key] !== credential.publicFields[key])
        throw new AppError("The selected Vercel account does not match this workload.", 403, "EXTERNAL_TARGET_SCOPE_DENIED");
    }
    if (!credential.secrets.apiToken) throw new AppError("Reconnect Vercel before deploying.", 409, "CONNECTION_RECONNECT_REQUIRED");
    return (options.client ?? createVercelApiClient)({ connectionId: target.connectionId, accountId: credential.publicFields.accountId ?? "account", ...(credential.publicFields.teamId ? { teamId: credential.publicFields.teamId } : {}) }, credential.secrets.apiToken);
  }
  function proof(context: ExternalProviderContext, target: Target, projectId: string, projectName: string) {
    return createHmac("sha256", options.signingKey).update(JSON.stringify([context.organizationId, target.connectionId, target.resource.appTemplateId, target.resource.appRecipeId, projectId, projectName])).digest("hex");
  }
  function owned(context: ExternalProviderContext, target: Target) {
    const projectId = target.resource.projectId;
    const projectName = target.resource.managedProjectName;
    const signature = target.resource.managedProjectProof;
    if (!projectId || !projectName || !signature || !/^[a-f0-9]{64}$/i.test(signature))
      throw new AppError("Only projects created by this catalog installation can be managed here.", 403, "EXTERNAL_PROJECT_NOT_OWNED");
    const expected = proof(context, target, projectId, projectName);
    if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex")))
      throw new AppError("The project ownership receipt does not match this workload.", 403, "EXTERNAL_PROJECT_NOT_OWNED");
    return { projectId, projectName };
  }
  function validate(target: Target) {
    if (!isVercelTemplateTarget(target) || target.resource.createProject !== "true")
      throw new AppError("Select a Vercel catalog template to create a managed project.", 400, "CATALOG_RECIPE_REQUIRED");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(target.resource.name ?? ""))
      throw new AppError("Project names must use lowercase letters, numbers and hyphens, up to 100 characters.", 400, "EXTERNAL_TARGET_INVALID");
  }
  async function plan(context: ExternalProviderContext, target: Target): Promise<ExternalPlan> {
    validate(target);
    const api = await client(context, target);
    const existing = await api.request(`/v9/projects/${encodeURIComponent(target.resource.name!)}`, { allowMissing: true });
    const blockers = existing ? ["A Vercel project with this name already exists. Choose a new name; catalog installs never adopt an existing project."] : [];
    const cap = capability(target);
    return { planId: `vercel-template:${target.resource.name}`, target: snapshot(context, target), capability: cap, accepted: blockers.length === 0, blockers, warnings: ["This creates a dedicated Vercel project from the reviewed upstream revision. Repository cloning and external database or storage provisioning are not included."], expiresAt: cap.expiresAt! };
  }
  async function inspect(context: ExternalProviderContext, target: Target) {
    const ownership = owned(context, target);
    const api = await client(context, target);
    const project = record(await api.request(`/v9/projects/${encodeURIComponent(ownership.projectId)}`, { allowMissing: true }));
    if (!Object.keys(project).length) return { api, ownership, project: null };
    if (project.id !== ownership.projectId || project.name !== ownership.projectName)
      throw new AppError("The Vercel project no longer matches the installation receipt.", 409, "EXTERNAL_PROJECT_CHANGED");
    return { api, ownership, project };
  }
  return {
    provider: "vercel", workloads: ["service"],
    async capabilities(_context, target) { return capability(target); },
    preflight: plan,
    async plan(context, input) {
      const result = await plan(context, input.target);
      sourceSettings(input.source);
      if (input.image) { result.accepted = false; result.blockers.push("Vercel catalog templates deploy Git source, not container images."); }
      return result;
    },
    async apply(context, input, genericPlan) {
      const plan = genericPlan as ExecutionPlan;
      validate(plan.target);
      const source = sourceSettings(plan.source);
      const api = await client(context, plan.target);
      if (await api.request(`/v9/projects/${encodeURIComponent(plan.target.resource.name!)}`, { allowMissing: true }))
        throw new AppError("A Vercel project with this name already exists. Choose a new name.", 409, "EXTERNAL_TARGET_CONFLICT");
      const created = record(await api.request("/v11/projects", { method: "POST", body: { name: plan.target.resource.name, ...source.settings, environmentVariables: Object.entries(plan.environment ?? {}).map(([key, value]) => ({ key, value, type: "encrypted", target: ["production", "preview", "development"] })) } }));
      const projectId = string(created.id);
      const projectName = string(created.name);
      if (!projectId || !projectName) throw new AppError("Vercel did not return the created project identity. Inspect your account before retrying.", 502, "EXTERNAL_UNKNOWN_OUTCOME");
      const resource = { projectId, managedProjectName: projectName, managedProjectProof: proof(context, plan.target, projectId, projectName), sourceRepo: source.repo, sourceRevision: source.ref, deploymentConfirmed: "false" };
      try {
        const deployment = await api.request("/v13/deployments", { method: "POST", body: { name: projectName, project: projectId, target: "production", gitSource: source.gitSource, projectSettings: source.settings, meta: { workboxOperationKey: input.idempotencyKey, workboxTemplateId: plan.target.resource.appTemplateId } } });
        const row = record(deployment);
        if (!string(row.id) && !string(row.uid)) throw new Error("Missing deployment id");
        const observed = normalizeVercelDeployment(deployment);
        return result(context, plan.target, deploymentStatus(deployment), { ...resource, deploymentConfirmed: "true", deploymentId: observed.resourceId, ...(observed.url ? { url: observed.url } : {}) }, deployment);
      } catch {
        // Retain signed project ownership so an accepted create followed by a failed build request stays manageable.
        return { ...result(context, plan.target, "action_required", resource, undefined, "The project was created, but its deployment was not confirmed. Inspect its status or delete this installation before retrying."), errorCode: "EXTERNAL_DEPLOYMENT_UNCONFIRMED" };
      }
    },
    async observe(context, input) {
      const inspected = await inspect(context, input.target);
      if (!inspected.project) return { ...result(context, input.target, "stopped", input.target.resource), providerStatus: "DELETED" };
      const deploymentId = input.target.resource.deploymentId;
      if (!deploymentId || input.target.resource.deploymentConfirmed !== "true") return result(context, input.target, "action_required", input.target.resource, undefined, "This project has no confirmed deployment. Inspect the provider or delete it before retrying.");
      const deployment = await inspected.api.request(`/v13/deployments/${encodeURIComponent(deploymentId)}`, { allowMissing: true });
      if (!deployment) return result(context, input.target, "action_required", input.target.resource, undefined, "The installation's deployment is no longer present.");
      const row = record(deployment);
      if (row.projectId !== inspected.ownership.projectId)
        throw new AppError("The Vercel deployment does not belong to this installation.", 403, "EXTERNAL_TARGET_SCOPE_DENIED");
      const observation = normalizeVercelDeployment(deployment);
      return result(context, input.target, deploymentStatus(deployment), { ...input.target.resource, ...(observation.url ? { url: observation.url } : {}) }, deployment);
    },
    async *logs(context, operation): AsyncIterable<ExternalLogEntry> {
      const { api, ownership, project } = await inspect(context, operation.target);
      if (!project || !operation.target.resource.deploymentId || operation.target.resource.deploymentConfirmed !== "true") return;
      const id = operation.target.resource.deploymentId;
      const deployment = record(await api.request(`/v13/deployments/${encodeURIComponent(id)}`));
      if (deployment.projectId !== ownership.projectId)
        throw new AppError("The Vercel deployment does not belong to this installation.", 403, "EXTERNAL_TARGET_SCOPE_DENIED");
      const body = await api.request(`/v3/deployments/${encodeURIComponent(id)}/events`, { query: { limit: 200, follow: 0 } });
      const events = Array.isArray(body) ? body : Array.isArray(record(body).events) ? record(body).events as unknown[] : [];
      for (const [index, item] of events.slice(-200).entries()) {
        const event = record(item);
        const payload = record(event.payload);
        const message = string(event.text) ?? string(payload.text) ?? string(event.message);
        if (!message) continue;
        const createdAt = typeof event.created === "number" ? new Date(event.created) : null;
        const timestamp = createdAt && Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : now();
        yield { cursor: String(event.id ?? index), timestamp, stream: event.type === "stderr" ? "stderr" : "stdout", message: message.slice(0, 20_000), ...(message.length > 20_000 ? { truncated: true } : {}) };
      }
    },
    async destroy(context, operation) {
      const { api, ownership, project } = await inspect(context, operation.target);
      if (project) await api.request(`/v9/projects/${encodeURIComponent(ownership.projectId)}`, { method: "DELETE" });
      return { ...operation, kind: "destroy", status: "stopped", providerStatus: "DELETED", updatedAt: now() };
    },
  };
}

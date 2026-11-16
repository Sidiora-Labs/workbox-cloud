import { AppError } from "@repo/core";
import type {
  ExternalApplyInput,
  ExternalCapabilityName,
  ExternalCapabilityProfile,
  ExternalOperation,
  ExternalPlan,
  ExternalPlanInput,
  ExternalTargetInput,
  ExternalTargetSnapshot,
  ExternalWorkloadKind,
  ExternalObserveInput,
} from "@repo/contracts";
import type { ExternalProviderAdapter, ExternalProviderContext } from "../../../../external-deployments";
import { railwayQuery, type ProviderAccess } from "../../credentials/provider-api";
import {
  createRailwayServiceAdapter,
  type RailwayServiceTarget,
  type RailwayServiceConfigPatch,
} from "./railway-service";
import {
  createRailwaySandboxAdapter,
  type RailwaySandboxCreateInput,
  type RailwaySandboxTarget,
  type RailwaySandboxRecord,
} from "./railway-sandbox";

export type RailwayCredentialResolver = (
  context: ExternalProviderContext,
  connectionId: string,
) => Promise<{ readonly publicFields: Record<string, string>; readonly secrets: Record<string, string> }>;

const WORKLOADS: readonly ExternalWorkloadKind[] = ["service", "railway-sandbox"];
const SERVICE_CAPS: readonly ExternalCapabilityName[] = ["discover", "preflight", "apply", "observe"];
// The GraphQL fallback can create, inspect and destroy a sandbox. Exec, files,
// sessions, checkpoints and stop/resume require the Railway SDK transport and
// are therefore surfaced as unsupported until that transport is injected.
const SANDBOX_CAPS: readonly ExternalCapabilityName[] = ["discover", "preflight", "apply", "observe", "destroy", "public-ingress", "private-network", "idle-policy"];
const allCaps: readonly ExternalCapabilityName[] = ["discover", "preflight", "apply", "observe", "logs", "exec", "session", "files", "snapshot", "checkpoint", "stop", "resume", "promote", "rollback", "destroy", "reconcile", "public-ingress", "persistent-storage", "shared-storage", "private-network", "idle-policy"];
const now = () => new Date().toISOString();
const str = (v: unknown) => typeof v === "string" && v.trim() ? v : undefined;
const rec = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};

function profile(target: ExternalTargetInput, supported: readonly ExternalCapabilityName[]): ExternalCapabilityProfile {
  return {
    provider: "railway",
    workloadKind: target.workloadKind,
    checkedAt: now(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    supported: [...supported],
    unsupported: allCaps.filter((capability) => !supported.includes(capability)).map((capability) => ({ capability, reason: "Railway does not expose this capability for the selected workload." })),
    limits: {},
    observedIdentity: target.providerIdentity,
  };
}

function snap(context: ExternalProviderContext, target: ExternalTargetInput): ExternalTargetSnapshot {
  return {
    targetId: String(target.resource.id ?? target.resource.name ?? target.connectionId),
    organizationId: context.organizationId,
    provider: "railway",
    workloadKind: target.workloadKind,
    connectionId: target.connectionId,
    providerIdentity: target.providerIdentity,
    resource: Object.fromEntries(Object.entries(target.resource).map(([key, value]) => [key, String(value)])),
    capturedAt: now(),
  };
}

function operation(target: ExternalTargetSnapshot, status: ExternalOperation["status"], providerResourceId?: string, providerStatus?: string, message?: string): ExternalOperation {
  return {
    id: `railway:${providerResourceId ?? target.targetId}`,
    organizationId: target.organizationId,
    targetId: target.targetId,
    kind: "apply",
    workloadKind: target.workloadKind,
    status,
    idempotencyKey: `railway:${target.targetId}`,
    target,
    ...(providerResourceId ? { providerResourceId } : {}),
    ...(providerStatus ? { providerStatus } : {}),
    ...(message ? { message } : {}),
    createdAt: now(),
    updatedAt: now(),
  };
}

function access(connectionId: string, publicFields: Record<string, string>, secrets: Record<string, string>): ProviderAccess {
  if (!secrets.apiToken) throw new AppError("Reconnect Railway before deploying.", 409, "CONNECTION_RECONNECT_REQUIRED");
  return { provider: "railway", publicFields: { ...publicFields, connectionId }, secrets };
}

function graphqlServiceTransport(provider: ProviderAccess) {
  return {
    async patchEnvironment(input: { environmentId: string; patch: { services: Record<string, RailwayServiceConfigPatch> }; skipDeploys: boolean; idempotencyKey?: string }) {
      return railwayQuery(provider, `mutation($environment: String!, $patch: JSON!, $skipDeploys: Boolean!) { environmentPatchCommit(environmentId: $environment, patch: $patch, skipDeploys: $skipDeploys) { id } }`, { environment: input.environmentId, patch: input.patch, skipDeploys: input.skipDeploys });
    },
    async deployService(input: { serviceId: string; environmentId: string; idempotencyKey?: string }) {
      const result = await railwayQuery<{ serviceInstanceDeployV2: string }>(provider, `mutation($service: String!, $environment: String!) { serviceInstanceDeployV2(serviceId: $service, environmentId: $environment) }`, { service: input.serviceId, environment: input.environmentId });
      return result.serviceInstanceDeployV2;
    },
    async getDeployment(id: string) {
      const result = await railwayQuery<{ deployment: { id: string; status?: unknown; deploymentStopped?: boolean; meta?: Record<string, unknown> | null } }>(provider, `query($id: String!) { deployment(id: $id) { id status deploymentStopped meta } }`, { id });
      return result.deployment;
    },
    async getService(input: RailwayServiceTarget) {
      const result = await railwayQuery<{ environment: { serviceInstances: { edges: Array<{ node: Record<string, unknown> }> } } }>(provider, `query($project: String!, $environment: String!) { environment(id: $environment, projectId: $project) { serviceInstances(first: 100) { edges { node { id serviceId serviceName source { image repo } activeDeployments { id status deploymentStopped meta } domains { serviceDomains { domain targetPort } customDomains { domain targetPort } } } } } } }`, { project: input.projectId, environment: input.environmentId });
      const row = result.environment.serviceInstances.edges.map((edge) => edge.node).find((node) => node.serviceId === input.serviceId || node.id === input.serviceId);
      return row ? { id: String(row.id), serviceId: String(row.serviceId ?? input.serviceId), serviceName: String(row.serviceName ?? input.serviceId), source: rec(row.source) as { image?: string | null; repo?: string | null }, activeDeployments: Array.isArray(row.activeDeployments) ? row.activeDeployments as never[] : [] } : null;
    },
    async stopDeployment(input: { deploymentId: string; cancel?: boolean }) { await railwayQuery(provider, `mutation($id: String!) { ${input.cancel ? "deploymentCancel" : "deploymentStop"}(id: $id) }`, { id: input.deploymentId }); return true; },
    async redeploy(input: { deploymentId: string; usePreviousImageTag?: boolean }) { const result = await railwayQuery<{ deploymentRedeploy: { id: string } }>(provider, `mutation($id: String!, $previous: Boolean) { deploymentRedeploy(id: $id, usePreviousImageTag: $previous) { id } }`, { id: input.deploymentId, previous: input.usePreviousImageTag ?? false }); return result.deploymentRedeploy.id; },
  };
}

function graphqlSandboxTransport(provider: ProviderAccess) {
  return {
    async create(input: RailwaySandboxCreateInput): Promise<RailwaySandboxRecord> {
      const result = await railwayQuery<{ sandboxCreate: RailwaySandboxRecord }>(provider, `mutation($input: SandboxCreateInput!) { sandboxCreate(input: $input) { id status state projectId environmentId region networkIsolation idleTimeoutMinutes domains { prefix port domain } checkpointId createdAt updatedAt } }`, { input: { ...input, environmentId: input.target.environmentId, projectId: input.target.projectId, publicDomains: input.domains } });
      return result.sandboxCreate;
    },
    async list(target: Omit<RailwaySandboxTarget, "sandboxId">) { const result = await railwayQuery<{ sandboxes: RailwaySandboxRecord[] }>(provider, `query($environment: String!, $project: String!) { sandboxes(environmentId: $environment, projectId: $project) { id status state projectId environmentId region networkIsolation idleTimeoutMinutes domains { prefix port domain } checkpointId createdAt updatedAt } }`, { environment: target.environmentId, project: target.projectId }); return result.sandboxes ?? []; },
    async get(target: RailwaySandboxTarget & { sandboxId: string }) { const result = await railwayQuery<{ sandbox: RailwaySandboxRecord }>(provider, `query($id: String!) { sandbox(id: $id) { id status state projectId environmentId region networkIsolation idleTimeoutMinutes domains { prefix port domain } checkpointId createdAt updatedAt } }`, { id: target.sandboxId }); return result.sandbox; },
    async exec() { throw new AppError("Railway Sandbox exec requires the Railway SDK transport; configure an SDK worker for command/session operations.", 501, "EXTERNAL_CAPABILITY_UNSUPPORTED"); },
    async stop() { throw new AppError("Railway Sandbox stop is unavailable through the GraphQL fallback transport.", 501, "EXTERNAL_CAPABILITY_UNSUPPORTED"); },
    async destroy(sandboxId: string) { await railwayQuery(provider, `mutation($id: String!) { sandboxDelete(id: $id) }`, { id: sandboxId }); return true; },
    async checkpoint() { throw new AppError("Railway Sandbox checkpoints require the Railway SDK transport.", 501, "EXTERNAL_CAPABILITY_UNSUPPORTED"); },
    async fork() { throw new AppError("Railway Sandbox forks require the Railway SDK transport.", 501, "EXTERNAL_CAPABILITY_UNSUPPORTED"); },
  };
}

export function createRailwayExternalAdapter(resolve: RailwayCredentialResolver): ExternalProviderAdapter {
  return {
    provider: "railway",
    workloads: WORKLOADS,
    async capabilities(_context, target) { return profile(target, target.workloadKind === "service" ? SERVICE_CAPS : SANDBOX_CAPS); },
    async preflight(context, target): Promise<ExternalPlan> {
      const credential = await resolve(context, target.connectionId);
      const provider = access(target.connectionId, credential.publicFields, credential.secrets);
      if (target.workloadKind === "service") {
        const service = createRailwayServiceAdapter(graphqlServiceTransport(provider));
        await service.discover({ projectId: String(target.resource.projectId ?? ""), environmentId: String(target.resource.environmentId ?? ""), serviceId: String(target.resource.serviceId ?? target.resource.id ?? "") });
      }
      const capability = profile(target, target.workloadKind === "service" ? SERVICE_CAPS : SANDBOX_CAPS);
      return { planId: `railway-plan:${target.connectionId}`, target: snap(context, target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async plan(context, input) { const capability = profile(input.target, input.target.workloadKind === "service" ? SERVICE_CAPS : SANDBOX_CAPS); return { planId: `railway-plan:${input.idempotencyKey}`, target: snap(context, input.target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! }; },
    async apply(context, input, plan) {
      const credential = await resolve(context, plan.target.connectionId);
      const provider = access(plan.target.connectionId, credential.publicFields, credential.secrets);
      if (plan.target.workloadKind === "service") {
        const target: RailwayServiceTarget = { projectId: String(plan.target.resource.projectId ?? ""), environmentId: String(plan.target.resource.environmentId ?? ""), serviceId: String(plan.target.resource.serviceId ?? plan.target.resource.id ?? "") };
        const request = plan as ExternalPlan & { source?: unknown; image?: string; environment?: Record<string, string> };
        const service = createRailwayServiceAdapter(graphqlServiceTransport(provider));
        const source = rec(request.source);
        const sourcePatch = Object.fromEntries(
          Object.entries(source).filter(([key, value]) =>
            (key === "image" || key === "repo") && typeof value === "string" && value.length > 0,
          ),
        );
        const result = await service.apply({ target, deploy: true, idempotencyKey: input.idempotencyKey, patch: { source: { ...sourcePatch, ...(typeof request.image === "string" ? { image: request.image } : {}) }, variables: request.environment } });
        return operation(plan.target, result.status === "ready" ? "ready" : result.status === "failed" ? "failed" : "provisioning", result.deploymentId ?? undefined, result.providerStatus);
      }
      const sandbox = createRailwaySandboxAdapter(graphqlSandboxTransport(provider));
      const result = await sandbox.create({ target: { projectId: String(plan.target.resource.projectId ?? ""), environmentId: String(plan.target.resource.environmentId ?? "") }, name: str(plan.target.resource.name), region: str(plan.target.resource.region), resources: rec(plan.target.resource.resources) as never, networkIsolation: str(plan.target.resource.networkIsolation) as never, idleTimeoutMinutes: typeof plan.target.resource.idleTimeoutMinutes === "string" ? Number(plan.target.resource.idleTimeoutMinutes) : undefined, idempotencyKey: input.idempotencyKey });
      return operation(plan.target, result.status === "running" ? "ready" : result.status === "failed" ? "failed" : "provisioning", result.id);
    },
    async observe(context, input: ExternalObserveInput) {
      const credential = await resolve(context, input.target.connectionId);
      const provider = access(input.target.connectionId, credential.publicFields, credential.secrets);
      if (input.target.workloadKind === "service") {
        const service = createRailwayServiceAdapter(graphqlServiceTransport(provider));
        const target: RailwayServiceTarget = { projectId: String(input.target.resource.projectId ?? ""), environmentId: String(input.target.resource.environmentId ?? ""), serviceId: String(input.target.resource.serviceId ?? input.target.resource.id ?? "") };
        const deploymentId = String(input.target.resource.deploymentId ?? input.target.resource.id ?? "");
        const result = await service.observe(target, deploymentId);
        return operation(snap(context, input.target), result.status === "ready" ? "ready" : result.status === "failed" ? "failed" : result.status === "stopped" ? "stopped" : "provisioning", result.deploymentId ?? undefined, result.providerStatus);
      }
      const sandbox = createRailwaySandboxAdapter(graphqlSandboxTransport(provider));
      const row = await sandbox.observe({ projectId: String(input.target.resource.projectId ?? ""), environmentId: String(input.target.resource.environmentId ?? ""), sandboxId: String(input.target.resource.sandboxId ?? input.target.resource.id ?? "") });
      return operation(snap(context, input.target), row.status === "running" ? "ready" : row.status === "failed" ? "failed" : row.status === "stopped" ? "stopped" : "provisioning", row.id, String(row.status));
    },
    async destroy(context, externalOperation) {
      if (externalOperation.workloadKind !== "railway-sandbox")
        throw new AppError("Railway service deletion is not exposed by the external deployment adapter.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      const credential = await resolve(context, externalOperation.target.connectionId);
      const provider = access(externalOperation.target.connectionId, credential.publicFields, credential.secrets);
      const sandbox = createRailwaySandboxAdapter(graphqlSandboxTransport(provider));
      const id = String(externalOperation.providerResourceId ?? externalOperation.target.resource.sandboxId ?? externalOperation.target.resource.id ?? "");
      if (!id) throw new AppError("Railway Sandbox id is required to destroy this target.", 400, "EXTERNAL_TARGET_INVALID");
      await sandbox.destroy(id);
      return { ...externalOperation, status: "stopped", providerResourceId: id, updatedAt: now() };
    },
  };
}

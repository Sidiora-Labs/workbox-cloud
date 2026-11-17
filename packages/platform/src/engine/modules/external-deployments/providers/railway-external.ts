import { AppError } from "@repo/core";
import type {
  ExternalCapabilityName,
  ExternalCapabilityProfile,
  ExternalOperation,
  ExternalPlan,
  ExternalTargetInput,
  ExternalTargetSnapshot,
  ExternalWorkloadKind,
  ExternalObserveInput,
} from "@repo/contracts";
import type { ExternalProviderAdapter, ExternalProviderContext } from "../../../../external-deployments";
import { railwayQuery, type ProviderAccess } from "../../credentials/provider-api";
import { createRailwayTemplateAdapter } from "./railway-template";
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
const SERVICE_CAPS: readonly ExternalCapabilityName[] = ["discover", "preflight", "apply", "observe", "public-ingress"];
// Native sandbox VMs use the same documented GraphQL operations as railway@3.17.0.
// HTTP exec is bounded; interactive sessions and files are not exposed here.
const SANDBOX_CAPS: readonly ExternalCapabilityName[] = ["discover", "preflight", "apply", "observe", "exec", "destroy", "public-ingress", "private-network", "idle-policy"];
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
    unsupported: allCaps.filter((capability) => !supported.includes(capability)).map((capability) => ({ capability, reason: "This integration does not yet expose this operation for the selected Railway workload." })),
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
      return railwayQuery(provider, `mutation($environment: String!, $patch: EnvironmentConfig!, $skipDeploys: Boolean!) { environmentPatchCommit(environmentId: $environment, patch: $patch, skipDeploys: $skipDeploys) }`, { environment: input.environmentId, patch: { services: Object.fromEntries(Object.entries(input.patch.services).map(([id, patch]) => [id, railwayConfigPatch(patch)])) }, skipDeploys: input.skipDeploys });
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
      return row ? { id: String(row.id), serviceId: String(row.serviceId ?? input.serviceId), serviceName: String(row.serviceName ?? input.serviceId), source: rec(row.source) as { image?: string | null; repo?: string | null }, activeDeployments: Array.isArray(row.activeDeployments) ? row.activeDeployments as never[] : [], domains: row.domains as never } : null;
    },
    async stopDeployment(input: { deploymentId: string; cancel?: boolean }) { await railwayQuery(provider, `mutation($id: String!) { ${input.cancel ? "deploymentCancel" : "deploymentStop"}(id: $id) }`, { id: input.deploymentId }); return true; },
    async redeploy(input: { deploymentId: string; usePreviousImageTag?: boolean }) { const result = await railwayQuery<{ deploymentRedeploy: { id: string } }>(provider, `mutation($id: String!, $previous: Boolean) { deploymentRedeploy(id: $id, usePreviousImageTag: $previous) { id } }`, { id: input.deploymentId, previous: input.usePreviousImageTag ?? false }); return result.deploymentRedeploy.id; },
  };
}

// These fields and argument names are verified against the official SDK's
// src/graphql/operations/sandbox.graphql, commit 068bd894b1de05cfb3c935d83fede597cd12723d.
const SANDBOX_FIELDS = "id status environmentId region networkIsolation idleTimeoutMinutes domains { prefix port domain } createdAt";

export function graphqlSandboxTransport(provider: ProviderAccess, environmentId: string) {
  return {
    async create(input: RailwaySandboxCreateInput): Promise<RailwaySandboxRecord> {
      const result = await railwayQuery<{ sandboxCreate: RailwaySandboxRecord }>(provider,
        `mutation($input: SandboxCreateInput!) { sandboxCreate(input: $input) { ${SANDBOX_FIELDS} } }`,
        { input: {
          environmentId: input.target.environmentId,
          ...(input.region ? { region: input.region } : {}),
          ...(input.resources ? { resources: input.resources } : {}),
          ...(input.networkIsolation ? { networkIsolation: input.networkIsolation } : {}),
          ...(input.idleTimeoutMinutes != null ? { idleTimeoutMinutes: input.idleTimeoutMinutes } : {}),
          ...(input.env ? { variables: input.env } : {}),
          ...(input.domains?.length ? { publicDomains: input.domains } : {}),
        } });
      return result.sandboxCreate;
    },
    async list(target: Omit<RailwaySandboxTarget, "sandboxId">) {
      const result = await railwayQuery<{ sandboxes: { edges: { node: RailwaySandboxRecord }[] } }>(provider,
        `query($environment: String!) { sandboxes(environmentId: $environment, first: 100) { edges { node { ${SANDBOX_FIELDS} } } } }`, { environment: target.environmentId });
      return result.sandboxes.edges.map(({ node }) => node);
    },
    async get(target: RailwaySandboxTarget & { sandboxId: string }) {
      const result = await railwayQuery<{ sandbox: RailwaySandboxRecord }>(provider,
        `query($id: String!, $environment: String!) { sandbox(id: $id, environmentId: $environment) { ${SANDBOX_FIELDS} } }`, { id: target.sandboxId, environment: target.environmentId });
      return result.sandbox;
    },
    async exec(input: { sandboxId: string; command: string | readonly string[]; cwd?: string; timeoutMs?: number }) {
      const command = Array.isArray(input.command) ? input.command.map(shellQuote).join(" ") : String(input.command);
      const result = await railwayQuery<{ sandboxExec: { stdout: string; stderr: string; exitCode: number; truncated: boolean; timedOut: boolean } }>(provider,
        `mutation($id: String!, $environment: String!, $command: String!, $timeout: Int) { sandboxExec(id: $id, environmentId: $environment, command: $command, timeoutSec: $timeout) { stdout stderr exitCode truncated timedOut } }`,
        { id: input.sandboxId, environment: environmentId, command: input.cwd ? `cd ${shellQuote(input.cwd)} && ${command}` : command, timeout: Math.min(600, Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000))) });
      return result.sandboxExec;
    },
    async stop() { throw new AppError("Native Railway sandboxes are destroyed on idle expiry. Use destroy to release this VM.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED"); },
    async destroy(sandboxId: string) {
      await railwayQuery(provider, `mutation($id: String!, $environment: String!) { sandboxDestroy(id: $id, environmentId: $environment) { id } }`, { id: sandboxId, environment: environmentId });
      return true;
    },
    async checkpoint() { throw new AppError("Railway Sandbox checkpoints are not exposed by this control plane.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED"); },
    async fork() { throw new AppError("Railway Sandbox forks are not exposed by this control plane.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED"); },
  };
}

function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** EnvironmentConfig has nested build/deploy settings and variable objects. */
export function railwayConfigPatch(patch: RailwayServiceConfigPatch): Record<string, unknown> {
  const { source, variables, buildCommand, startCommand, restartPolicyType, restartPolicyMaxRetries, healthcheckPath, healthcheckTimeout, cronSchedule, sleepApplication } = patch;
  const { dockerfilePath, ...sourceConfig } = source ?? {};
  const build = Object.fromEntries(Object.entries({ buildCommand, dockerfilePath }).filter(([, value]) => value !== undefined));
  const deploy = Object.fromEntries(Object.entries({ startCommand, restartPolicyType, restartPolicyMaxRetries, healthcheckPath, healthcheckTimeout, cronSchedule, sleepApplication }).filter(([, value]) => value !== undefined));
  return {
    ...(source ? { source: { ...sourceConfig, ...(source.image ? { repo: null } : source.repo ? { image: null } : {}) } } : {}),
    ...(variables ? { variables: Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, value === null ? null : { value }])) } : {}),
    ...(Object.keys(build).length ? { build } : {}),
    ...(Object.keys(deploy).length ? { deploy } : {}),
  };
}

function parsedRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return rec(JSON.parse(value)); } catch { return {}; } }
  return rec(value);
}

function ports(value: unknown): number[] {
  const raw = typeof value === "string" ? value.split(",").filter((item) => item.trim()).map(Number) : [];
  if (raw.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new AppError("Ports must be between 1 and 65535.", 400, "EXTERNAL_TARGET_INVALID");
  return [...new Set(raw)];
}

async function validateTarget(provider: ProviderAccess, target: ExternalTargetInput): Promise<string[]> {
  const { projectId, environmentId, serviceId, name } = target.resource;
  const blockers: string[] = [];
  if (!projectId || !environmentId) return ["Select a Railway project and environment."];
  const result = await railwayQuery<{ project?: { workspaceId?: string }; environment: { id: string; projectId: string; unmergedChangesCount: number; serviceInstances: { edges: { node: { serviceId: string } }[] } } }>(provider,
    `query($environment: String!, $project: String!) { environment(id: $environment, projectId: $project) { id projectId unmergedChangesCount serviceInstances(first: 100) { edges { node { serviceId } } } } project(id: $project) { workspaceId } }`, { environment: environmentId, project: projectId });
  if (!result.environment || result.environment.projectId !== projectId) return ["The environment does not belong to the selected Railway project."];
  const expectedWorkspace = provider.publicFields.workspaceId ?? target.providerIdentity.workspaceId;
  if (expectedWorkspace && result.project?.workspaceId !== expectedWorkspace) return ["The project does not belong to the selected Railway workspace."];
  if (target.workloadKind === "service") {
    if (result.environment.unmergedChangesCount > 0) blockers.push("Resolve staged Railway changes before deploying from Workbox Cloud.");
    if (serviceId && !result.environment.serviceInstances.edges.some(({ node }) => node.serviceId === serviceId)) blockers.push("The selected service does not belong to this Railway environment.");
    if (!serviceId && !name) blockers.push("Name the new Railway service.");
    if (target.resource.port && (!Number.isInteger(Number(target.resource.port)) || Number(target.resource.port) < 1 || Number(target.resource.port) > 65535)) blockers.push("Application port must be between 1 and 65535.");
  } else {
    if (target.resource.networkIsolation && !["ISOLATED", "PRIVATE"].includes(target.resource.networkIsolation)) blockers.push("Choose Isolated or Private sandbox networking.");
    const requestedPorts = ports(target.resource.ports);
    if (requestedPorts.length > 10) blockers.push("Railway sandboxes allow at most 10 public ports.");
    if (requestedPorts.length && target.resource.networkIsolation !== "PRIVATE") blockers.push("Public sandbox ports require Private networking.");
    const idle = target.resource.idleTimeoutMinutes;
    if (idle && (!Number.isInteger(Number(idle)) || Number(idle) < 0)) blockers.push("Idle timeout must be a whole number of minutes, zero means no expiry when the plan permits it.");
    for (const key of ["cpu", "memoryGB"]) if (target.resource[key] && (!Number.isFinite(Number(target.resource[key])) || Number(target.resource[key]) <= 0)) blockers.push(`${key} must be a positive number.`);
  }
  return blockers;
}

export function createRailwayExternalAdapter(resolve: RailwayCredentialResolver): ExternalProviderAdapter {
  const templates = createRailwayTemplateAdapter(resolve);
  return {
    provider: "railway",
    workloads: WORKLOADS,
    async capabilities(_context, target) { return target.resource.appTemplateId ? templates.capabilities(_context, target) : profile(target, target.workloadKind === "service" ? SERVICE_CAPS : SANDBOX_CAPS); },
    async preflight(context, target): Promise<ExternalPlan> {
      if (target.resource.appTemplateId) return templates.preflight(context, target);
      const credential = await resolve(context, target.connectionId);
      const provider = access(target.connectionId, credential.publicFields, credential.secrets);
      const blockers = await validateTarget(provider, target);
      const capability = profile(target, target.workloadKind === "service" ? SERVICE_CAPS : SANDBOX_CAPS);
      return { planId: `railway-plan:${target.connectionId}`, target: snap(context, target), capability, accepted: blockers.length === 0, blockers, warnings: [], expiresAt: capability.expiresAt! };
    },
    async plan(context, input) {
      if (input.target.resource.appTemplateId) return templates.plan(context, input);
      const credential = await resolve(context, input.target.connectionId);
      const blockers = await validateTarget(access(input.target.connectionId, credential.publicFields, credential.secrets), input.target);
      const capability = profile(input.target, input.target.workloadKind === "service" ? SERVICE_CAPS : SANDBOX_CAPS);
      if (input.target.workloadKind === "service" && !input.target.resource.serviceId && !input.image && !input.source?.repo) blockers.push("Choose a container image or GitHub repository for the new service.");
      if (input.target.workloadKind === "railway-sandbox" && (input.image || input.source?.repo)) blockers.push("Native Railway sandboxes use Railway's VM environment. Choose an empty sandbox, then use Run command to install or clone your workload.");
      const requestedSource: Record<string, string> = { ...(input.source ?? {}), ...(input.image ? { image: input.image } : {}) };
      if (requestedSource.image && requestedSource.repo) blockers.push("Choose either a repository or a container image.");
      return { planId: `railway-plan:${input.idempotencyKey}`, target: snap(context, input.target), capability, accepted: blockers.length === 0, blockers, warnings: [], expiresAt: capability.expiresAt! };
    },
    async apply(context, input, plan) {
      if (plan.target.resource.appTemplateId) return templates.apply(context, input, plan);
      const credential = await resolve(context, plan.target.connectionId);
      const provider = access(plan.target.connectionId, credential.publicFields, credential.secrets);
      const request = plan as ExternalPlan & { source?: Record<string, string>; image?: string; environment?: Record<string, string>; workload?: Record<string, string> };
      const blockers = await validateTarget(provider, plan.target);
      if (blockers.length) throw new AppError(blockers.join(" "), 409, "EXTERNAL_TARGET_INVALID");
      if (plan.target.workloadKind === "service") {
        const source = { ...(request.source ?? {}), ...(request.image ? { image: request.image } : {}) };
        let serviceId = str(plan.target.resource.serviceId);
        if (!serviceId) {
          const created = await railwayQuery<{ serviceCreate: { id: string } }>(provider,
            `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
            { input: { projectId: plan.target.resource.projectId, environmentId: plan.target.resource.environmentId, name: plan.target.resource.name } });
          serviceId = created.serviceCreate.id;
        }
        const target: RailwayServiceTarget = { projectId: plan.target.resource.projectId!, environmentId: plan.target.resource.environmentId!, serviceId };
        const service = createRailwayServiceAdapter(graphqlServiceTransport(provider));
        const workload = request.workload ?? {};
        const patch: RailwayServiceConfigPatch = {
          ...(Object.keys(source).length ? { source: Object.fromEntries(Object.entries(source).filter(([key]) => ["image", "repo", "branch", "rootDirectory", "dockerfilePath"].includes(key))) } : {}),
          ...(request.environment ? { variables: request.environment } : {}),
          ...(workload.startCommand ? { startCommand: workload.startCommand } : {}),
          ...(workload.buildCommand ? { buildCommand: workload.buildCommand } : {}),
          ...(workload.healthcheckPath ? { healthcheckPath: workload.healthcheckPath } : {}),
        };
        let deploymentId: string | undefined;
        try {
          const result = await service.apply({ target, deploy: true, idempotencyKey: input.idempotencyKey, patch });
          deploymentId = result.deploymentId ?? undefined;
          let domain: string | undefined;
          const port = Number(workload.port ?? plan.target.resource.port);
          if (Number.isInteger(port) && port >= 1 && port <= 65535) {
            const instance = await service.discover(target);
            const existing = instance?.domains?.serviceDomains?.find((item) => item.targetPort === port);
            if (existing) domain = existing.domain;
            else {
              const created = await railwayQuery<{ serviceDomainCreate: { domain: string } }>(provider,
                `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`, { input: { serviceId, environmentId: target.environmentId, targetPort: port } });
              domain = created.serviceDomainCreate.domain;
            }
          }
          return operation({ ...plan.target, resource: { ...plan.target.resource, serviceId, ...(result.deploymentId ? { deploymentId: result.deploymentId } : {}) } }, result.status === "ready" ? "ready" : result.status === "failed" ? "failed" : "provisioning", result.deploymentId ?? undefined, result.providerStatus, domain ? `https://${domain}` : undefined);
        } catch {
          // Preserve the created resource even when a later stage cannot be confirmed.
          // Retrying creation would otherwise duplicate a paid service.
          return operation({ ...plan.target, resource: { ...plan.target.resource, serviceId, ...(deploymentId ? { deploymentId } : {}) } }, "action_required", deploymentId, "PARTIAL_CONFIGURATION", "The Railway service exists, but configuration or deployment could not be confirmed. Inspect the service before deploying again.");
        }
      }
      const resource = plan.target.resource;
      const sandbox = createRailwaySandboxAdapter(graphqlSandboxTransport(provider, resource.environmentId!));
      const requestedResources = parsedRecord(resource.resources);
      const cpu = Number(resource.cpu ?? requestedResources.cpu);
      const memoryGB = Number(resource.memoryGB ?? requestedResources.memoryGB);
      const result = await sandbox.create({
        target: { projectId: resource.projectId!, environmentId: resource.environmentId! },
        name: str(resource.name), region: str(resource.region),
        resources: { ...(Number.isFinite(cpu) ? { cpu } : {}), ...(Number.isFinite(memoryGB) ? { memoryGB } : {}) },
        networkIsolation: str(resource.networkIsolation) as "PRIVATE" | "ISOLATED" | undefined,
        idleTimeoutMinutes: resource.idleTimeoutMinutes ? Number(resource.idleTimeoutMinutes) : undefined,
        env: request.environment,
        domains: ports(resource.ports).map((port) => ({ port })),
        idempotencyKey: input.idempotencyKey,
      });
      return operation({ ...plan.target, resource: { ...resource, sandboxId: result.id } }, result.status === "running" ? "ready" : result.status === "failed" ? "failed" : "provisioning", result.id, result.status, result.domains[0] ? `https://${result.domains[0].domain}` : undefined);
    },
    async observe(context, input: ExternalObserveInput) {
      if (input.target.resource.appTemplateId) return templates.observe(context, input);
      const credential = await resolve(context, input.target.connectionId);
      const provider = access(input.target.connectionId, credential.publicFields, credential.secrets);
      if (input.target.workloadKind === "service") {
        const service = createRailwayServiceAdapter(graphqlServiceTransport(provider));
        const target: RailwayServiceTarget = { projectId: String(input.target.resource.projectId ?? ""), environmentId: String(input.target.resource.environmentId ?? ""), serviceId: String(input.target.resource.serviceId ?? input.target.resource.id ?? "") };
        const deploymentId = str(input.target.resource.deploymentId);
        if (!deploymentId) {
          const current = await service.discover(target);
          const active = current?.activeDeployments?.find((deployment) => !deployment.deploymentStopped);
          if (!active) return operation(snap(context, input.target), "action_required", undefined, "NO_DEPLOYMENT", "The Railway service exists without a confirmed active deployment. Review its configuration before deploying again.");
          const result = await service.observe(target, active.id);
          return operation({ ...snap(context, input.target), resource: { ...input.target.resource, deploymentId: active.id } }, result.status === "ready" ? "ready" : result.status === "failed" ? "failed" : "provisioning", active.id, result.providerStatus);
        }
        const result = await service.observe(target, deploymentId);
        return operation(snap(context, input.target), result.status === "ready" ? "ready" : result.status === "failed" ? "failed" : result.status === "stopped" ? "stopped" : "provisioning", result.deploymentId ?? undefined, result.providerStatus);
      }
      const sandbox = createRailwaySandboxAdapter(graphqlSandboxTransport(provider, String(input.target.resource.environmentId ?? "")));
      const row = await sandbox.observe({ projectId: String(input.target.resource.projectId ?? ""), environmentId: String(input.target.resource.environmentId ?? ""), sandboxId: String(input.target.resource.sandboxId ?? input.target.resource.id ?? "") });
      return operation(snap(context, input.target), row.status === "running" ? "ready" : row.status === "failed" ? "failed" : ["stopped", "destroyed"].includes(row.status) ? "stopped" : "provisioning", row.id, String(row.status));
    },
    async exec(context, externalOperation, input) {
      if (externalOperation.workloadKind !== "railway-sandbox") throw new AppError("Run command is only available for Railway sandboxes.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      const credential = await resolve(context, externalOperation.target.connectionId);
      const provider = access(externalOperation.target.connectionId, credential.publicFields, credential.secrets);
      const transport = graphqlSandboxTransport(provider, externalOperation.target.resource.environmentId!);
      const sandboxId = externalOperation.providerResourceId ?? externalOperation.target.resource.sandboxId;
      if (!sandboxId) throw new AppError("A Railway sandbox id is required.", 400, "EXTERNAL_TARGET_INVALID");
      const argv = input.env ? ["env", ...Object.entries(input.env).map(([key, value]) => `${key}=${value}`), ...input.argv] : input.argv;
      const result = await transport.exec({ sandboxId, command: argv, cwd: input.cwd });
      return { operation: externalOperation, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    async destroy(context, externalOperation) {
      if (externalOperation.target.resource.appTemplateId) return templates.destroy!(context, externalOperation);
      if (externalOperation.workloadKind !== "railway-sandbox")
        throw new AppError("Railway service deletion is not exposed by the external deployment adapter.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      const credential = await resolve(context, externalOperation.target.connectionId);
      const provider = access(externalOperation.target.connectionId, credential.publicFields, credential.secrets);
      const sandbox = createRailwaySandboxAdapter(graphqlSandboxTransport(provider, String(externalOperation.target.resource.environmentId ?? "")));
      const id = String(externalOperation.providerResourceId ?? externalOperation.target.resource.sandboxId ?? externalOperation.target.resource.id ?? "");
      if (!id) throw new AppError("Railway Sandbox id is required to destroy this target.", 400, "EXTERNAL_TARGET_INVALID");
      await sandbox.destroy(id);
      return { ...externalOperation, status: "stopped", providerResourceId: id, updatedAt: now() };
    },
    async *logs(context, externalOperation, options) {
      if (!externalOperation.target.resource.appTemplateId) throw new AppError("Logs are not exposed for this Railway workload.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      yield* templates.logs!(context, externalOperation, options);
    },
    async reconcile(context, externalOperation) {
      if (externalOperation.target.resource.appTemplateId) return templates.reconcile!(context, externalOperation);
      return this.observe(context, { target: externalOperation.target, operationId: externalOperation.id });
    },
  };
}

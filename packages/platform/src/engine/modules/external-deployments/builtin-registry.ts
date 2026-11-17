import { AppError } from "@repo/core";
import type {
  ExternalCapabilityName,
  ExternalCapabilityProfile,
  ExternalOperation,
  ExternalOperationStatus,
  ExternalPlan,
  ExternalPlanInput,
  ExternalProvider,
  ExternalTargetInput,
  ExternalTargetSnapshot,
  ExternalWorkloadKind,
} from "@repo/contracts";
import {
  ExternalProviderRegistry,
  type ExternalProviderAdapter,
  type ExternalProviderContext,
} from "../../../external-deployments";
import {
  createVercelApiClient,
  createVercelProjectProvider,
  type VercelDeploymentObservation,
} from "./providers/vercel";
import { FlyMachinesClient, FlySpritesClient, normalizeFlyStatus, type NormalizedFlyStatus } from "./providers/fly";
import { createWorkboxProvider } from "./providers/workbox";
import { createWorkboxExternalAdapter } from "./providers/workbox-external";
import { createRailwayExternalAdapter } from "./providers/railway-external";
import { env } from "../../config/env";
import { Sandbox } from "@vercel/sandbox";
import { createBlaxelExternalAdapter } from "./providers/blaxel";
import { createVercelTemplateAdapter, isVercelTemplateTarget } from "./providers/vercel-template";

export interface BuiltinCredential {
  readonly id: string;
  readonly publicFields: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

export type BuiltinCredentialResolver = (
  context: ExternalProviderContext,
  connectionId: string,
  provider: ExternalProvider,
) => Promise<BuiltinCredential>;

const CAPABILITIES: Record<ExternalWorkloadKind, readonly ExternalCapabilityName[]> = {
  service: ["discover", "preflight", "apply", "observe"],
  "vercel-sandbox": ["discover", "preflight", "apply", "observe", "exec", "destroy", "public-ingress", "private-network", "persistent-storage", "idle-policy"],
  "railway-sandbox": [],
  "blaxel-sandbox": ["discover", "preflight", "apply", "observe", "exec", "destroy", "persistent-storage", "idle-policy"],
  "fly-machine": ["discover", "preflight", "apply", "observe", "destroy", "public-ingress", "persistent-storage", "private-network"],
  "fly-sprite": ["discover", "preflight", "apply", "observe", "exec", "destroy", "public-ingress", "persistent-storage", "private-network"],
  "self-managed-server": [],
  "workbox-host": ["discover", "preflight", "apply", "observe", "logs", "destroy", "reconcile", "public-ingress"],
  "workbox-sandbox": ["discover", "preflight", "apply", "observe", "logs", "exec", "session", "files", "checkpoint", "snapshot", "stop", "resume", "destroy", "reconcile", "private-network"],
};

const iso = () => new Date().toISOString();
const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const jsonRecord = (value: unknown): Record<string, string> => {
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
      : {};
  } catch {
    return {};
  }
};

function parsedObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === "") return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* A validation error is returned without echoing user configuration. */ }
  throw new AppError(`${label} must be a JSON object.`, 400, "EXTERNAL_TARGET_INVALID");
}

type ExecutionPlan = ExternalPlan & Pick<ExternalPlanInput, "source" | "image" | "environment" | "workload">;

function profile(target: ExternalTargetInput, supported: readonly ExternalCapabilityName[]): ExternalCapabilityProfile {
  const all = new Set<ExternalCapabilityName>([
    "discover", "preflight", "apply", "observe", "logs", "exec", "session", "files", "snapshot", "checkpoint",
    "stop", "resume", "promote", "rollback", "destroy", "reconcile", "public-ingress", "persistent-storage",
    "shared-storage", "private-network", "idle-policy",
  ]);
  const unsupported = [...all].filter((name) => !supported.includes(name)).map((capability) => ({
    capability,
    reason: "The configured provider client does not expose this capability for the selected workload.",
  }));
  return {
    provider: target.provider,
    workloadKind: target.workloadKind,
    checkedAt: iso(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    supported: [...supported],
    unsupported,
    limits: {},
    observedIdentity: target.providerIdentity,
  };
}

function operation(
  target: ExternalTargetSnapshot,
  kind: ExternalOperation["kind"],
  status: ExternalOperationStatus,
  resourceId?: string,
  providerStatus?: string,
  message?: string,
): ExternalOperation {
  return {
    id: `provider-${resourceId ?? kind}`,
    organizationId: target.organizationId,
    targetId: target.targetId,
    kind,
    workloadKind: target.workloadKind,
    status,
    idempotencyKey: `${kind}:${target.targetId}`,
    target,
    ...(resourceId ? { providerResourceId: resourceId } : {}),
    ...(providerStatus ? { providerStatus } : {}),
    ...(message ? { message } : {}),
    createdAt: iso(),
    updatedAt: iso(),
  };
}

function statusForFly(status: NormalizedFlyStatus): ExternalOperationStatus {
  if (status === "provisioning") return "provisioning";
  if (status === "running") return "running";
  if (status === "stopping") return "stopping";
  if (status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  if (status === "deleting") return "stopping";
  if (status === "queued") return "queued";
  return "unknown";
}

function statusForVercel(observation: VercelDeploymentObservation): ExternalOperationStatus {
  if (observation.status === "ready") return "ready";
  if (observation.status === "building" || observation.status === "queued") return "provisioning";
  if (observation.status === "failed") return "failed";
  if (observation.status === "canceled") return "stopped";
  return "unknown";
}

function snapshotFor(context: ExternalProviderContext, target: ExternalTargetInput): ExternalTargetSnapshot {
  return {
    targetId: String(target.resource.id ?? target.resource.name ?? target.connectionId),
    organizationId: context.organizationId,
    provider: target.provider,
    workloadKind: target.workloadKind,
    connectionId: target.connectionId,
    providerIdentity: target.providerIdentity,
    resource: Object.fromEntries(Object.entries(target.resource).map(([key, value]) => [key, String(value)])),
    capturedAt: iso(),
  };
}

function credentialField(credential: BuiltinCredential, key: string): string | undefined {
  return asString(credential.secrets[key]) ?? asString(credential.publicFields[key]);
}

function scopedIdentity(credential: BuiltinCredential, target: ExternalTargetInput | ExternalTargetSnapshot, key: string): string | undefined {
  const stored = asString(credential.publicFields[key]);
  const requested = asString(target.providerIdentity[key]);
  if (requested && requested !== stored) throw new AppError("The requested provider identity does not match the selected connection.", 403, "EXTERNAL_TARGET_SCOPE_DENIED");
  return stored;
}

function requireCredential(credential: BuiltinCredential, key: string, label: string): string {
  const value = credentialField(credential, key);
  if (!value) throw new AppError(`Reconnect ${label} before operating this target.`, 409, "CONNECTION_RECONNECT_REQUIRED");
  return value;
}

function vercelAdapter(resolve: BuiltinCredentialResolver): ExternalProviderAdapter {
  return {
    provider: "vercel",
    workloads: ["service"],
    async capabilities(_context, target) { return profile(target, CAPABILITIES.service); },
    async preflight(context, target) {
      await vercelProject(resolve, context, target);
      const capability = profile(target, CAPABILITIES.service);
      return { planId: `preflight:${target.connectionId}`, target: snapshotFor(context, target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async plan(context, input) {
      const capability = profile(input.target, CAPABILITIES.service);
      const blockers: string[] = [];
      if (input.image) blockers.push("Vercel project deployments use Git source, not container images. Choose Vercel Sandbox for VCR images.");
      if (Object.keys(input.environment ?? {}).length) blockers.push("Configure environment variables in the selected Vercel project before deploying. Deployment requests inherit project variables.");
      if (!blockers.length) await vercelDeploymentRequest(resolve, context, input.target, input);
      return { planId: `plan:${input.idempotencyKey}`, target: snapshotFor(context, input.target), capability, accepted: blockers.length === 0, blockers, warnings: [], expiresAt: capability.expiresAt! };
    },
    async apply(context, input, plan) {
      const target = plan.target;
      const { provider, body } = await vercelDeploymentRequest(resolve, context, target, plan as ExecutionPlan);
      const result = await provider.createDeployment({ ...body, meta: { openshipIdempotencyKey: input.idempotencyKey } });
      return operation(target, "apply", statusForVercel(result), result.resourceId, result.providerStatus ?? undefined, result.url ?? undefined);
    },
    async observe(context, input) {
      const target = input.target;
      const client = await vercelProject(resolve, context, target);
      const deploymentId = asString(target.resource.deploymentId) ?? asString(target.resource.id);
      if (!deploymentId) throw new AppError("A Vercel deployment id is required to observe this target.", 400, "EXTERNAL_TARGET_INVALID");
      const result = await client.getDeployment(deploymentId);
      return operation(snapshotFor(context, target), "observe", statusForVercel(result), result.resourceId, result.providerStatus ?? undefined, result.url ?? undefined);
    },
  };
}

async function vercelDeploymentRequest(resolve: BuiltinCredentialResolver, context: ExternalProviderContext, target: ExternalTargetInput | ExternalTargetSnapshot, request: Pick<ExternalPlanInput, "source">) {
  const provider = await vercelProject(resolve, context, target);
  const projectId = asString(target.resource.projectId) ?? asString(target.resource.projectName) ?? asString(target.resource.name)!;
  const project = record(await provider.getProject(projectId));
  const source = request.source ?? {};
  const body: Record<string, unknown> = { name: asString(project.name) ?? projectId };
  const deploymentId = asString(source.deploymentId) ?? asString(target.resource.deploymentId);
  if (deploymentId) {
    body.deploymentId = deploymentId;
    body.withLatestCommit = true;
  } else {
    const link = record(project.link);
    const type = asString(source.type) ?? asString(link.type) ?? "github";
    const repo = asString(source.repo);
    const ref = asString(source.ref) ?? asString(link.productionBranch) ?? "main";
    let gitSource: Record<string, unknown>;
    if (repo) {
      const normalized = repo.replace(/^https:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.(?:com|org)\//, "").replace(/\.git$/, "");
      const parts = normalized.split("/");
      if (parts.length !== 2 || !parts.every(Boolean)) throw new AppError("Enter a Git repository as owner/repository or a supported provider URL.", 400, "EXTERNAL_SOURCE_INVALID");
      gitSource = type === "github" ? { type, org: parts[0], repo: parts[1], ref }
        : type === "gitlab" ? { type, projectId: asString(source.repoId) ?? asString(link.projectId), ref }
        : type === "bitbucket" ? { type, owner: parts[0], slug: parts[1], ref }
        : {};
    } else if (type === "github" && (link.repoId || link.repo)) {
      gitSource = { type, ...(link.repoId ? { repoId: link.repoId } : { org: link.org, repo: link.repo }), ref };
    } else if (type === "gitlab" && link.projectId) gitSource = { type, projectId: link.projectId, ref };
    else if (type === "bitbucket" && (link.uuid || link.slug)) gitSource = { type, ...(link.uuid ? { uuid: link.uuid } : { owner: link.owner, slug: link.slug }), ref };
    else {
      const latest = record(Array.isArray(project.latestDeployments) ? project.latestDeployments[0] : undefined);
      if (!asString(latest.id)) throw new AppError("Select a Git-linked Vercel project, enter its repository, or provide an existing deployment to redeploy.", 400, "EXTERNAL_SOURCE_REQUIRED");
      body.deploymentId = latest.id;
      body.withLatestCommit = true;
      return { provider, body };
    }
    if (!Object.keys(gitSource).length || Object.values(gitSource).some(value => value === undefined)) throw new AppError("The selected Git provider requires its repository identifier.", 400, "EXTERNAL_SOURCE_INVALID");
    body.gitSource = gitSource;
  }
  if (asString(target.resource.deploymentTarget)) body.target = target.resource.deploymentTarget;
  return { provider, body };
}

async function vercelProject(resolve: BuiltinCredentialResolver, context: ExternalProviderContext, target: ExternalTargetInput | ExternalTargetSnapshot) {
  const credential = await resolve(context, target.connectionId, "vercel");
  const token = requireCredential(credential, "apiToken", "Vercel");
  const accountId = scopedIdentity(credential, target, "accountId") ?? "account";
  const teamId = scopedIdentity(credential, target, "teamId");
  const client = createVercelApiClient({ connectionId: target.connectionId, accountId, teamId }, token);
  const resource = target.resource;
  let projectId = asString(resource.projectId);
  const projectName = asString(resource.projectName) ?? asString(resource.name);
  const provider = createVercelProjectProvider(client, { connectionId: target.connectionId, accountId, teamId, projectId, projectName });
  if (!projectId && projectName) {
    const found = record(await provider.getProject(projectName));
    projectId = asString(found.id) ?? asString(found.uid);
  }
  if (!projectId) throw new AppError("A Vercel project id or name is required.", 400, "EXTERNAL_TARGET_INVALID");
  return createVercelProjectProvider(client, { connectionId: target.connectionId, accountId, teamId, projectId });
}

function vercelSandboxAdapter(resolve: BuiltinCredentialResolver): ExternalProviderAdapter {
  const sandboxFor = async (target: ExternalTargetSnapshot | ExternalTargetInput, credential: BuiltinCredential) => {
    const token = requireCredential(credential, "apiToken", "Vercel");
    const projectId = asString(target.resource.projectId) ?? asString(target.providerIdentity.projectId);
    const name = asString(target.resource.name) ?? asString(target.resource.id);
    if (!projectId || !name) throw new AppError("A Vercel Sandbox name and project are required.", 400, "EXTERNAL_TARGET_INVALID");
    const teamId = scopedIdentity(credential, target, "teamId");
    const params: Record<string, unknown> = { token, projectId, name, resume: false };
    if (!teamId) throw new AppError("A Vercel team is required for Sandbox operations.", 400, "EXTERNAL_TARGET_INVALID");
    params.teamId = teamId;
    return Sandbox.get(params as never);
  };
  return {
    provider: "vercel",
    workloads: ["vercel-sandbox"],
    async capabilities(_context, target) {
      return profile(target, CAPABILITIES["vercel-sandbox"]);
    },
    async preflight(context, target) {
      const credential = await resolve(context, target.connectionId, "vercel");
      requireCredential(credential, "apiToken", "Vercel");
      const projectId = asString(target.resource.projectId) ?? asString(target.providerIdentity.projectId);
      if (!projectId) throw new AppError("A Vercel project is required for Sandbox operations.", 400, "EXTERNAL_TARGET_INVALID");
      if (!(scopedIdentity(credential, target, "teamId"))) throw new AppError("A Vercel team is required for Sandbox operations.", 400, "EXTERNAL_TARGET_INVALID");
      const capability = profile(target, CAPABILITIES["vercel-sandbox"]);
      return { planId: `vercel-sandbox-preflight:${target.connectionId}`, target: snapshotFor(context, target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async plan(context, input) {
      const result = await this.preflight(context, input.target);
      const blockers = [...result.blockers];
      if (!asString(input.target.resource.name)) blockers.push("Give the Vercel Sandbox a name.");
      if ((input.image ?? input.target.resource.image) && input.target.resource.runtime) blockers.push("Choose an image or a legacy runtime, not both.");
      const ports = input.target.resource.ports?.split(",").map(value => Number(value.trim())) ?? [];
      if (ports.length > 15 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) blockers.push("Expose at most 15 valid ports.");
      return { ...result, planId: `vercel-sandbox-plan:${input.idempotencyKey}`, accepted: blockers.length === 0, blockers };
    },
    async apply(context, input, plan) {
      const credential = await resolve(context, plan.target.connectionId, "vercel");
      const token = requireCredential(credential, "apiToken", "Vercel");
      const projectId = asString(plan.target.resource.projectId) ?? asString(plan.target.providerIdentity.projectId);
      if (!projectId) throw new AppError("A Vercel project is required for Sandbox operations.", 400, "EXTERNAL_TARGET_INVALID");
      const resource = plan.target.resource;
      const requested = plan as ExecutionPlan;
      const teamId = scopedIdentity(credential, plan.target, "teamId");
      const params: Record<string, unknown> = {
        token,
        projectId,
        name: asString(resource.name),
        image: asString(requested.image ?? resource.image),
        runtime: asString(resource.runtime),
        region: asString(resource.region),
        persistent: resource.persistent !== "false",
        ports: asString(resource.ports)?.split(",").map((value) => Number(value.trim())).filter(Number.isFinite),
        env: requested.environment ?? (resource.environment ? jsonRecord(resource.environment) : undefined),
        source: requested.source?.repo ? { type: "git", url: requested.source.repo.includes("://") ? requested.source.repo : `https://github.com/${requested.source.repo}.git`, ...(requested.source.ref ? { revision: requested.source.ref } : {}) } : undefined,
        tags: resource.tags ? jsonRecord(resource.tags) : undefined,
        networkPolicy: resource.networkPolicy?.startsWith("{") ? parsedObject(resource.networkPolicy, "Network policy") : asString(resource.networkPolicy),
        networkId: asString(resource.networkId),
        resources: asString(resource.vcpus ?? resource.cpu) ? { vcpus: Number(resource.vcpus ?? resource.cpu) } : undefined,
        timeout: asString(resource.timeoutMs) ? Number(resource.timeoutMs) : undefined,
      };
      if (teamId) params.teamId = teamId;
      const sandbox = await Sandbox.create(params as never);
      const state = String(sandbox.status ?? "unknown").toLowerCase();
      const status: ExternalOperationStatus = state === "running" ? "ready" : ["pending", "snapshotting"].includes(state) ? "provisioning" : state === "stopped" ? "stopped" : state === "failed" ? "failed" : "unknown";
      return operation(plan.target, "apply", status, sandbox.name, state);
    },
    async observe(context, input) {
      const credential = await resolve(context, input.target.connectionId, "vercel");
      const sandbox = await sandboxFor(input.target, credential);
      const state = String(sandbox.status ?? "unknown").toLowerCase();
      const status: ExternalOperationStatus = state === "running" ? "ready" : state === "stopped" ? "stopped" : state === "failed" ? "failed" : "provisioning";
      return operation(snapshotFor(context, input.target), "observe", status, sandbox.name, state);
    },
    async exec(context, externalOperation, input) {
      const credential = await resolve(context, externalOperation.target.connectionId, "vercel");
      const sandbox = await sandboxFor(externalOperation.target, credential);
      const [command, ...args] = input.argv;
      if (!command) throw new AppError("A Vercel Sandbox command is required.", 400, "EXTERNAL_EXEC_INVALID");
      const result = await sandbox.runCommand({
        cmd: command,
        args,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      const stdout = await result.stdout();
      const stderr = await result.stderr();
      return {
        operation: externalOperation,
        stdout,
        stderr,
        exitCode: result.exitCode ?? null,
      };
    },
    async destroy(context, externalOperation) {
      const credential = await resolve(context, externalOperation.target.connectionId, "vercel");
      const sandbox = await sandboxFor(externalOperation.target, credential);
      await sandbox.delete();
      return { ...externalOperation, status: "stopped", updatedAt: iso() };
    },
  };
}

function vercelCombinedAdapter(resolve: BuiltinCredentialResolver): ExternalProviderAdapter {
  const project = vercelAdapter(resolve);
  const sandbox = vercelSandboxAdapter(resolve);
  const template = createVercelTemplateAdapter(resolve, { signingKey: env.BETTER_AUTH_SECRET });
  const choose = (target: ExternalTargetInput | ExternalTargetSnapshot) =>
    target.workloadKind === "vercel-sandbox" ? sandbox : isVercelTemplateTarget(target) ? template : project;
  return {
    provider: "vercel",
    workloads: ["service", "vercel-sandbox"],
    capabilities: (context, target) => choose(target).capabilities(context, target),
    preflight: (context, target) => choose(target).preflight(context, target),
    plan: (context, input) => choose(input.target).plan(context, input),
    apply: (context, input, plan) => choose(plan.target).apply(context, input, plan),
    observe: (context, input) => choose(input.target).observe(context, input),
    exec: async (context, op, input) => {
      const method = choose(op.target).exec;
      if (!method) throw new AppError("Vercel project deployments do not support command execution.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      return method(context, op, input);
    },
    destroy: async (context, op) => {
      const method = choose(op.target).destroy;
      if (!method) throw new AppError("Deleting Vercel project deployments is not exposed by this adapter.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      return method(context, op);
    },
    async *logs(context, op, options) {
      const adapter = choose(op.target);
      if (!adapter.logs) throw new AppError("Logs are not exposed for this Vercel workload.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      yield* adapter.logs(context, op, options);
    },
  };
}

function flyAdapter(resolve: BuiltinCredentialResolver): ExternalProviderAdapter {
  const adapter: ExternalProviderAdapter = {
    provider: "fly",
    workloads: ["fly-machine", "fly-sprite"],
    async capabilities(context, target) {
      const workload = target.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      if (workload === "fly-sprite") {
        const credential = await resolve(context, target.connectionId, "fly");
        if (!credential.secrets.spriteToken) {
          const capability = profile(target, []);
          return {
            ...capability,
            unsupported: capability.unsupported.map((entry) => ({
              ...entry,
              reason: "Add a Sprites API token to this Fly connection to enable Sprite workloads.",
            })),
          };
        }
      }
      return profile(target, CAPABILITIES[workload]);
    },
    async preflight(context, target) {
      const workload = target.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      const capability = await adapter.capabilities(context, target);
      if (!capability.supported.includes("preflight")) {
        return { planId: `preflight:${target.connectionId}`, target: snapshotFor(context, target), capability, accepted: false, blockers: ["Add a Sprites API token to this Fly connection to enable Sprite workloads."], warnings: [], expiresAt: capability.expiresAt! };
      }
      const clients = await flyClients(resolve, context, target, workload);
      if (workload === "fly-machine") {
        const appName = asString(target.resource.appName ?? target.resource.app);
        if (!appName) throw new AppError("Choose a Fly app or enter a new app name.", 400, "EXTERNAL_TARGET_INVALID");
        if (target.resource.createApp !== "true") await clients.machine!.inspectApp(appName);
      } else if (!asString(target.resource.spriteName ?? target.resource.name)) throw new AppError("Give the Sprite a name.", 400, "EXTERNAL_TARGET_INVALID");
      return { planId: `preflight:${target.connectionId}`, target: snapshotFor(context, target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async plan(context, input) {
      const result = await adapter.preflight(context, input.target);
      const blockers = [...result.blockers];
      if (input.target.workloadKind === "fly-machine") {
        const config = parsedObject(input.target.resource.config, "Machine configuration");
        const cpuKind = input.target.resource.cpuKind ?? record(config.guest).cpu_kind ?? "shared";
        if (cpuKind !== "shared" && cpuKind !== "performance") blockers.push("Fly CPU kind must be shared or performance.");
        if (!asString(input.image ?? input.target.resource.image ?? config.image)) blockers.push("Choose a container image for this Fly Machine.");
        for (const [key, label, maximum] of [["port", "HTTP port", 65535], ["vcpus", "vCPUs", 128], ["memoryMb", "Memory", 524288]] as const) {
          const value = input.target.resource[key];
          if (value && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum)) blockers.push(`${label} must be a positive integer up to ${maximum}.`);
        }
      } else if (input.image ?? input.target.resource.image) blockers.push("Sprites use a managed environment. Choose a Fly Machine to deploy a container image.");
      return { ...result, planId: `plan:${input.idempotencyKey}`, accepted: blockers.length === 0, blockers, warnings: result.warnings };
    },
    async apply(context, input, plan) {
      const workload = plan.target.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      const target = plan.target;
      const requested = plan as ExternalPlan & { image?: string; environment?: Record<string, string>; workload?: Record<string, string> };
      const clients = await flyClients(resolve, context, target, workload);
      const resource = target.resource;
      if (workload === "fly-machine" && resource.createApp === "true") await clients.machine!.createApp(String(resource.appName ?? resource.app), `app:${input.idempotencyKey}`);
      const config = parsedObject(resource.config, "Machine configuration");
      const port = Number(resource.port);
      const guest = { cpu_kind: "shared", ...record(config.guest), ...(resource.cpuKind ? { cpu_kind: resource.cpuKind } : {}), ...(resource.vcpus ? { cpus: Number(resource.vcpus) } : {}), ...(resource.memoryMb ? { memory_mb: Number(resource.memoryMb) } : {}) };
      const raw = workload === "fly-machine"
        ? await clients.machine!.create({
          appName: String(resource.appName ?? resource.app ?? ""), name: asString(resource.name), region: asString(resource.region),
          config: { ...config, ...(requested.image ?? resource.image ? { image: requested.image ?? resource.image } : {}), ...(requested.environment ? { env: requested.environment } : {}),
            ...(Object.keys(guest).length ? { guest } : {}),
            ...(Number.isInteger(port) && port > 0 && port < 65536 ? { services: [{ protocol: "tcp", internal_port: port, ports: [{ port: 80, handlers: ["http"] }, { port: 443, handlers: ["tls", "http"] }] }] } : {}),
          }, idempotencyKey: input.idempotencyKey })
        : await clients.sprite!.create({ name: String(resource.spriteName ?? resource.name ?? ""), region: asString(resource.region), environment: requested.environment, idempotencyKey: input.idempotencyKey });
      const row = record(raw);
      const id = workload === "fly-sprite" ? asString(row.name) ?? asString(resource.spriteName ?? resource.name) : asString(row.id) ?? asString(row.machine_id) ?? asString(resource.machineId);
      const normalized = normalizeFlyStatus(workload, row);
      if (workload === "fly-machine" && resource.createApp === "true" && Number.isInteger(port) && port > 0 && port < 65536) {
        try {
          await clients.machine!.allocatePublicIp(String(resource.appName ?? resource.app), `ip:${input.idempotencyKey}`);
        } catch {
          return operation({ ...target, resource: { ...target.resource, machineId: id ?? "", publicIngress: "pending" } }, "apply", "action_required", id, asString(row.state ?? row.status), "The Machine was created, but its public IP could not be confirmed. Allocate a shared IPv4 address for this app in Fly before opening it publicly.");
        }
      }
      const url = workload === "fly-machine" && Number.isInteger(port) && port > 0 && resource.createApp === "true" ? `https://${resource.appName ?? resource.app}.fly.dev` : asString(row.url);
      return operation(url ? { ...target, resource: { ...target.resource, url } } : target, "apply", statusForFly(normalized), id, asString(row.state ?? row.status), url);
    },
    async observe(context, input) {
      const workload = input.target.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      const target = input.target;
      const clients = await flyClients(resolve, context, target, workload);
      const resource = target.resource;
      const raw = workload === "fly-machine"
        ? await clients.machine!.inspect(String(resource.appName ?? resource.app ?? ""), String(resource.machineId ?? resource.id ?? ""))
        : await clients.sprite!.inspect(String(resource.spriteName ?? resource.name ?? resource.id ?? ""));
      const row = record(raw);
      const id = workload === "fly-sprite" ? asString(row.name) ?? asString(resource.spriteName ?? resource.name) : asString(row.id) ?? asString(row.machine_id) ?? asString(resource.machineId);
      const normalized = normalizeFlyStatus(workload, row);
      const ingressPending = workload === "fly-machine" && target.resource.publicIngress === "pending";
      return operation(snapshotFor(context, target), "observe", ingressPending ? "action_required" : statusForFly(normalized), id, asString(row.state ?? row.status), ingressPending ? "The Machine exists, but public IP allocation still needs to be completed in Fly." : undefined);
    },
    async exec(context, externalOperation, input) {
      if (externalOperation.workloadKind !== "fly-sprite")
        throw new AppError("Fly Machine command execution is not exposed by the configured adapter.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      const clients = await flyClients(resolve, context, externalOperation.target, "fly-sprite");
      const [command, ...args] = input.argv;
      if (!command) throw new AppError("A Fly Sprite command is required.", 400, "EXTERNAL_EXEC_INVALID");
      const raw = record(await clients.sprite!.exec(String(externalOperation.target.resource.spriteName ?? externalOperation.target.resource.name ?? externalOperation.providerResourceId ?? ""), command, args, undefined, { cwd: input.cwd, env: input.env, signal: context.signal }));
      return {
        operation: externalOperation,
        stdout: asString(raw.stdout) ?? "",
        stderr: asString(raw.stderr) ?? "",
        exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
      };
    },
    async destroy(context, externalOperation) {
      const workload = externalOperation.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      const clients = await flyClients(resolve, context, externalOperation.target, workload);
      if (workload === "fly-sprite") {
        await clients.sprite!.destroy(String(externalOperation.target.resource.spriteName ?? externalOperation.target.resource.name ?? externalOperation.providerResourceId ?? ""), `destroy:${externalOperation.id}`);
      } else {
        await clients.machine!.destroy(String(externalOperation.target.resource.appName ?? externalOperation.target.resource.app ?? ""), String(externalOperation.target.resource.machineId ?? externalOperation.providerResourceId ?? ""), `destroy:${externalOperation.id}`);
      }
      return { ...externalOperation, status: "stopped", updatedAt: iso() };
    },
  };
  return adapter;
}

async function flyClients(resolve: BuiltinCredentialResolver, context: ExternalProviderContext, target: ExternalTargetInput | ExternalTargetSnapshot, workload: "fly-machine" | "fly-sprite") {
  const credential = await resolve(context, target.connectionId, "fly");
  const token = requireCredential(credential, workload === "fly-sprite" ? "spriteToken" : "apiToken", workload === "fly-sprite" ? "Sprites" : "Fly");
  const organizationId = scopedIdentity(credential, target, "organizationId");
  if (!organizationId) throw new AppError("A Fly organization is required for this target.", 400, "EXTERNAL_TARGET_INVALID");
  const appName = asString(target.resource.appName) ?? asString(target.resource.app);
  return workload === "fly-machine"
    ? { machine: new FlyMachinesClient({ token, organizationId, appName }) }
    : { sprite: new FlySpritesClient({ token, organizationId }) };
}

function workboxAdapter(resolve: BuiltinCredentialResolver): ExternalProviderAdapter {
  // The transport wrapper owns Workbox's capability projection and host/sandbox
  // distinctions. This layer only resolves the selected org credential lazily.
  return {
    provider: "workbox",
    workloads: ["workbox-host", "workbox-sandbox"],
    async capabilities(context, target) {
      return (await createWorkboxExternalAdapter(await workboxClient(resolve, context, target)).capabilities(context, target));
    },
    async preflight(context, target) {
      return (await createWorkboxExternalAdapter(await workboxClient(resolve, context, target)).preflight(context, target));
    },
    async plan(context, input) {
      return (await createWorkboxExternalAdapter(await workboxClient(resolve, context, input.target)).plan(context, input));
    },
    async apply(context, input, plan) {
      return (await createWorkboxExternalAdapter(await workboxClient(resolve, context, plan.target)).apply(context, input, plan));
    },
    async observe(context, input) {
      return (await createWorkboxExternalAdapter(await workboxClient(resolve, context, input.target)).observe(context, input));
    },
    async exec(context, externalOperation, input) {
      return (await createWorkboxExternalAdapter(await workboxClient(resolve, context, externalOperation.target)).exec!(context, externalOperation, input));
    },
    async reconcile(context, externalOperation) {
      return (await createWorkboxExternalAdapter(await workboxClient(resolve, context, externalOperation.target)).reconcile!(context, externalOperation));
    },
    async destroy(context, externalOperation) {
      return (await createWorkboxExternalAdapter(await workboxClient(resolve, context, externalOperation.target)).destroy!(context, externalOperation));
    },
  };
}

async function workboxClient(resolve: BuiltinCredentialResolver, context: ExternalProviderContext, target: ExternalTargetInput | ExternalTargetSnapshot) {
  const credential = await resolve(context, target.connectionId, "workbox");
  if (credential.publicFields.managedHostId) {
    const { managedWorkboxClient } = await import("../workbox-hosts/service");
    return managedWorkboxClient(context.organizationId, credential.publicFields, requireCredential(credential,"apiKey","Workbox"), context.executionContext);
  }
  const baseUrl = asString(credential.publicFields.baseUrl) ?? asString(target.providerIdentity.endpoint);
  const apiKey = requireCredential(credential, "apiKey", "Workbox");
  if (!baseUrl) throw new AppError("A Workbox endpoint is required for this target.", 400, "EXTERNAL_TARGET_INVALID");
  // Match credential verification: self-hosted instances may intentionally
  // connect to a private/local Workbox endpoint, while the cloud control plane
  // stays SSRF-safe and HTTPS-only.
  return createWorkboxProvider({ baseUrl, apiKey, allowPrivate: !env.CLOUD_MODE, allowHttp: !env.CLOUD_MODE });
}

export function createBuiltinExternalProviderRegistry(
  resolve: BuiltinCredentialResolver,
): ExternalProviderRegistry {
  // Adapters resolve credentials per operation, so no decrypted value is retained.
  return new ExternalProviderRegistry([
    createRailwayExternalAdapter(async (context, connectionId) => {
      const credential = await resolve(context, connectionId, "railway");
      return { publicFields: credential.publicFields, secrets: credential.secrets };
    }),
    vercelCombinedAdapter(resolve),
    flyAdapter(resolve),
    createBlaxelExternalAdapter(async (context, connectionId) => {
      const credential = await resolve(context, connectionId, "blaxel");
      return { publicFields: credential.publicFields, secrets: credential.secrets };
    }),
    workboxAdapter(resolve),
  ]);
}

import { AppError } from "@repo/core";
import type {
  ExternalCapabilityName,
  ExternalCapabilityProfile,
  ExternalOperation,
  ExternalOperationStatus,
  ExternalPlan,
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

function requireCredential(credential: BuiltinCredential, key: string, label: string): string {
  const value = credentialField(credential, key);
  if (!value) throw new AppError(`Reconnect ${label} before operating this target.`, 409, "CONNECTION_RECONNECT_REQUIRED");
  return value;
}

function vercelAdapter(resolve: BuiltinCredentialResolver): ExternalProviderAdapter {
  const workloads = ["service"] as const;
  return {
    provider: "vercel",
    workloads,
    async capabilities(_context, target) { return profile(target, CAPABILITIES.service); },
    async preflight(context, target) {
      await vercelProject(resolve, context, target);
      const capability = profile(target, CAPABILITIES.service);
      return { planId: `preflight:${target.connectionId}`, target: snapshotFor(context, target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async plan(context, input) {
      const capability = profile(input.target, CAPABILITIES.service);
      return { planId: `plan:${input.idempotencyKey}`, target: snapshotFor(context, input.target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async apply(context, input, plan) {
      const target = plan.target;
      const client = await vercelProject(resolve, context, target);
      const request = record((plan as ExternalPlan & { source?: unknown }).source);
      const source = record(request.source);
      const result = await client.createDeployment({
        ...(source.image || source.repo ? { source: Object.fromEntries(Object.entries(source).filter(([key]) => key === "image" || key === "repo")) } : {}),
        ...(request.image ? { source: { image: request.image } } : {}),
        ...(request.environment ? { env: request.environment } : {}),
        ...(input.idempotencyKey ? { meta: { openshipIdempotencyKey: input.idempotencyKey } } : {}),
      });
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

async function vercelProject(resolve: BuiltinCredentialResolver, context: ExternalProviderContext, target: ExternalTargetInput | ExternalTargetSnapshot) {
  const credential = await resolve(context, target.connectionId, "vercel");
  const token = requireCredential(credential, "apiToken", "Vercel");
  const accountId = asString(target.providerIdentity.accountId) ?? asString(credential.publicFields.accountId) ?? "account";
  const teamId = asString(target.providerIdentity.teamId) ?? asString(credential.publicFields.teamId);
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
    const teamId = asString(target.providerIdentity.teamId) ?? asString(credential.publicFields.teamId);
    const params: Record<string, unknown> = { token, projectId, name };
    if (teamId) params.teamId = teamId;
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
      const capability = profile(target, CAPABILITIES["vercel-sandbox"]);
      return { planId: `vercel-sandbox-preflight:${target.connectionId}`, target: snapshotFor(context, target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async plan(context, input) {
      const capability = profile(input.target, CAPABILITIES["vercel-sandbox"]);
      return { planId: `vercel-sandbox-plan:${input.idempotencyKey}`, target: snapshotFor(context, input.target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async apply(context, input, plan) {
      const credential = await resolve(context, plan.target.connectionId, "vercel");
      const token = requireCredential(credential, "apiToken", "Vercel");
      const projectId = asString(plan.target.resource.projectId) ?? asString(plan.target.providerIdentity.projectId);
      if (!projectId) throw new AppError("A Vercel project is required for Sandbox operations.", 400, "EXTERNAL_TARGET_INVALID");
      const resource = plan.target.resource;
      const teamId = asString(plan.target.providerIdentity.teamId) ?? asString(credential.publicFields.teamId);
      const params: Record<string, unknown> = {
        token,
        projectId,
        name: asString(resource.name),
        image: asString(resource.image),
        runtime: asString(resource.runtime),
        region: asString(resource.region),
        persistent: resource.persistent !== "false",
        ports: asString(resource.ports)?.split(",").map((value) => Number(value.trim())).filter(Number.isFinite),
        env: resource.environment ? jsonRecord(resource.environment) : undefined,
        tags: resource.tags ? jsonRecord(resource.tags) : undefined,
        networkPolicy: asString(resource.networkPolicy),
        networkId: asString(resource.networkId),
        resources: asString(resource.vcpus ?? resource.cpu) ? { vcpus: Number(resource.vcpus ?? resource.cpu) } : undefined,
        timeout: asString(resource.timeoutMs) ? Number(resource.timeoutMs) : undefined,
      };
      if (teamId) params.teamId = teamId;
      const sandbox = await Sandbox.getOrCreate(params as never);
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
  const choose = (target: ExternalTargetInput | ExternalTargetSnapshot) =>
    target.workloadKind === "vercel-sandbox" ? sandbox : project;
  return {
    provider: "vercel",
    workloads: ["service", "vercel-sandbox"],
    capabilities: (context, target) => choose(target).capabilities(context, target),
    preflight: (context, target) => choose(target).preflight(context, target),
    plan: (context, input) => choose(input.target).plan(context, input),
    apply: (context, input, plan) => choose(plan.target).apply(context, input, plan),
    observe: (context, input) => choose(input.target).observe(context, input),
  };
}

function flyAdapter(resolve: BuiltinCredentialResolver): ExternalProviderAdapter {
  const adapter: ExternalProviderAdapter = {
    provider: "fly",
    workloads: ["fly-machine", "fly-sprite"],
    async capabilities(_context, target) {
      const workload = target.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      return profile(target, CAPABILITIES[workload]);
    },
    async preflight(context, target) {
      const workload = target.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      await flyClients(resolve, context, target, workload);
      const capability = profile(target, CAPABILITIES[workload]);
      return { planId: `preflight:${target.connectionId}`, target: snapshotFor(context, target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async plan(context, input) {
      const workload = input.target.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      const capability = profile(input.target, CAPABILITIES[workload]);
      return { planId: `plan:${input.idempotencyKey}`, target: snapshotFor(context, input.target), capability, accepted: true, blockers: [], warnings: [], expiresAt: capability.expiresAt! };
    },
    async apply(context, input, plan) {
      const workload = plan.target.workloadKind === "fly-sprite" ? "fly-sprite" : "fly-machine";
      const target = plan.target;
      const requested = plan as ExternalPlan & { image?: string; environment?: Record<string, string>; workload?: Record<string, string> };
      const clients = await flyClients(resolve, context, target, workload);
      const resource = target.resource;
      const raw = workload === "fly-machine"
        ? await clients.machine!.create({ appName: String(resource.appName ?? resource.app ?? ""), name: asString(resource.name), region: asString(resource.region), config: { ...(record(resource.config)), ...(requested.image ?? resource.image ? { image: requested.image ?? resource.image } : {}), ...(requested.environment ? { env: requested.environment } : {}) }, idempotencyKey: input.idempotencyKey })
        : await clients.sprite!.create({ name: String(resource.spriteName ?? resource.name ?? ""), image: asString(requested.image ?? resource.image), region: asString(resource.region), idempotencyKey: input.idempotencyKey });
      const row = record(raw);
      const id = asString(row.id) ?? asString(row.machine_id) ?? asString(row.name) ?? asString(resource.machineId) ?? asString(resource.spriteName);
      const normalized = normalizeFlyStatus(workload, row.state ?? row.status ?? row.lifecycle);
      return operation(target, "apply", statusForFly(normalized), id, asString(row.state ?? row.status));
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
      const id = asString(row.id) ?? asString(row.machine_id) ?? asString(row.name) ?? asString(resource.machineId) ?? asString(resource.spriteName);
      const normalized = normalizeFlyStatus(workload, row.state ?? row.status ?? row.lifecycle);
      return operation(snapshotFor(context, target), "observe", statusForFly(normalized), id, asString(row.state ?? row.status));
    },
    async exec(context, externalOperation, input) {
      if (externalOperation.workloadKind !== "fly-sprite")
        throw new AppError("Fly Machine command execution is not exposed by the configured adapter.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
      const clients = await flyClients(resolve, context, externalOperation.target, "fly-sprite");
      const [command, ...args] = input.argv;
      if (!command) throw new AppError("A Fly Sprite command is required.", 400, "EXTERNAL_EXEC_INVALID");
      const raw = record(await clients.sprite!.exec(String(externalOperation.target.resource.spriteName ?? externalOperation.target.resource.name ?? externalOperation.providerResourceId ?? ""), command, args));
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
  const token = requireCredential(credential, "apiToken", "Fly");
  const organizationId = asString(target.providerIdentity.organizationId) ?? asString(credential.publicFields.organizationId);
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
    workboxAdapter(resolve),
  ]);
}

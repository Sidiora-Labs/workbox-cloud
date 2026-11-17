import { AppError } from "@repo/core";
import type {
  ExternalApplyInput,
  ExternalCapabilityName,
  ExternalCapabilityProfile,
  ExternalOperation,
  ExternalPlan,
  ExternalPlanInput,
  ExternalTargetInput,
  ExternalWorkloadKind,
  ExternalObserveInput,
} from "@repo/contracts";
import type { ExternalProviderAdapter, ExternalProviderContext } from "../../../../external-deployments";
import { WorkboxProvider, type WorkboxCapabilityProfile, type WorkboxSandboxInput, normalizeWorkboxStatus } from "./workbox";

const WORKBOX_WORKLOADS: readonly ExternalWorkloadKind[] = ["workbox-host", "workbox-sandbox"];

function now(): string {
  return new Date().toISOString();
}

function resourceId(target: ExternalTargetInput): string | undefined {
  return target.resource.sandboxId ?? target.resource.id ?? target.resource.name;
}

function profileFrom(target: ExternalTargetInput, checked: WorkboxCapabilityProfile): ExternalCapabilityProfile {
  // Only advertise operations implemented by this external adapter. The
  // transport client has more methods, but those are not platform/UI actions.
  const supported = new Set<ExternalCapabilityName>(["discover", "preflight", "observe", "apply", "exec", "destroy", "reconcile"]);
  const unsupported: Array<{ capability: ExternalCapabilityName; reason: string }> = [
    ...(["session", "files", "checkpoint", "snapshot", "stop", "resume"] as const).map((capability) => ({ capability, reason: "Available in Workbox directly; this deployment adapter does not expose this action yet." })),
    { capability: "public-ingress", reason: "Workbox sandboxes do not provide a public service URL." },
    { capability: "persistent-storage", reason: "The sandbox writable filesystem is removed when the sandbox is destroyed." },
    { capability: "private-network", reason: "Workbox provides isolated or controlled outbound networking, not a shared private network." },
  ];
  for (const capability of checked.capabilities) {
    if (capability.supported) continue;
    const mapped: ExternalCapabilityName = capability.name === "lifetime" ? "idle-policy" : capability.name === "attach" ? "session" : capability.name === "transfer" ? "files" : capability.name === "execute" ? "exec" : capability.name === "checkpoint" ? "checkpoint" : capability.name === "events" ? "logs" : capability.name === "asks" ? "session" : "reconcile";
    supported.delete(mapped);
    unsupported.push({ capability: mapped, reason: capability.reason ?? `Workbox does not support ${capability.name}.` });
  }
  if (target.workloadKind === "workbox-host") {
    for (const capability of ["apply", "exec", "destroy", "reconcile", "observe"] as const) supported.delete(capability);
    unsupported.push({ capability: "apply", reason: "Install the Workbox daemon on a prepared Linux server first, then connect its API and create a Workbox sandbox. The daemon requires cgroup v2, user namespaces, bubblewrap and prepared rootfs/runtime assets." });
  }
  return {
    provider: "workbox",
    workloadKind: target.workloadKind,
    checkedAt: now(),
    supported: [...supported],
    unsupported,
    limits: {},
    observedIdentity: target.providerIdentity,
  };
}

function operation(
  context: ExternalProviderContext,
  target: ExternalTargetInput,
  kind: ExternalOperation["kind"],
  status: ExternalOperation["status"],
  idempotencyKey: string,
  providerResourceId?: string,
  message?: string,
): ExternalOperation {
  const timestamp = now();
  const targetSnapshot = {
    targetId: target.resource.targetId ?? target.resource.id ?? `${target.provider}:${target.workloadKind}`,
    organizationId: context.organizationId,
    provider: "workbox" as const,
    workloadKind: target.workloadKind,
    connectionId: target.connectionId,
    providerIdentity: target.providerIdentity,
    resource: target.resource,
    capturedAt: timestamp,
  };
  return {
    id: `${kind}:${idempotencyKey}`,
    organizationId: context.organizationId,
    targetId: targetSnapshot.targetId,
    kind,
    workloadKind: target.workloadKind,
    status,
    idempotencyKey,
    target: targetSnapshot,
    ...(providerResourceId ? { providerResourceId } : {}),
    ...(message ? { message } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function resourceRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") throw new AppError("Workbox configuration must be a JSON object.", 400, "WORKBOX_INPUT_INVALID");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("Workbox configuration must be a valid JSON object.", 400, "WORKBOX_INPUT_INVALID");
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new AppError(`Unsupported Workbox ${label} field. Put environment values in the Environment section and secrets in host-managed secret references.`, 400, "WORKBOX_INPUT_INVALID");
}

function profileFromResource(resource: ExternalTargetInput["resource"]): Record<string, unknown> {
  const profile = resourceRecord(resource.profile);
  rejectUnknownKeys(profile, ["limits", "network"], "profile");
  const limits = resourceRecord(profile.limits);
  rejectUnknownKeys(limits, ["memoryBytes", "swapBytes", "cpuMillis", "pids"], "limits");
  const ranges: Record<string, readonly [number, number]> = {
    memoryBytes: [16 * 1024 * 1024, 2 ** 52], swapBytes: [0, 2 ** 52], cpuMillis: [100, 8192 * 1000], pids: [16, 4 * 1024 * 1024],
  };
  for (const [key, value] of Object.entries(limits)) {
    const [min, max] = ranges[key]!;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
      throw new AppError(`Workbox ${key} is outside its supported range.`, 400, "WORKBOX_INPUT_INVALID");
  }
  const network = resourceRecord(profile.network);
  rejectUnknownKeys(network, ["mode", "allow", "ports"], "network");
  if (network.mode !== undefined && !["none", "egress", "allowlist"].includes(String(network.mode)))
    throw new AppError("Workbox network mode must be none, egress or allowlist.", 400, "WORKBOX_INPUT_INVALID");
  if (network.allow !== undefined && (!Array.isArray(network.allow) || network.allow.some((entry) => typeof entry !== "string" || entry.length > 253 || !/^(?:\*\.)?[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(entry))))
    throw new AppError("Workbox network allow entries must be hostnames or CIDRs.", 400, "WORKBOX_INPUT_INVALID");
  if (network.ports !== undefined && (!Array.isArray(network.ports) || network.ports.some((entry) => !Number.isInteger(entry) || entry < 1 || entry > 65535)))
    throw new AppError("Workbox network ports must be integers from 1 to 65535.", 400, "WORKBOX_INPUT_INVALID");
  return profile;
}

/** Translate the common launch form into the upstream create contract. */
function sandboxInput(input: Pick<ExternalPlanInput, "target" | "workload" | "environment" | "image" | "source">, idempotencyKey: string): WorkboxSandboxInput {
  const resource = input.target.resource;
  const workload = input.workload ?? {};
  for (const [key, value] of [["rootfs", workload.rootfs ?? resource.rootfs], ["runtime", workload.runtime ?? resource.runtime]] as const) {
    if (value !== undefined && (!/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)))
      throw new AppError(`Workbox ${key} must be the name of an asset prepared on the host.`, 400, "WORKBOX_INPUT_INVALID");
  }
  if (input.image || input.source?.repo || input.source?.image)
    throw new AppError("Workbox uses a rootfs prepared on its host. Select its rootfs name instead of an application image or repository.", 422, "WORKBOX_IMAGE_UNSUPPORTED");
  if (resource.name && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(resource.name))
    throw new AppError("Workbox sandbox names must use 1–64 letters, numbers, dots, underscores or dashes.", 400, "WORKBOX_INPUT_INVALID");
  const profile = profileFromResource(resource);
  const limits = { ...resourceRecord(profile.limits) };
  for (const [key, raw, multiplier] of [
    ["memoryBytes", workload.memoryMb ?? workload.memoryMB, 1024 * 1024],
    ["memoryBytes", workload.memoryBytes, 1],
    ["cpuMillis", workload.cpuMillis, 1],
    ["pids", workload.pids, 1],
  ] as const) {
    if (raw === undefined || raw === "") continue;
    const value = Number(raw) * multiplier;
    if (!Number.isSafeInteger(value) || value <= 0) throw new AppError(`Workbox ${key} must be a positive whole number.`, 400, "WORKBOX_INPUT_INVALID");
    limits[key] = value;
  }
  if (Object.keys(limits).length) profile.limits = limits;
  const network = { ...resourceRecord(profile.network) };
  if (workload.networkMode) network.mode = workload.networkMode;
  if (network.mode !== undefined && !["none", "egress", "allowlist"].includes(String(network.mode)))
    throw new AppError("Workbox network mode must be none, egress or allowlist.", 400, "WORKBOX_INPUT_INVALID");
  if (workload.networkAllow) network.allow = workload.networkAllow.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (Object.keys(network).length) profile.network = network;
  // Revalidate after merging the typed launch fields, before injecting private
  // environment values which must never be accepted from public target JSON.
  profileFromResource({ profile: JSON.stringify(profile) });
  if (input.environment) profile.env = { ...resourceRecord(profile.env), ...input.environment };
  const labels = Object.fromEntries(Object.entries(resourceRecord(resource.labels)).map(([key, value]) => [key, String(value)]));
  return {
    name: resource.name,
    rootfs: workload.rootfs ?? resource.rootfs,
    runtime: workload.runtime ?? resource.runtime,
    profile,
    labels,
    secretRefs: (workload.secretRefs ?? resource.secretRefs)?.split(",").map((value) => value.trim()).filter(Boolean),
    fromCheckpoint: workload.fromCheckpoint ?? resource.fromCheckpoint,
    idempotencyKey,
  };
}

function observedStatus(row: Record<string, unknown>): ExternalOperation["status"] {
  const state = normalizeWorkboxStatus(row.desired ?? row.status);
  if (state === "quarantined") return "failed";
  if (state === "deleted") return "stopped";
  if (state === "deleting") return "stopping";
  if (state === "ready" || state === "running" || state === "draining")
    return row.health && row.health !== "HEALTHY" ? "reconciling" : "ready";
  return state === "unknown" ? "reconciling" : "provisioning";
}

/**
 * ExternalProviderAdapter wrapper for the transport-level Workbox client.
 * Credential resolution and organization authorization remain in the platform
 * composition layer; this object only receives an already-scoped client.
 */
export function createWorkboxExternalAdapter(client: WorkboxProvider): ExternalProviderAdapter {
  return {
    provider: "workbox",
    workloads: WORKBOX_WORKLOADS,

    async capabilities(_context, target) {
      const preflight = await client.preflight();
      return profileFrom(target, preflight);
    },

    async preflight(context, target): Promise<ExternalPlan> {
      if (target.workloadKind === "workbox-sandbox") profileFromResource(target.resource);
      const checked = await client.preflight();
      const capability = profileFrom(target, checked);
      const blockers = capability.unsupported
        .filter((entry) => entry.capability === "preflight" || entry.capability === "apply")
        .map((entry) => entry.reason);
      return {
        planId: `workbox-plan:${target.connectionId}:${target.workloadKind}`,
        target: {
          targetId: target.resource.targetId ?? target.resource.id ?? `${target.provider}:${target.workloadKind}`,
          organizationId: context.organizationId,
          provider: "workbox",
          workloadKind: target.workloadKind,
          connectionId: target.connectionId,
          providerIdentity: target.providerIdentity,
          resource: target.resource,
          capability,
          capturedAt: now(),
        },
        capability,
        accepted: checked.reachable && checked.ready && blockers.length === 0,
        blockers: checked.reachable && checked.ready ? blockers : ["Workbox endpoint is not ready."],
        warnings: checked.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail ?? "failed"}`),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
    },

    async plan(context, input: ExternalPlanInput): Promise<ExternalPlan> {
      if (input.target.workloadKind === "workbox-sandbox") sandboxInput(input, input.idempotencyKey);
      return this.preflight(context, input.target);
    },

    async apply(context, input: ExternalApplyInput, plan: ExternalPlan): Promise<ExternalOperation> {
      if (plan.target.workloadKind === "workbox-host") {
        throw new AppError("Provision a prepared Workbox host before creating its sandboxes.", 422, "WORKBOX_HOST_PROVISIONING_UNSUPPORTED");
      }
      const details = plan as ExternalPlan & Pick<ExternalPlanInput, "workload" | "environment" | "image" | "source">;
      const sandbox = await client.createSandbox(sandboxInput({ ...details, target: plan.target }, input.idempotencyKey));
      const row = asRecord(sandbox);
      const id = String(row.id ?? row.sandboxId ?? plan.target.resource.sandboxId ?? "");
      if (!id) throw new AppError("Workbox did not return a sandbox id", 502, "WORKBOX_RESPONSE_INVALID");
      return operation(context, plan.target, "apply", observedStatus(row), input.idempotencyKey, id);
    },

    async observe(context, input: ExternalObserveInput): Promise<ExternalOperation> {
      const id = resourceId(input.target);
      if (!id) throw new AppError("A Workbox sandbox id is required to observe this target", 400, "WORKBOX_TARGET_REQUIRED");
      const sandbox = asRecord(await client.inspectSandbox(id));
      return operation(context, input.target, "observe", observedStatus(sandbox), `observe:${id}`, id, typeof sandbox.health === "string" ? sandbox.health : undefined);
    },

    async exec(context, externalOperation, input) {
      const id = externalOperation.providerResourceId;
      if (!id) throw new AppError("The Workbox operation has no sandbox id", 409, "WORKBOX_RESOURCE_MISSING");
      const result = asRecord(await client.exec(id, { argv: input.argv, cwd: input.cwd, env: input.env }));
      return {
        operation: externalOperation,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      };
    },

    async reconcile(context, externalOperation) {
      await client.reconcile(`reconcile:${externalOperation.id}`);
      const target = externalOperation.target;
      const observed = await this.observe!(context, { target: {
        provider: "workbox",
        workloadKind: target.workloadKind,
        connectionId: target.connectionId,
        providerIdentity: target.providerIdentity,
        resource: target.resource,
      } });
      return { ...externalOperation, status: observed.status, providerStatus: observed.providerStatus, updatedAt: now() };
    },

    async destroy(context, externalOperation) {
      const id = externalOperation.providerResourceId;
      if (!id) return { ...externalOperation, status: "stopped", updatedAt: now() };
      await client.destroySandbox(id);
      return { ...externalOperation, status: "stopped", providerResourceId: id, updatedAt: now() };
    },
  };
}

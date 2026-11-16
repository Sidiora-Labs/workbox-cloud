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
import { WorkboxProvider, type WorkboxCapabilityProfile, normalizeWorkboxStatus } from "./workbox";

const WORKBOX_WORKLOADS: readonly ExternalWorkloadKind[] = ["workbox-host", "workbox-sandbox"];

function now(): string {
  return new Date().toISOString();
}

function resourceId(target: ExternalTargetInput): string | undefined {
  return target.resource.sandboxId ?? target.resource.id ?? target.resource.name;
}

function profileFrom(target: ExternalTargetInput, checked: WorkboxCapabilityProfile): ExternalCapabilityProfile {
  const supported = new Set<ExternalCapabilityName>(["discover", "preflight", "observe", "apply", "exec", "session", "files", "checkpoint", "snapshot", "stop", "resume", "destroy", "reconcile"]);
  const unsupported: Array<{ capability: ExternalCapabilityName; reason: string }> = [];
  for (const capability of checked.capabilities) {
    if (capability.supported) continue;
    const mapped: ExternalCapabilityName = capability.name === "lifetime" ? "idle-policy" : capability.name === "attach" ? "session" : capability.name === "transfer" ? "files" : capability.name === "execute" ? "exec" : capability.name === "checkpoint" ? "checkpoint" : capability.name === "events" ? "logs" : capability.name === "asks" ? "session" : "reconcile";
    supported.delete(mapped);
    unsupported.push({ capability: mapped, reason: capability.reason ?? `Workbox does not support ${capability.name}.` });
  }
  if (target.workloadKind === "workbox-host") {
    supported.delete("exec");
    supported.delete("session");
    supported.delete("files");
    supported.delete("checkpoint");
    supported.delete("snapshot");
    supported.delete("stop");
    supported.delete("resume");
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
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
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
      return this.preflight(context, input.target);
    },

    async apply(context, input: ExternalApplyInput, plan: ExternalPlan): Promise<ExternalOperation> {
      if (plan.target.workloadKind === "workbox-host") {
        return operation(context, plan.target, "apply", "action_required", input.idempotencyKey, undefined, "Deploy the Workbox host through the selected host provider, then run preflight again.");
      }
      const sandbox = await client.createSandbox({
        name: plan.target.resource.name,
        rootfs: plan.target.resource.rootfs,
        runtime: plan.target.resource.runtime,
        profile: resourceRecord(plan.target.resource.profile),
        labels: Object.fromEntries(
          Object.entries(resourceRecord(plan.target.resource.labels)).map(([key, value]) => [key, String(value)]),
        ),
        secretRefs: plan.target.resource.secretRefs?.split(",").map((value) => value.trim()).filter(Boolean),
        idempotencyKey: input.idempotencyKey,
      });
      const row = asRecord(sandbox);
      const id = String(row.id ?? row.sandboxId ?? plan.target.resource.sandboxId ?? "");
      if (!id) throw new AppError("Workbox did not return a sandbox id", 502, "WORKBOX_RESPONSE_INVALID");
      const status = normalizeWorkboxStatus(row.desired ?? row.status ?? row.health);
      return operation(context, plan.target, "apply", status === "ready" || status === "running" ? "ready" : status === "unknown" ? "reconciling" : "provisioning", input.idempotencyKey, id);
    },

    async observe(context, input: ExternalObserveInput): Promise<ExternalOperation> {
      const id = resourceId(input.target);
      if (!id) throw new AppError("A Workbox sandbox id is required to observe this target", 400, "WORKBOX_TARGET_REQUIRED");
      const sandbox = asRecord(await client.inspectSandbox(id));
      const status = normalizeWorkboxStatus(sandbox.desired ?? sandbox.status ?? sandbox.health);
      const mapped = status === "ready" || status === "running" ? "ready" : status === "deleted" ? "stopped" : status === "unknown" ? "reconciling" : status === "quarantined" ? "failed" : "provisioning";
      return operation(context, input.target, "observe", mapped, `observe:${id}`, id, typeof sandbox.health === "string" ? sandbox.health : undefined);
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

import { createHash } from "node:crypto";
import { AppError, NotFoundError, ValidationError, generateId, type ExternalProvider, type ExternalWorkloadKind } from "@repo/core";
import {
  type ExternalApplyInput,
  type ExternalCapabilityName,
  type ExternalCapabilityProfile,
  type ExternalOperation,
  type ExternalOperationStatus,
  type ExternalPlan,
  type ExternalPlanInput,
  type ExternalTargetInput,
  type ExternalTargetSnapshot,
  type ExternalObserveInput,
} from "@repo/contracts";
import {
  type ExternalDeploymentDependencies,
  type ExternalProviderAdapter,
  type ExternalProviderRegistry,
  normalizeExternalError,
  assertExternalIdempotencyKey,
} from "../../../external-deployments";
import type { ExecutionContext } from "../../../context";
import { repos } from "@repo/db";
import { readCredentialSecrets } from "../credentials/credential.service";
import { createBuiltinExternalProviderRegistry } from "./builtin-registry";

const PLAN_TTL_MS = 15 * 60_000;
const capabilityNames: readonly ExternalCapabilityName[] = [
  "discover",
  "preflight",
  "apply",
  "observe",
  "logs",
  "exec",
  "session",
  "files",
  "snapshot",
  "checkpoint",
  "stop",
  "resume",
  "promote",
  "rollback",
  "destroy",
  "reconcile",
  "public-ingress",
  "persistent-storage",
  "shared-storage",
  "private-network",
  "idle-policy",
];

const baseCapabilities: Record<ExternalWorkloadKind, readonly ExternalCapabilityName[]> = {
  service: ["discover", "preflight", "apply", "observe", "logs", "rollback", "destroy", "public-ingress", "persistent-storage"],
  "railway-sandbox": ["discover", "preflight", "apply", "observe", "logs", "exec", "session", "files", "checkpoint", "snapshot", "stop", "resume", "destroy", "public-ingress", "private-network", "idle-policy"],
  "vercel-sandbox": ["discover", "preflight", "apply", "observe", "logs", "exec", "session", "files", "snapshot", "stop", "resume", "destroy", "public-ingress", "private-network", "idle-policy"],
  "fly-machine": ["discover", "preflight", "apply", "observe", "logs", "exec", "session", "stop", "resume", "rollback", "destroy", "public-ingress", "persistent-storage", "private-network"],
  "fly-sprite": ["discover", "preflight", "apply", "observe", "logs", "exec", "session", "files", "checkpoint", "snapshot", "stop", "resume", "destroy", "public-ingress", "private-network", "persistent-storage", "idle-policy"],
  "self-managed-server": capabilityNames,
  "workbox-host": ["discover", "preflight", "apply", "observe", "logs", "destroy", "reconcile", "public-ingress"],
  "workbox-sandbox": ["discover", "preflight", "apply", "observe", "logs", "exec", "session", "files", "checkpoint", "snapshot", "stop", "resume", "destroy", "reconcile", "private-network"],
};

function nowIso() {
  return new Date().toISOString();
}

function expiresIso() {
  return new Date(Date.now() + PLAN_TTL_MS).toISOString();
}

function fingerprint(input: ExternalTargetInput): string {
  const canonical = JSON.stringify({
    provider: input.provider,
    workloadKind: input.workloadKind,
    connectionId: input.connectionId,
    providerIdentity: Object.fromEntries(Object.entries(input.providerIdentity).sort()),
    resource: Object.fromEntries(Object.entries(input.resource).sort()),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function providerForWorkload(kind: ExternalWorkloadKind): ExternalProvider | null {
  if (kind === "railway-sandbox") return "railway";
  if (kind === "vercel-sandbox") return "vercel";
  if (kind === "fly-machine" || kind === "fly-sprite") return "fly";
  if (kind === "workbox-host" || kind === "workbox-sandbox") return "workbox";
  if (kind === "self-managed-server") return "self-managed";
  return null;
}

function adapterFor(
  registry: ExternalProviderRegistry | undefined,
  target: ExternalTargetInput,
): ExternalProviderAdapter | undefined {
  if (!registry) return undefined;
  try {
    return registry.get(target.provider, target.workloadKind);
  } catch {
    return undefined;
  }
}

async function loadCredential(ctx: ExecutionContext, input: ExternalTargetInput) {
  const row = await repos.credential.findById(ctx.organizationId, input.connectionId);
  if (!row) throw new NotFoundError("Credential", input.connectionId);
  if (row.provider !== input.provider)
    throw new ValidationError("The selected connection does not belong to the selected provider.");
  if (row.status !== "active")
    throw new AppError("The selected provider connection is not active.", 409, "CONNECTION_INVALID");
  // Resolve the exact selected row. Selecting a credential by provider + selector would
  // silently choose the newest token when several accounts share a scope.
  const secrets = readCredentialSecrets(row);
  if (Object.keys(secrets).length === 0)
    throw new AppError("Reconnect the selected provider connection.", 409, "CONNECTION_RECONNECT_REQUIRED");
  return { row, secrets };
}

async function resolveBuiltinCredential(
  context: { readonly organizationId: string },
  connectionId: string,
  provider: ExternalProvider,
) {
  const row = await repos.credential.findById(context.organizationId, connectionId);
  if (!row || row.provider !== provider || row.status !== "active") {
    throw new AppError("The selected provider connection is not active.", 409, "CONNECTION_INVALID");
  }
  const secrets = readCredentialSecrets(row);
  if (Object.keys(secrets).length === 0) {
    throw new AppError("Reconnect the selected provider connection.", 409, "CONNECTION_RECONNECT_REQUIRED");
  }
  return { id: row.id, publicFields: row.publicFields ?? {}, secrets };
}

async function ensureTarget(ctx: ExecutionContext, input: ExternalTargetInput) {
  await loadCredential(ctx, input);
  const fp = fingerprint(input);
  const existing = await repos.externalDeployment.findTargetByFingerprint(ctx.organizationId, fp);
  if (existing) return existing;
  return repos.externalDeployment.createTarget({
    organizationId: ctx.organizationId,
    credentialId: input.connectionId,
    provider: input.provider,
    workloadKind: input.workloadKind,
    providerIdentity: input.providerIdentity,
    resource: input.resource,
    fingerprint: fp,
    displayName: String(input.resource.name ?? input.resource.id ?? `${input.provider} ${input.workloadKind}`),
    capabilities: null,
    status: "active",
    lastPreflightAt: null,
    lastError: null,
  });
}

function targetSnapshot(
  ctx: ExecutionContext,
  target: Awaited<ReturnType<typeof ensureTarget>>,
  capability?: ExternalCapabilityProfile,
): ExternalTargetSnapshot {
  return {
    targetId: target.id,
    organizationId: ctx.organizationId,
    provider: target.provider as ExternalProvider,
    workloadKind: target.workloadKind as ExternalWorkloadKind,
    connectionId: target.credentialId,
    providerIdentity: target.providerIdentity ?? {},
    resource: Object.fromEntries(Object.entries(target.resource ?? {}).map(([key, value]) => [key, String(value)])),
    ...(capability ? { capability } : {}),
    capturedAt: nowIso(),
  };
}

function profile(
  target: ExternalTargetInput,
  adapter: ExternalProviderAdapter | undefined,
  blockers: string[] = [],
): ExternalCapabilityProfile {
  const supported = new Set<ExternalCapabilityName>(baseCapabilities[target.workloadKind]);
  const unsupported: Array<{ capability: ExternalCapabilityName; reason: string }> = [];
  if (!adapter) {
    supported.delete("apply");
    unsupported.push({ capability: "apply", reason: "The provider adapter is not configured on this control plane." });
  }
  for (const reason of blockers) {
    supported.delete("preflight");
    unsupported.push({ capability: "preflight", reason });
  }
  return {
    provider: target.provider,
    workloadKind: target.workloadKind,
    checkedAt: nowIso(),
    expiresAt: expiresIso(),
    supported: [...supported],
    unsupported,
    limits: {},
    observedIdentity: target.providerIdentity,
  };
}

function operationOutput(
  row: Awaited<ReturnType<typeof repos.externalDeployment.findOperationById>>,
  target: Awaited<ReturnType<typeof ensureTarget>>,
): ExternalOperation {
  if (!row) throw new NotFoundError("External operation", "unknown");
  const status = row.status as ExternalOperationStatus;
  return {
    id: row.id,
    organizationId: row.organizationId,
    targetId: row.targetId,
    kind: row.operation as ExternalOperation["kind"],
    workloadKind: row.workloadKind as ExternalWorkloadKind,
    status,
    idempotencyKey: row.idempotencyKey,
    target: targetSnapshot(
      { organizationId: row.organizationId } as ExecutionContext,
      target,
      (target.capabilities ?? undefined) as ExternalCapabilityProfile | undefined,
    ),
    ...(row.providerRequestId ? { providerRequestId: row.providerRequestId } : {}),
    ...(row.providerResourceId ? { providerResourceId: row.providerResourceId } : {}),
    ...(row.providerStatus ? { providerStatus: row.providerStatus } : {}),
    ...(row.errorMessage ? { message: row.errorMessage } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.finishedAt ? { reconciledAt: row.finishedAt.toISOString() } : {}),
  };
}

function planFrom(
  target: ExternalTargetSnapshot,
  capability: ExternalCapabilityProfile,
  accepted: boolean,
  blockers: string[],
  warnings: string[] = [],
  planId = generateId("extplan"),
): ExternalPlan {
  return {
    planId,
    target,
    capability,
    accepted,
    blockers,
    warnings,
    expiresAt: expiresIso(),
  };
}

export function createExternalDeploymentDependencies(
  registry?: ExternalProviderRegistry,
): ExternalDeploymentDependencies {
  const activeRegistry = registry ?? createBuiltinExternalProviderRegistry(resolveBuiltinCredential);
  const capabilities = async (ctx: ExecutionContext, input: ExternalTargetInput) => {
    const target = await ensureTarget(ctx, input);
    const adapter = adapterFor(activeRegistry, input);
    let p = profile(input, adapter);
    if (adapter) {
      try {
        p = await adapter.capabilities(
          { organizationId: ctx.organizationId, actorId: ctx.userId, requestId: ctx.traceId },
          input,
        );
      } catch {
        // Keep the bounded fallback profile. Credential and provider failures are
        // reported by preflight/apply and never copied into capability output.
      }
    }
    await repos.externalDeployment.updateTarget(ctx.organizationId, target.id, {
      capabilities: p,
      lastPreflightAt: new Date(),
      lastError: null,
    });
    return p;
  };

  const preflight = async (ctx: ExecutionContext, input: ExternalTargetInput) => {
    const target = await ensureTarget(ctx, input);
    const adapter = adapterFor(activeRegistry, input);
    let blockers: string[] = [];
    if (providerForWorkload(input.workloadKind) && providerForWorkload(input.workloadKind) !== input.provider)
      blockers.push(`Workload ${input.workloadKind} is not supported by provider ${input.provider}.`);
    let capability = profile(input, adapter, blockers);
    if (adapter) {
      try {
        const providerPlan = await adapter.preflight(
          { organizationId: ctx.organizationId, actorId: ctx.userId, requestId: ctx.traceId },
          input,
        );
        capability = providerPlan.capability;
        blockers.push(...providerPlan.blockers);
      } catch (error) {
        const normalized = normalizeExternalError(error);
        blockers.push(normalized.message);
      }
    }
    const snapshot = targetSnapshot(ctx, target, capability);
    // Optional provider gaps are recorded in the profile without blocking a
    // deploy. Only the operation prerequisites (preflight/apply) reject the
    // plan; otherwise Workbox's documented partial capabilities would make
    // every otherwise healthy sandbox permanently unsupported.
    const requiredCapabilityBlockers = capability.unsupported
      .filter((entry) => entry.capability === "preflight" || entry.capability === "apply")
      .map((entry) => entry.reason);
    const accepted = blockers.length === 0 && requiredCapabilityBlockers.length === 0;
    await repos.externalDeployment.updateTarget(ctx.organizationId, target.id, {
      capabilities: capability,
      lastPreflightAt: new Date(),
      status: accepted ? "active" : "blocked",
      lastError: accepted ? null : blockers.join("; ") || capability.unsupported.map((x) => x.reason).join("; "),
    });
    return planFrom(snapshot, capability, accepted, [...blockers, ...capability.unsupported.map((x) => x.reason)]);
  };

  const plan = async (ctx: ExecutionContext, input: ExternalPlanInput) => {
    assertExternalIdempotencyKey(input.idempotencyKey);
    const target = await ensureTarget(ctx, input.target);
    const adapter = adapterFor(activeRegistry, input.target);
    let capability = profile(input.target, adapter);
    if (adapter) {
      try {
        capability = await adapter.capabilities(
          { organizationId: ctx.organizationId, actorId: ctx.userId, requestId: ctx.traceId },
          input.target,
        );
      } catch {
        // Keep the bounded static profile; provider reachability is checked by
        // preflight and the mutation path remains reconciliable.
      }
    }
    const blockers = capability.unsupported.map((x) => x.reason);
    const snapshot = targetSnapshot(ctx, target, capability);
    const accepted = blockers.length === 0;
    const existing = await repos.externalDeployment.findOperationByIdempotency(ctx.organizationId, input.idempotencyKey);
    if (existing) {
      return planFrom(snapshot, capability, accepted, blockers, ["An operation with this idempotency key already exists."], existing.id);
    }
    const planOperation = await repos.externalDeployment.createOperation({
      organizationId: ctx.organizationId,
      targetId: target.id,
      projectId: null,
      deploymentId: null,
      operation: "plan",
      workloadKind: input.target.workloadKind,
      idempotencyKey: input.idempotencyKey,
      status: accepted ? "queued" : "unsupported",
      request: { target: snapshot, source: input.source ?? null, image: input.image ?? null, environment: input.environment ?? null, workload: input.workload ?? null },
      providerRequestId: null,
      providerResourceId: null,
      providerStatus: null,
      observed: null,
      errorCode: accepted ? null : "EXTERNAL_CAPABILITY_UNSUPPORTED",
      errorMessage: accepted ? null : blockers.join("; "),
      leaseOwner: null,
      leaseUntil: null,
      reconcileAfter: null,
      startedAt: null,
      finishedAt: null,
    });
    return planFrom(snapshot, capability, accepted, blockers, [], planOperation.id);
  };

  const apply = async (ctx: ExecutionContext, input: ExternalApplyInput) => {
    assertExternalIdempotencyKey(input.idempotencyKey);
    if (!input.confirm) throw new ValidationError("External deployment apply requires confirmation.");
    const planRow = await repos.externalDeployment.findOperationById(ctx.organizationId, input.planId);
    if (!planRow) throw new NotFoundError("External plan", input.planId);
    const target = await repos.externalDeployment.findTargetById(ctx.organizationId, planRow.targetId);
    if (!target) throw new NotFoundError("External target", planRow.targetId);
    const existing = await repos.externalDeployment.findOperationByIdempotency(ctx.organizationId, input.idempotencyKey);
    if (existing) return operationOutput(existing, target);
    const request = (planRow.request ?? {}) as Record<string, unknown>;
    const targetInput = request.target as ExternalTargetInput;
    const adapter = adapterFor(activeRegistry, targetInput);
    const operation = await repos.externalDeployment.createOperation({
      organizationId: ctx.organizationId,
      targetId: target.id,
      projectId: null,
      deploymentId: null,
      operation: "apply",
      workloadKind: target.workloadKind,
      idempotencyKey: input.idempotencyKey,
      status: adapter ? "provisioning" : "unsupported",
      request: { ...request, planId: input.planId },
      providerRequestId: null,
      providerResourceId: null,
      providerStatus: null,
      observed: null,
      errorCode: adapter ? null : "EXTERNAL_PROVIDER_UNAVAILABLE",
      errorMessage: adapter ? null : "The provider adapter is not configured on this control plane.",
      leaseOwner: null,
      leaseUntil: null,
      reconcileAfter: null,
      startedAt: new Date(),
      finishedAt: adapter ? null : new Date(),
    });
    if (!adapter) return operationOutput(operation, target);
    try {
      const result = await adapter.apply(
        { organizationId: ctx.organizationId, actorId: ctx.userId, requestId: ctx.traceId },
        input,
        Object.assign(
          planFrom(targetSnapshot(ctx, target), profile(targetInput, adapter), true, []),
          {
            source: request.source ?? undefined,
            image: request.image ?? undefined,
            environment: request.environment ?? undefined,
            workload: request.workload ?? undefined,
          },
        ) as ExternalPlan,
      );
      const updated = await repos.externalDeployment.updateOperation(ctx.organizationId, operation.id, {
        status: result.status,
        providerRequestId: result.providerRequestId ?? null,
        providerResourceId: result.providerResourceId ?? null,
        providerStatus: result.providerStatus ?? null,
        finishedAt: new Date(),
      });
      return operationOutput(updated ?? operation, target);
    } catch (error) {
      const normalized = normalizeExternalError(error, { mutation: true });
      const updated = await repos.externalDeployment.updateOperation(ctx.organizationId, operation.id, {
        status: normalized.unknownOutcome ? "reconciling" : "failed",
        errorCode: normalized.code,
        errorMessage: normalized.message,
        reconcileAfter: normalized.unknownOutcome ? new Date(Date.now() + 30_000) : null,
        finishedAt: normalized.unknownOutcome ? null : new Date(),
      });
      return operationOutput(updated ?? operation, target);
    }
  };

  const observe = async (ctx: ExecutionContext, input: ExternalObserveInput) => {
    const target = await ensureTarget(ctx, input.target);
    const adapter = adapterFor(activeRegistry, input.target);
    let row = input.operationId
      ? await repos.externalDeployment.findOperationById(ctx.organizationId, input.operationId)
      : undefined;
    if (!row) {
      const key = `observe:${target.id}:${Date.now()}`;
      row = await repos.externalDeployment.createOperation({
        organizationId: ctx.organizationId,
        targetId: target.id,
        projectId: null,
        deploymentId: null,
        operation: "observe",
        workloadKind: target.workloadKind,
        idempotencyKey: key,
        status: adapter ? "running" : "unsupported",
        request: { target: targetSnapshot(ctx, target) },
        providerRequestId: null,
        providerResourceId: null,
        providerStatus: null,
        observed: null,
        errorCode: adapter ? null : "EXTERNAL_PROVIDER_UNAVAILABLE",
        errorMessage: adapter ? null : "The provider adapter is not configured on this control plane.",
        leaseOwner: null,
        leaseUntil: null,
        reconcileAfter: null,
        startedAt: new Date(),
        finishedAt: adapter ? null : new Date(),
      });
    }
    if (!adapter) return operationOutput(row, target);
    try {
      const result = await adapter.observe(
        { organizationId: ctx.organizationId, actorId: ctx.userId, requestId: ctx.traceId },
        input,
      );
      const updated = await repos.externalDeployment.updateOperation(ctx.organizationId, row.id, {
        status: result.status,
        providerRequestId: result.providerRequestId ?? null,
        providerResourceId: result.providerResourceId ?? null,
        providerStatus: result.providerStatus ?? null,
        finishedAt: new Date(),
      });
      return operationOutput(updated ?? row, target);
    } catch (error) {
      const normalized = normalizeExternalError(error);
      const updated = await repos.externalDeployment.updateOperation(ctx.organizationId, row.id, {
        status: normalized.retryable ? "reconciling" : "failed",
        errorCode: normalized.code,
        errorMessage: normalized.message,
        reconcileAfter: normalized.retryable ? new Date(Date.now() + 30_000) : null,
        finishedAt: normalized.retryable ? null : new Date(),
      });
      return operationOutput(updated ?? row, target);
    }
  };

  return {
    collection: { capabilities, preflight, plan, apply, observe },
  };
}

export const externalDeploymentDependencies = createExternalDeploymentDependencies();

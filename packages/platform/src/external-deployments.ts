import { AppError, safeErrorMessage } from "@repo/core";
import { ExternalDeploymentCollectionSchemas } from "@repo/contracts";
import type {
  ExternalApplyInput,
  ExternalCapabilityName,
  ExternalCapabilityProfile,
  ExternalError,
  ExternalLogEntry,
  ExternalObserveInput,
  ExternalOperation,
  ExternalPlan,
  ExternalPlanInput,
  ExternalProvider,
  ExternalTargetInput,
  ExternalTargetSnapshot,
  ExternalWorkloadKind,
} from "@repo/contracts";
import type { Authorization } from "./authorization";
import {
  createScopedOperations,
  type PlatformScopedOperations,
  type ScopedServices,
} from "./resource-operations";

/** Context passed to an external provider adapter after Openship authorization. */
export interface ExternalProviderContext {
  readonly organizationId: string;
  readonly actorId?: string;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

/** Secret resolution stays behind the adapter boundary and never enters these contracts. */
export interface ExternalCredentialResolver {
  resolve(connectionId: string, organizationId: string): Promise<{
    readonly publicFields: Readonly<Record<string, string>>;
    readonly secrets: Readonly<Record<string, string>>;
  }>;
}

export interface ExternalProviderAdapter {
  readonly provider: ExternalProvider;
  readonly workloads: readonly ExternalWorkloadKind[];

  capabilities(
    context: ExternalProviderContext,
    target: ExternalTargetInput,
  ): Promise<ExternalCapabilityProfile>;

  preflight(
    context: ExternalProviderContext,
    target: ExternalTargetInput,
  ): Promise<ExternalPlan>;

  plan(
    context: ExternalProviderContext,
    input: ExternalPlanInput,
  ): Promise<ExternalPlan>;

  apply(
    context: ExternalProviderContext,
    input: ExternalApplyInput,
    plan: ExternalPlan,
  ): Promise<ExternalOperation>;

  observe(
    context: ExternalProviderContext,
    input: ExternalObserveInput,
  ): Promise<ExternalOperation>;

  logs?(
    context: ExternalProviderContext,
    operation: ExternalOperation,
    options?: { readonly cursor?: string; readonly signal?: AbortSignal },
  ): AsyncIterable<ExternalLogEntry>;

  exec?(
    context: ExternalProviderContext,
    operation: ExternalOperation,
    input: { readonly argv: readonly string[]; readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
  ): Promise<{ readonly operation: ExternalOperation; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }>;

  reconcile?(
    context: ExternalProviderContext,
    operation: ExternalOperation,
  ): Promise<ExternalOperation>;

  destroy?(
    context: ExternalProviderContext,
    operation: ExternalOperation,
  ): Promise<ExternalOperation>;
}

/** Registry used by platform composition; adapters are selected by provider and workload kind. */
export class ExternalProviderRegistry {
  private readonly adapters = new Map<ExternalProvider, ExternalProviderAdapter>();

  constructor(adapters: readonly ExternalProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ExternalProviderAdapter): this {
    if (this.adapters.has(adapter.provider)) {
      throw new AppError(`External provider '${adapter.provider}' is already registered`, 409, "EXTERNAL_PROVIDER_DUPLICATE");
    }
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  get(provider: ExternalProvider, workloadKind?: ExternalWorkloadKind): ExternalProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new AppError(`External provider '${provider}' is not configured`, 501, "EXTERNAL_PROVIDER_UNAVAILABLE");
    if (workloadKind && !adapter.workloads.includes(workloadKind)) {
      throw new AppError(
        `Provider '${provider}' does not support workload '${workloadKind}'`,
        422,
        "EXTERNAL_WORKLOAD_UNSUPPORTED",
      );
    }
    return adapter;
  }

  list(): readonly ExternalProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

export function createExternalProviderRegistry(
  adapters: readonly ExternalProviderAdapter[] = [],
): ExternalProviderRegistry {
  return new ExternalProviderRegistry(adapters);
}

export function requireExternalCapability(
  profile: ExternalCapabilityProfile,
  capability: ExternalCapabilityName,
): void {
  if (profile.supported.includes(capability)) return;
  const reason = profile.unsupported.find((entry) => entry.capability === capability)?.reason;
  throw new AppError(
    reason ? `External capability '${capability}' is unsupported: ${reason}` : `External capability '${capability}' is unsupported`,
    422,
    "EXTERNAL_CAPABILITY_UNSUPPORTED",
  );
}

/**
 * Convert provider failures into a bounded, secret-safe result. A transport timeout
 * is always an unknown outcome for a mutation and must be reconciled before retry.
 */
export function normalizeExternalError(error: unknown, options: { mutation?: boolean } = {}): ExternalError {
  const message = safeErrorMessage(error);
  const statusCode = error instanceof AppError ? error.statusCode : undefined;
  const code = error instanceof AppError && error.code ? error.code : "EXTERNAL_PROVIDER_ERROR";
  const unknownOutcome = Boolean(options.mutation && isExternalUnknownOutcome(error));
  const retryable = unknownOutcome || statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
  return {
    code,
    message,
    retryable,
    unknownOutcome,
    ...(statusCode !== undefined ? { providerStatus: String(statusCode) } : {}),
  };
}

export function isExternalUnknownOutcome(error: unknown): boolean {
  if (error instanceof AppError && error.code === "EXTERNAL_UNKNOWN_OUTCOME") return true;
  const message = safeErrorMessage(error).toLowerCase();
  return /timeout|timed out|aborted|connection reset|socket hang up|network error|econnreset|econnrefused/.test(message);
}

export function assertExternalTargetOrganization(
  context: ExternalProviderContext,
  target: ExternalTargetSnapshot | ExternalTargetInput,
): void {
  if (target.providerIdentity.organizationId && target.providerIdentity.organizationId !== context.organizationId) {
    throw new AppError("External target belongs to another organization", 403, "EXTERNAL_TARGET_SCOPE_DENIED");
  }
}

export function assertExternalIdempotencyKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
    throw new AppError("External idempotency key is invalid", 400, "EXTERNAL_IDEMPOTENCY_INVALID");
  }
}

/** Transport-independent external deployment operations exposed by HTTP, native SDK and CLI. */
export interface ExternalDeploymentDependencies {
  collection: ScopedServices<typeof ExternalDeploymentCollectionSchemas>;
}

export type PlatformExternalDeploymentOperations = PlatformScopedOperations<
  typeof ExternalDeploymentCollectionSchemas
>;

/**
 * Apply the same authorization and output validation boundary used by the other
 * platform resource groups. External providers remain injected services; this
 * factory does not perform network I/O or select credentials implicitly.
 */
export function createExternalDeploymentOperations(
  authorization: Authorization,
  deps?: ExternalDeploymentDependencies,
): PlatformExternalDeploymentOperations {
  return createScopedOperations(
    ExternalDeploymentCollectionSchemas,
    authorization,
    "settings",
    deps?.collection,
  );
}

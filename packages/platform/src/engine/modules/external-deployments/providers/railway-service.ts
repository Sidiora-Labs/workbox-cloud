import { AppError } from "@repo/core";

export type RailwayServiceStatus =
  | "queued"
  | "provisioning"
  | "ready"
  | "failed"
  | "stopped"
  | "unknown";

export interface RailwayServiceTarget {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
}

export interface RailwayServiceConfigPatch {
  readonly source?: {
    readonly repo?: string;
    readonly branch?: string;
    readonly rootDirectory?: string;
    readonly dockerfilePath?: string;
    readonly image?: string;
  };
  readonly variables?: Record<string, string | null>;
  readonly buildCommand?: string | null;
  readonly startCommand?: string | null;
  readonly restartPolicyType?: string | null;
  readonly restartPolicyMaxRetries?: number | null;
  readonly healthcheckPath?: string | null;
  readonly healthcheckTimeout?: number | null;
  readonly cronSchedule?: string | null;
  readonly sleepApplication?: boolean | null;
}

export interface RailwayServiceDeploymentInput {
  readonly target: RailwayServiceTarget;
  readonly patch?: RailwayServiceConfigPatch;
  readonly deploy?: boolean;
  readonly idempotencyKey?: string;
}

export interface RailwayServiceDeploymentReceipt {
  readonly provider: "railway";
  readonly workloadKind: "service";
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly deploymentId: string | null;
  readonly status: RailwayServiceStatus;
  readonly providerStatus?: string;
}

export interface RailwayServiceDeploymentRecord {
  readonly id: string;
  readonly status?: unknown;
  readonly deploymentStopped?: boolean;
  readonly meta?: Record<string, unknown> | null;
}

export interface RailwayServiceInstance {
  readonly id: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly source?: { image?: string | null; repo?: string | null } | null;
  readonly activeDeployments?: readonly RailwayServiceDeploymentRecord[];
  readonly domains?: {
    readonly serviceDomains?: readonly { domain: string; targetPort?: number | null }[];
    readonly customDomains?: readonly { domain: string; targetPort?: number | null }[];
  };
}

/** The transport is deliberately injected so API versioning and credential handling remain outside this adapter. */
export interface RailwayServiceTransport {
  patchEnvironment(input: {
    environmentId: string;
    patch: { services: Record<string, RailwayServiceConfigPatch> };
    skipDeploys: boolean;
    idempotencyKey?: string;
  }): Promise<unknown>;
  deployService(input: {
    serviceId: string;
    environmentId: string;
    idempotencyKey?: string;
  }): Promise<{ deploymentId?: string | null } | string | null>;
  getDeployment(id: string): Promise<RailwayServiceDeploymentRecord>;
  getService(input: RailwayServiceTarget): Promise<RailwayServiceInstance | null>;
  stopDeployment(input: { deploymentId: string; cancel?: boolean }): Promise<boolean>;
  redeploy(input: { deploymentId: string; usePreviousImageTag?: boolean }): Promise<{ deploymentId?: string | null } | string | null>;
}

export const RAILWAY_SERVICE_CAPABILITIES = Object.freeze({
  workloadKind: "service" as const,
  supportsSource: true,
  supportsImage: true,
  supportsVariables: true,
  supportsVolumes: true,
  supportsDomains: true,
  supportsLogs: true,
  supportsExec: false,
  supportsCheckpoints: false,
  supportsIdleTimeout: false,
  supportsRollback: true,
});

export function normalizeRailwayServiceStatus(status: unknown, stopped = false): RailwayServiceStatus {
  if (stopped || status === "REMOVED" || status === "STOPPED") return "stopped";
  switch (String(status ?? "").toUpperCase()) {
    case "SUCCESS":
    case "READY":
      return "ready";
    case "QUEUED":
    case "WAITING":
      return "queued";
    case "BUILDING":
    case "DEPLOYING":
    case "INITIALIZING":
      return "provisioning";
    case "FAILED":
    case "CRASHED":
    case "SKIPPED":
      return "failed";
    default:
      return "unknown";
  }
}

export function normalizeRailwayServiceDeployment(
  target: RailwayServiceTarget,
  record: RailwayServiceDeploymentRecord,
): RailwayServiceDeploymentReceipt {
  return {
    provider: "railway",
    workloadKind: "service",
    projectId: target.projectId,
    environmentId: target.environmentId,
    serviceId: target.serviceId,
    deploymentId: record.id,
    status: normalizeRailwayServiceStatus(record.status, record.deploymentStopped),
    providerStatus: typeof record.status === "string" ? record.status : undefined,
  };
}

function deploymentId(value: { deploymentId?: string | null } | string | null): string | null {
  if (typeof value === "string") return value;
  return value?.deploymentId ?? null;
}

export function createRailwayServiceAdapter(transport: RailwayServiceTransport) {
  return {
    capabilities: RAILWAY_SERVICE_CAPABILITIES,

    async discover(target: RailwayServiceTarget) {
      return transport.getService(target);
    },

    async apply(input: RailwayServiceDeploymentInput): Promise<RailwayServiceDeploymentReceipt> {
      if (!input.target.projectId || !input.target.environmentId || !input.target.serviceId)
        throw new AppError("Railway service target is incomplete", 400, "PROVIDER_TARGET_INVALID");
      if (input.patch) {
        await transport.patchEnvironment({
          environmentId: input.target.environmentId,
          patch: { services: { [input.target.serviceId]: input.patch } },
          skipDeploys: true,
          idempotencyKey: input.idempotencyKey,
        });
      }
      if (input.deploy === false) {
        const service = await transport.getService(input.target);
        const active = service?.activeDeployments?.find((d) => !d.deploymentStopped);
        return active
          ? normalizeRailwayServiceDeployment(input.target, active)
          : {
              provider: "railway",
              workloadKind: "service",
              ...input.target,
              deploymentId: null,
              status: "stopped",
            };
      }
      const result = await transport.deployService({
        serviceId: input.target.serviceId,
        environmentId: input.target.environmentId,
        idempotencyKey: input.idempotencyKey,
      });
      const id = deploymentId(result);
      if (!id)
        return {
          provider: "railway",
          workloadKind: "service",
          ...input.target,
          deploymentId: null,
          status: "unknown",
        };
      return normalizeRailwayServiceDeployment(input.target, await transport.getDeployment(id));
    },

    async observe(target: RailwayServiceTarget, deploymentIdValue: string) {
      return normalizeRailwayServiceDeployment(target, await transport.getDeployment(deploymentIdValue));
    },

    async stop(deploymentIdValue: string, cancel = false) {
      return transport.stopDeployment({ deploymentId: deploymentIdValue, cancel });
    },

    async rollback(deploymentIdValue: string) {
      const result = await transport.redeploy({ deploymentId: deploymentIdValue, usePreviousImageTag: true });
      return deploymentId(result);
    },
  };
}

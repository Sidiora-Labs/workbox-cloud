import { AppError } from "@repo/core";

export type RailwaySandboxStatus = "queued" | "running" | "stopped" | "destroyed" | "failed" | "unknown";
export type RailwaySandboxNetworkIsolation = "ISOLATED" | "PRIVATE";

export interface RailwaySandboxTarget {
  readonly projectId: string;
  readonly environmentId: string;
  readonly sandboxId?: string;
}

export interface RailwaySandboxCreateInput {
  readonly target: Omit<RailwaySandboxTarget, "sandboxId">;
  readonly name?: string;
  readonly region?: string;
  readonly resources?: { readonly cpu?: number; readonly memoryGB?: number };
  readonly networkIsolation?: RailwaySandboxNetworkIsolation;
  readonly idleTimeoutMinutes?: number;
  readonly env?: Record<string, string>;
  readonly domains?: readonly { readonly prefix?: string; readonly port: number }[];
  readonly checkpointId?: string;
  readonly idempotencyKey: string;
}

export interface RailwaySandboxRecord {
  readonly id: string;
  readonly status?: unknown;
  readonly state?: unknown;
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly region?: string;
  readonly networkIsolation?: RailwaySandboxNetworkIsolation;
  readonly idleTimeoutMinutes?: number | null;
  readonly domains?: readonly { readonly prefix?: string | null; readonly port: number; readonly domain: string }[];
  readonly checkpointId?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RailwaySandboxTransport {
  create(input: RailwaySandboxCreateInput): Promise<RailwaySandboxRecord>;
  list(target: Omit<RailwaySandboxTarget, "sandboxId">): Promise<readonly RailwaySandboxRecord[]>;
  get(target: RailwaySandboxTarget & { sandboxId: string }): Promise<RailwaySandboxRecord>;
  exec(input: { sandboxId: string; command: string | readonly string[]; cwd?: string; timeoutMs?: number }): Promise<unknown>;
  stop(sandboxId: string): Promise<unknown>;
  destroy(sandboxId: string): Promise<unknown>;
  checkpoint(input: { sandboxId: string; name?: string }): Promise<{ id?: string | null } | string | null>;
  fork(input: { sandboxId: string; checkpointId?: string; idempotencyKey: string }): Promise<RailwaySandboxRecord>;
}

export const RAILWAY_SANDBOX_CAPABILITIES = Object.freeze({
  workloadKind: "railway-sandbox" as const,
  supportsExec: true,
  supportsSsh: true,
  supportsFiles: true,
  supportsCheckpoints: true,
  supportsForks: true,
  supportsPrivateNetwork: true,
  supportsPublicDomains: true,
  supportsIdleTimeout: true,
  supportsPersistentServiceTraffic: false,
  supportsDockerInside: true,
});

export function normalizeRailwaySandboxStatus(status: unknown): RailwaySandboxStatus {
  switch (String(status ?? "").toUpperCase()) {
    case "CREATING":
    case "PROVISIONING":
    case "QUEUED":
      return "queued";
    case "RUNNING":
    case "READY":
      return "running";
    case "STOPPED":
    case "SUSPENDED":
      return "stopped";
    case "DESTROYED":
    case "DELETED":
      return "destroyed";
    case "FAILED":
    case "ERROR":
      return "failed";
    default:
      return "unknown";
  }
}

export function normalizeRailwaySandbox(record: RailwaySandboxRecord) {
  return {
    provider: "railway" as const,
    workloadKind: "railway-sandbox" as const,
    id: record.id,
    projectId: record.projectId ?? null,
    environmentId: record.environmentId ?? null,
    status: normalizeRailwaySandboxStatus(record.status ?? record.state),
    region: record.region ?? null,
    networkIsolation: record.networkIsolation ?? "ISOLATED",
    idleTimeoutMinutes: record.idleTimeoutMinutes ?? null,
    domains: record.domains ?? [],
    checkpointId: record.checkpointId ?? null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}

function checkpointId(value: { id?: string | null } | string | null) {
  return typeof value === "string" ? value : value?.id ?? null;
}

export function createRailwaySandboxAdapter(transport: RailwaySandboxTransport) {
  return {
    capabilities: RAILWAY_SANDBOX_CAPABILITIES,

    async create(input: RailwaySandboxCreateInput) {
      if (!input.idempotencyKey) throw new AppError("Railway Sandbox creation requires an idempotency key", 400, "IDEMPOTENCY_REQUIRED");
      if (input.idleTimeoutMinutes != null && input.idleTimeoutMinutes < 0)
        throw new AppError("Railway Sandbox idle timeout cannot be negative", 400, "SANDBOX_INPUT_INVALID");
      return normalizeRailwaySandbox(await transport.create(input));
    },

    async list(target: Omit<RailwaySandboxTarget, "sandboxId">) {
      return (await transport.list(target)).map(normalizeRailwaySandbox);
    },

    async observe(target: RailwaySandboxTarget & { sandboxId: string }) {
      return normalizeRailwaySandbox(await transport.get(target));
    },

    async exec(input: { sandboxId: string; command: string | readonly string[]; cwd?: string; timeoutMs?: number }) {
      if (!input.command || (Array.isArray(input.command) && input.command.length === 0))
        throw new AppError("Railway Sandbox command is required", 400, "SANDBOX_INPUT_INVALID");
      return transport.exec(input);
    },

    async stop(sandboxId: string) {
      return transport.stop(sandboxId);
    },

    async destroy(sandboxId: string) {
      return transport.destroy(sandboxId);
    },

    async checkpoint(sandboxId: string, name?: string) {
      return checkpointId(await transport.checkpoint({ sandboxId, name }));
    },

    async fork(sandboxId: string, checkpointIdValue: string | undefined, idempotencyKey: string) {
      if (!idempotencyKey) throw new AppError("Railway Sandbox fork requires an idempotency key", 400, "IDEMPOTENCY_REQUIRED");
      return normalizeRailwaySandbox(await transport.fork({ sandboxId, checkpointId: checkpointIdValue, idempotencyKey }));
    },
  };
}

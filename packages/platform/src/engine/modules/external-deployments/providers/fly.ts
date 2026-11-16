import { AppError } from "@repo/core";
import { safeFetch } from "../../../lib/safe-fetch";

export const FLY_MACHINES_ORIGIN = "https://api.machines.dev";
export const FLY_SPRITES_ORIGIN = "https://api.sprites.dev";

export type FlyProviderKind = "fly-machine" | "fly-sprite";
export type FlyMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type NormalizedFlyStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "stopping"
  | "stopped"
  | "deleting"
  | "failed"
  | "unknown";

export interface FlyConnection {
  token: string;
  organizationId?: string;
  appName?: string;
}

export interface FlyMachineTarget {
  kind: "fly-machine";
  appName: string;
  machineId?: string;
  organizationId?: string;
}

export interface FlySpriteTarget {
  kind: "fly-sprite";
  spriteName: string;
  organizationId?: string;
}

export interface FlyMachineConfig {
  image?: string;
  env?: Record<string, string>;
  guest?: Record<string, unknown>;
  services?: unknown[];
  mounts?: unknown[];
  checks?: Record<string, unknown>;
  processes?: Record<string, unknown>;
  restart?: Record<string, unknown>;
  auto_destroy?: boolean;
  [key: string]: unknown;
}

export interface CreateFlyMachineInput {
  appName: string;
  name?: string;
  region?: string;
  config: FlyMachineConfig;
  idempotencyKey?: string;
  skipLaunch?: boolean;
}

export interface CreateFlySpriteInput {
  name: string;
  organizationId?: string;
  image?: string;
  region?: string;
  resources?: Record<string, unknown>;
  networkPolicy?: unknown;
  tags?: Record<string, string>;
  idempotencyKey?: string;
  [key: string]: unknown;
}

export interface FlyCapabilityProfile {
  provider: FlyProviderKind;
  operations: readonly string[];
  persistentStorage: boolean;
  checkpoints: boolean;
  exec: boolean;
  publicIngress: boolean;
  networkPolicy: boolean;
  volumes: boolean;
  sleepWake: boolean;
}

export const FLY_MACHINE_CAPABILITIES: FlyCapabilityProfile = {
  provider: "fly-machine",
  operations: ["create", "list", "observe", "start", "stop", "restart", "exec", "destroy"],
  persistentStorage: true,
  checkpoints: false,
  exec: true,
  publicIngress: true,
  networkPolicy: true,
  volumes: true,
  sleepWake: false,
};

export const FLY_SPRITE_CAPABILITIES: FlyCapabilityProfile = {
  provider: "fly-sprite",
  operations: [
    "create",
    "list",
    "observe",
    "exec",
    "files",
    "services",
    "checkpoint",
    "restore",
    "sleep",
    "wake",
    "destroy",
  ],
  persistentStorage: true,
  checkpoints: true,
  exec: true,
  publicIngress: true,
  networkPolicy: true,
  volumes: false,
  sleepWake: true,
};

function segment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..")
    throw new AppError(`Invalid Fly ${label}`, 400, "FLY_TARGET_INVALID");
  return encodeURIComponent(trimmed);
}

function pathFor(kind: FlyProviderKind, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
    throw new AppError("Invalid Fly provider path", 400, "FLY_PATH_INVALID");
  const origin = kind === "fly-machine" ? FLY_MACHINES_ORIGIN : FLY_SPRITES_ORIGIN;
  return new URL(path, origin);
}

function bearer(token: string): Record<string, string> {
  if (!token.trim()) throw new AppError("Fly credentials are required", 400, "FLY_CREDENTIAL_REQUIRED");
  return { Authorization: `Bearer ${token}` };
}

export function machinePath(appName: string, machineId?: string, action?: string): string {
  const base = `/v1/apps/${segment(appName, "app")}/machines`;
  if (!machineId) return base;
  const path = `${base}/${segment(machineId, "machine")}`;
  return action ? `${path}/${segment(action, "action")}` : path;
}

export function spritePath(spriteName?: string, action?: string): string {
  const base = "/v1/sprites";
  if (!spriteName) return base;
  const path = `${base}/${segment(spriteName, "sprite")}`;
  return action ? `${path}/${segment(action, "action")}` : path;
}

/** Build the documented Machines API create body without leaking undefined fields. */
export function buildMachineCreatePayload(input: CreateFlyMachineInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    config: input.config,
  };
  if (input.name) payload.name = input.name;
  if (input.region) payload.region = input.region;
  if (input.skipLaunch !== undefined) payload.skip_launch = input.skipLaunch;
  return payload;
}

/** Build the Sprites API create/update body while preserving provider-specific fields. */
export function buildSpriteCreatePayload(input: CreateFlySpriteInput): Record<string, unknown> {
  const { name: _name, organizationId: _org, idempotencyKey: _idempotency, ...rest } = input;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}

export function normalizeMachineStatus(value: unknown): NormalizedFlyStatus {
  const status = String(value ?? "").toLowerCase();
  if (["created", "creating", "pending"].includes(status)) return "queued";
  if (["starting", "replacing", "migrating", "booting"].includes(status)) return "provisioning";
  if (["started", "running", "healthy"].includes(status)) return "running";
  if (["stopping", "restarting"].includes(status)) return "stopping";
  if (["stopped", "suspended"].includes(status)) return "stopped";
  if (["destroying", "deleting", "destroyed"].includes(status)) return "deleting";
  if (["failed", "crashed", "error"].includes(status)) return "failed";
  return "unknown";
}

export function normalizeSpriteStatus(value: unknown): NormalizedFlyStatus {
  const status = String(value ?? "").toLowerCase();
  if (["creating", "provisioning", "starting", "booting"].includes(status)) return "provisioning";
  if (["active", "running", "ready", "warm"].includes(status)) return "running";
  if (["stopping", "suspending"].includes(status)) return "stopping";
  if (["cold", "paused", "stopped", "sleeping"].includes(status)) return "stopped";
  if (["deleting", "destroying", "deleted"].includes(status)) return "deleting";
  if (["failed", "error"].includes(status)) return "failed";
  return "unknown";
}

export function normalizeFlyStatus(kind: FlyProviderKind, payload: unknown): NormalizedFlyStatus {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return kind === "fly-machine"
    ? normalizeMachineStatus(record.state ?? record.status)
    : normalizeSpriteStatus(record.state ?? record.status ?? record.lifecycle);
}

export interface FlyRequestOptions {
  kind: FlyProviderKind;
  token: string;
  path: string;
  method?: FlyMethod;
  body?: unknown;
  idempotencyKey?: string;
  maxBodyBytes?: number;
}

/**
 * Bounded request helper with fixed origins for Machines and Sprites. Provider
 * response bodies are deliberately omitted from errors because they may include
 * account or secret material.
 */
export async function flyRequest<T>({
  kind,
  token,
  path,
  method = "GET",
  body,
  idempotencyKey,
  maxBodyBytes = 8 * 1024 * 1024,
}: FlyRequestOptions): Promise<T> {
  const url = pathFor(kind, path);
  const headers = {
    ...bearer(token),
    Accept: "application/json",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
  let response;
  try {
    response = await safeFetch(url.href, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 30_000,
      maxBodyBytes,
    });
  } catch {
    throw new AppError("Fly could not be reached. Retry the operation.", 502, "FLY_UNAVAILABLE");
  }
  if (!response.ok) {
    const auth = response.status === 401 || response.status === 403;
    const rateLimited = response.status === 429;
    throw new AppError(
      auth
        ? "Fly refused access for the selected organization or resource."
        : rateLimited
          ? "Fly rate limit reached. Retry later."
          : "Fly provider request failed. Reconcile the target before retrying.",
      auth ? 403 : rateLimited ? 429 : 502,
      auth ? "FLY_ACCESS_DENIED" : rateLimited ? "FLY_RATE_LIMITED" : "FLY_REQUEST_FAILED",
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new AppError("Fly returned an invalid response", 502, "FLY_RESPONSE_INVALID");
  }
}

export class FlyMachinesClient {
  constructor(private readonly connection: FlyConnection) {}

  create(input: CreateFlyMachineInput): Promise<unknown> {
    return flyRequest({
      kind: "fly-machine",
      token: this.connection.token,
      path: machinePath(input.appName),
      method: "POST",
      body: buildMachineCreatePayload(input),
      idempotencyKey: input.idempotencyKey,
    });
  }

  list(appName = this.connection.appName): Promise<unknown> {
    if (!appName) throw new AppError("Fly app is required", 400, "FLY_APP_REQUIRED");
    return flyRequest({ kind: "fly-machine", token: this.connection.token, path: machinePath(appName) });
  }

  inspect(appName: string, machineId: string): Promise<unknown> {
    return flyRequest({ kind: "fly-machine", token: this.connection.token, path: machinePath(appName, machineId) });
  }

  start(appName: string, machineId: string, idempotencyKey?: string): Promise<unknown> {
    return this.lifecycle(appName, machineId, "start", idempotencyKey);
  }

  stop(appName: string, machineId: string, idempotencyKey?: string): Promise<unknown> {
    return this.lifecycle(appName, machineId, "stop", idempotencyKey);
  }

  restart(appName: string, machineId: string, idempotencyKey?: string): Promise<unknown> {
    return this.lifecycle(appName, machineId, "restart", idempotencyKey);
  }

  destroy(appName: string, machineId: string, idempotencyKey?: string): Promise<unknown> {
    return flyRequest({
      kind: "fly-machine",
      token: this.connection.token,
      path: machinePath(appName, machineId),
      method: "DELETE",
      idempotencyKey,
    });
  }

  private lifecycle(appName: string, machineId: string, action: string, idempotencyKey?: string): Promise<unknown> {
    return flyRequest({
      kind: "fly-machine",
      token: this.connection.token,
      path: machinePath(appName, machineId, action),
      method: "POST",
      idempotencyKey,
    });
  }
}

export class FlySpritesClient {
  constructor(private readonly connection: FlyConnection) {}

  create(input: CreateFlySpriteInput): Promise<unknown> {
    return flyRequest({
      kind: "fly-sprite",
      token: this.connection.token,
      path: spritePath(input.name),
      method: "PUT",
      body: buildSpriteCreatePayload(input),
      idempotencyKey: input.idempotencyKey,
    });
  }

  list(): Promise<unknown> {
    return flyRequest({ kind: "fly-sprite", token: this.connection.token, path: spritePath() });
  }

  inspect(spriteName: string): Promise<unknown> {
    return flyRequest({ kind: "fly-sprite", token: this.connection.token, path: spritePath(spriteName) });
  }

  exec(spriteName: string, command: string, args: string[] = [], idempotencyKey?: string): Promise<unknown> {
    return flyRequest({
      kind: "fly-sprite",
      token: this.connection.token,
      path: spritePath(spriteName, "exec"),
      method: "POST",
      body: { command, args },
      idempotencyKey,
    });
  }

  checkpoint(spriteName: string, name?: string, idempotencyKey?: string): Promise<unknown> {
    return flyRequest({
      kind: "fly-sprite",
      token: this.connection.token,
      path: spritePath(spriteName, "checkpoints"),
      method: "POST",
      body: name ? { name } : undefined,
      idempotencyKey,
    });
  }

  destroy(spriteName: string, idempotencyKey?: string): Promise<unknown> {
    return flyRequest({
      kind: "fly-sprite",
      token: this.connection.token,
      path: spritePath(spriteName),
      method: "DELETE",
      idempotencyKey,
    });
  }
}

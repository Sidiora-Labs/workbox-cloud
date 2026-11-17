import { ExecError, SpritesClient } from "@fly/sprites";
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
  // A Sprite is provisioned from Fly's managed environment, not a Docker image.
  const payload: Record<string, unknown> = { name: input.name };
  if (input.region) payload.config = { ...input.resources, region: input.region };
  else if (input.resources) payload.config = input.resources;
  if (input.urlSettings) payload.url_settings = input.urlSettings;
  if (input.environment) payload.environment = input.environment;
  if (input.runtime) payload.runtime = input.runtime;
  return payload;
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
    throw new AppError(method === "GET" ? "Fly could not be reached. Retry the operation." : "Fly request outcome is unknown. Refresh the target before retrying.", 502, method === "GET" ? "FLY_UNAVAILABLE" : "EXTERNAL_UNKNOWN_OUTCOME");
  }
  if (!response.ok) {
    if (method !== "GET" && response.status >= 500) throw new AppError("Fly request outcome is unknown. Refresh the target before retrying.", 502, "EXTERNAL_UNKNOWN_OUTCOME");
    const auth = response.status === 401 || response.status === 403;
    const rateLimited = response.status === 429;
    // Only map known validation classes to fixed messages. Never include the
    // provider's raw body, which can repeat submitted environment secrets.
    if (!auth && !rateLimited && response.status >= 400 && response.status < 500) {
      let details = "";
      try {
        const error = await response.json() as Record<string, unknown>;
        details = [error.error, error.message].filter(value => typeof value === "string").join(" ").slice(0, 8000).toLowerCase();
      } catch { /* Keep the generic error for non-JSON provider responses. */ }
      const validation = /cpu.?kind|invalid cpu|unknown cpu/.test(details) ? ["FLY_CPU_INVALID", "Fly rejected the CPU kind. Choose shared or performance."]
        : /memory|ram.*(?:invalid|limit|minimum|maximum)/.test(details) ? ["FLY_MEMORY_INVALID", "Fly rejected the memory size. Choose a size supported by the selected CPU kind."]
        : /image|manifest|registry|pull/.test(details) ? ["FLY_IMAGE_UNAVAILABLE", "Fly could not use this container image. Check the registry path and image access."]
        : /quota|billing|payment|credit|spending/.test(details) ? ["FLY_ACCOUNT_LIMIT", "Fly requires an account limit or billing change before creating this Machine."]
        : /capacity|insufficient resources|not enough/.test(details) ? ["FLY_REGION_CAPACITY", "Fly has insufficient capacity for this Machine configuration in the selected region."] : undefined;
      if (validation) throw new AppError(validation[1]!, 422, validation[0]);
    }
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
    throw new AppError("Fly returned an invalid response", 502, method === "GET" ? "FLY_RESPONSE_INVALID" : "EXTERNAL_UNKNOWN_OUTCOME");
  }
}

export class FlyMachinesClient {
  constructor(private readonly connection: FlyConnection) {}

  inspectApp(appName: string): Promise<unknown> {
    return flyRequest({ kind: "fly-machine", token: this.connection.token, path: `/v1/apps/${segment(appName, "app")}` });
  }

  createApp(appName: string, idempotencyKey?: string): Promise<unknown> {
    if (!this.connection.organizationId) throw new AppError("A Fly organization is required", 400, "FLY_ORGANIZATION_REQUIRED");
    return flyRequest({ kind: "fly-machine", token: this.connection.token, path: "/v1/apps", method: "POST", body: { app_name: appName, org_slug: this.connection.organizationId }, idempotencyKey });
  }

  async allocatePublicIp(appName: string, idempotencyKey: string): Promise<void> {
    segment(appName, "app");
    let response;
    try {
      response = await safeFetch("https://api.fly.io/graphql", {
        method: "POST", headers: { ...bearer(this.connection.token), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: "mutation AllocatePublicIp($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address type } } }", variables: { input: { appId: appName, type: "shared_v4", clientMutationId: idempotencyKey } } }),
        timeoutMs: 30_000, maxBodyBytes: 256_000,
      });
    } catch { throw new AppError("Fly IP allocation outcome is unknown.", 502, "EXTERNAL_UNKNOWN_OUTCOME"); }
    if (!response.ok) throw new AppError("Fly could not allocate the app's public IP address.", response.status === 403 ? 403 : 502, response.status >= 500 ? "EXTERNAL_UNKNOWN_OUTCOME" : "FLY_IP_ALLOCATION_FAILED");
    const result = await response.json() as { data?: { allocateIpAddress?: { ipAddress?: { address?: string } } }; errors?: unknown[] };
    if (result.errors?.length || !result.data?.allocateIpAddress?.ipAddress?.address) throw new AppError("Fly could not confirm the app's public IP allocation.", 502, "FLY_IP_ALLOCATION_FAILED");
  }

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
      path: `${machinePath(appName, machineId)}?force=true`,
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
      path: spritePath(),
      method: "POST",
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

  async exec(spriteName: string, command: string, args: string[] = [], _idempotencyKey?: string, options?: { cwd?: string; env?: Readonly<Record<string, string>>; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Use the maintained SDK's framed WebSocket transport. The HTTP exec stream
    // has no frame lengths and cannot be decoded reliably after buffering.
    segment(spriteName, "sprite");
    try {
      const result = await new SpritesClient(this.connection.token).sprite(spriteName).execFile(command, args, {
        cwd: options?.cwd, env: options?.env ? { ...options.env } : undefined,
        signal: options?.signal, timeout: 30_000, maxBuffer: 20_000,
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: result.exitCode };
    } catch (error) {
      // execFile rejects nonzero exits with captured output; these are command
      // results, while transport failures remain explicit provider errors.
      if (error instanceof ExecError) return { stdout: String(error.stdout), stderr: String(error.stderr), exitCode: error.exitCode };
      throw new AppError("Sprite command transport failed or exceeded its output/time limit.", 502, "FLY_EXEC_FAILED");
    }
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

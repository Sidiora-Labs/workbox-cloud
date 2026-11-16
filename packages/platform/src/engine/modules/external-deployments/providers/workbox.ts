import { AppError } from "@repo/core";
import { safeFetch, type SafeFetchResponse } from "../../../lib/safe-fetch";

/** The operations exposed by the Workbox adapter.  Workbox's own provider
 * mapping is intentionally partial: capabilities and lifetime are derived by
 * Openship, while attach/transfer/output digests are bounded by the Workbox
 * API available at the connected endpoint. */
export type WorkboxCapabilityName =
  | "create"
  | "list"
  | "observe"
  | "attach"
  | "execute"
  | "inspect"
  | "stop"
  | "transfer"
  | "lifetime"
  | "destroy"
  | "checkpoint"
  | "events"
  | "asks"
  | "reconcile";

export interface WorkboxCapability {
  readonly name: WorkboxCapabilityName;
  readonly supported: boolean;
  readonly mode: "mapped" | "partial" | "derived" | "gap";
  readonly reason?: string;
}

export interface WorkboxCapabilityProfile {
  readonly provider: "workbox";
  readonly endpoint: string;
  readonly reachable: boolean;
  readonly ready: boolean;
  readonly capabilities: readonly WorkboxCapability[];
  readonly checks: readonly WorkboxPreflightCheck[];
}

export interface WorkboxPreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface WorkboxClientOptions {
  /** Workbox base URL, for example https://workbox.example.com. */
  readonly baseUrl: string;
  /** Scoped Workbox bearer token. Never included in returned objects/errors. */
  readonly apiKey: string;
  /** Explicit opt-in for a self-managed private endpoint. */
  readonly allowPrivate?: boolean;
  /** Explicit opt-in for local HTTP during self-managed development. */
  readonly allowHttp?: boolean;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  /** Test/embedding hook. Production defaults to the SSRF-safe transport. */
  readonly request?: WorkboxRequest;
}

export interface WorkboxRequest {
  (url: string, options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    allowPrivate?: boolean;
    allowHttp?: boolean;
    maxBodyBytes?: number;
  }): Promise<SafeFetchResponse>;
}

export interface WorkboxSandboxInput {
  readonly name?: string;
  readonly rootfs?: string;
  readonly runtime?: string;
  readonly profile?: Record<string, unknown>;
  readonly labels?: Record<string, string>;
  readonly idempotencyKey: string;
  readonly secretRefs?: readonly string[];
  readonly fromCheckpoint?: string;
}

export interface WorkboxExecInput {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface WorkboxSessionInput extends WorkboxExecInput {
  readonly name?: string;
  readonly durable?: boolean;
  readonly secretRefs?: readonly string[];
}

export interface WorkboxFileWriteInput {
  readonly path: string;
  readonly data: string;
  readonly append?: boolean;
  readonly mode?: number;
  readonly mkdirs?: boolean;
}

export interface WorkboxSandboxRecord {
  readonly id?: string;
  readonly sandboxId?: string;
  readonly name?: string;
  readonly desired?: string;
  readonly health?: string;
  readonly lastObservedAt?: string | null;
  readonly [key: string]: unknown;
}

export interface WorkboxListResult {
  readonly items: readonly WorkboxSandboxRecord[];
  readonly cursor?: string | null;
  readonly complete?: boolean;
  readonly [key: string]: unknown;
}

export interface WorkboxCheckpointRecord {
  readonly id?: string;
  readonly name?: string;
  readonly createdAt?: string;
  readonly [key: string]: unknown;
}

export type WorkboxStatus =
  | "requested"
  | "provisioning"
  | "bootstrapping"
  | "ready"
  | "running"
  | "draining"
  | "deleting"
  | "deleted"
  | "quarantined"
  | "unknown"
  | "unsupported";

const STATIC_CAPABILITIES: readonly WorkboxCapability[] = [
  { name: "create", supported: true, mode: "partial" },
  { name: "list", supported: true, mode: "partial" },
  { name: "observe", supported: true, mode: "mapped" },
  {
    name: "attach",
    supported: true,
    mode: "partial",
    reason: "The current API replays retained output from sequence zero; resume cursors are adapter-filtered.",
  },
  {
    name: "execute",
    supported: true,
    mode: "partial",
    reason: "The provider does not expose output byte counts or output digests on exec responses.",
  },
  { name: "inspect", supported: true, mode: "partial" },
  { name: "stop", supported: true, mode: "mapped" },
  {
    name: "transfer",
    supported: true,
    mode: "partial",
    reason: "File reads/writes are bounded and require chunking; artifact downloads are not generally exposed.",
  },
  {
    name: "lifetime",
    supported: false,
    mode: "gap",
    reason: "Workbox has no provider-side idle expiry or lifetime endpoint.",
  },
  { name: "destroy", supported: true, mode: "mapped" },
  { name: "checkpoint", supported: true, mode: "mapped" },
  { name: "events", supported: true, mode: "partial" },
  { name: "asks", supported: true, mode: "partial" },
  { name: "reconcile", supported: true, mode: "mapped" },
];

function endpointBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("Workbox endpoint is invalid", 400, "WORKBOX_ENDPOINT_INVALID");
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new AppError("Workbox endpoint must be an HTTP(S) URL without embedded credentials", 400, "WORKBOX_ENDPOINT_INVALID");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function joinPath(base: URL, path: string): string {
  if (!path.startsWith("/")) throw new Error("Workbox paths must begin with '/'");
  return new URL(path, `${base.origin}${base.pathname || "/"}`).href;
}

function idPart(value: string, label = "id"): string {
  if (!value || value.length > 256 || value.includes("/") || value.includes("\\") || value.includes("?"))
    throw new AppError(`Invalid Workbox ${label}`, 400, "WORKBOX_INPUT_INVALID");
  return encodeURIComponent(value);
}

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    accept: "application/json",
    "content-type": "application/json",
  };
}

function sanitizeProviderStatus(status: number): { statusCode: number; code: string } {
  if (status === 401) return { statusCode: 401, code: "WORKBOX_AUTHENTICATION" };
  if (status === 403) return { statusCode: 403, code: "WORKBOX_AUTHORIZATION" };
  if (status === 404) return { statusCode: 404, code: "WORKBOX_NOT_FOUND" };
  if (status === 409) return { statusCode: 409, code: "WORKBOX_CONFLICT" };
  if (status === 413) return { statusCode: 413, code: "WORKBOX_PAYLOAD_TOO_LARGE" };
  if (status === 429) return { statusCode: 429, code: "WORKBOX_RATE_LIMIT" };
  if (status === 408 || status === 504) return { statusCode: 504, code: "WORKBOX_TIMEOUT" };
  if (status >= 500) return { statusCode: 502, code: "WORKBOX_UNAVAILABLE" };
  return { statusCode: 502, code: "WORKBOX_REQUEST_FAILED" };
}

/** Normalize provider state without collapsing unknown or quarantined states. */
export function normalizeWorkboxStatus(value: unknown): WorkboxStatus {
  const status = String(value ?? "").toUpperCase();
  switch (status) {
    case "REQUESTED": return "requested";
    case "PROVISIONING": return "provisioning";
    case "BOOTSTRAPPING": return "bootstrapping";
    case "READY": return "ready";
    case "RUNNING": return "running";
    case "DRAINING": return "draining";
    case "DELETING": return "deleting";
    case "DELETED": return "deleted";
    case "QUARANTINED": return "quarantined";
    default: return "unknown";
  }
}

/** Build a safe, deterministic path for tests and callers that need a target URL. */
export function workboxPath(baseUrl: string, path: string): string {
  return joinPath(endpointBase(baseUrl), path);
}

export class WorkboxProvider {
  readonly provider = "workbox" as const;
  readonly baseUrl: string;
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly allowPrivate: boolean;
  private readonly allowHttp: boolean;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly transport: WorkboxRequest;

  constructor(options: WorkboxClientOptions) {
    if (!options.apiKey) throw new AppError("Workbox API key is required", 400, "WORKBOX_KEY_REQUIRED");
    this.endpoint = endpointBase(options.baseUrl);
    this.baseUrl = this.endpoint.href;
    this.apiKey = options.apiKey;
    this.allowPrivate = options.allowPrivate ?? false;
    this.allowHttp = options.allowHttp ?? false;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    this.transport = options.request ?? safeFetch;
  }

  /** The key is intentionally absent from this profile and every public result. */
  capabilities(): readonly WorkboxCapability[] {
    return STATIC_CAPABILITIES.map((capability) => ({ ...capability }));
  }

  async preflight(): Promise<WorkboxCapabilityProfile> {
    const checks: WorkboxPreflightCheck[] = [];
    let reachable = false;
    let ready = false;
    try {
      const health = await this.request("/healthz", { method: "GET" });
      reachable = true;
      checks.push({ name: "healthz", ok: health.status >= 200 && health.status < 300, detail: "Workbox health endpoint responded." });
    } catch (error) {
      checks.push({ name: "healthz", ok: false, detail: error instanceof AppError ? error.message : "Workbox health endpoint was unavailable." });
    }
    try {
      const response = await this.request("/readyz", { method: "GET" });
      ready = response.status >= 200 && response.status < 300;
      checks.push({ name: "readyz", ok: ready, detail: ready ? "Workbox reports ready." : "Workbox is reachable but not ready." });
    } catch (error) {
      checks.push({ name: "readyz", ok: false, detail: error instanceof AppError ? error.message : "Workbox readiness endpoint was unavailable." });
    }
    return {
      provider: "workbox",
      endpoint: this.baseUrl,
      reachable,
      ready,
      capabilities: this.capabilities(),
      checks,
    };
  }

  async createSandbox(input: WorkboxSandboxInput): Promise<WorkboxSandboxRecord> {
    if (!input.idempotencyKey) throw new AppError("Workbox sandbox creation requires an idempotency key", 400, "WORKBOX_IDEMPOTENCY_REQUIRED");
    return (await this.requestJson("/v1/sandboxes", {
      method: "POST",
      body: {
        ...input,
        idempotencyKey: input.idempotencyKey,
        secretRefs: input.secretRefs ? [...input.secretRefs] : undefined,
      },
      idempotencyKey: input.idempotencyKey,
    })) as WorkboxSandboxRecord;
  }

  async listSandboxes(options: { cursor?: string; limit?: number; includeDeleted?: boolean } = {}): Promise<WorkboxListResult> {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(Math.max(1, Math.min(200, Math.floor(options.limit)))));
    if (options.includeDeleted) query.set("includeDeleted", "1");
    return (await this.requestJson(`/v1/sandboxes${query.size ? `?${query}` : ""}`, { method: "GET" })) as WorkboxListResult;
  }

  async inspectSandbox(sandboxId: string): Promise<WorkboxSandboxRecord> {
    return (await this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}`, { method: "GET" })) as WorkboxSandboxRecord;
  }

  async reconcile(idempotencyKey = "reconcile"): Promise<unknown> {
    return this.requestJson("/v1/reconcile", { method: "POST", idempotencyKey });
  }

  async drainSandbox(sandboxId: string): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/drain`, {
      method: "POST",
      idempotencyKey: `drain:${sandboxId}`,
    });
  }

  async destroySandbox(sandboxId: string): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}`, {
      method: "DELETE",
      idempotencyKey: `destroy:${sandboxId}`,
    });
  }

  async exec(sandboxId: string, input: WorkboxExecInput): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/exec`, { method: "POST", body: input });
  }

  async createSession(sandboxId: string, input: WorkboxSessionInput): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/sessions`, {
      method: "POST",
      body: { ...input, durable: input.durable ?? true, secretRefs: input.secretRefs ? [...input.secretRefs] : undefined },
    });
  }

  async inspectSession(sandboxId: string, sessionId: string): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/sessions/${idPart(sessionId, "session id")}`, { method: "GET" });
  }

  async sessionOutput(sandboxId: string, sessionId: string): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/sessions/${idPart(sessionId, "session id")}/output`, { method: "GET" });
  }

  async stopSession(sandboxId: string, sessionId: string, graceMs?: number): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/sessions/${idPart(sessionId, "session id")}/stop`, {
      method: "POST",
      body: graceMs === undefined ? undefined : { graceMs },
      idempotencyKey: `stop:${sandboxId}:${sessionId}`,
    });
  }

  async readFile(sandboxId: string, path: string, options: { offset?: number; length?: number } = {}): Promise<unknown> {
    const query = new URLSearchParams({ path });
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    if (options.length !== undefined) query.set("length", String(options.length));
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/files?${query}`, { method: "GET" });
  }

  /** Read a file without assuming the provider chose a JSON representation. */
  async readFileBytes(sandboxId: string, path: string, options: { offset?: number; length?: number } = {}): Promise<Buffer> {
    const query = new URLSearchParams({ path });
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    if (options.length !== undefined) query.set("length", String(options.length));
    const response = await this.request(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/files?${query}`, { method: "GET" });
    return response.bytes();
  }

  /** The caller owns the WebSocket implementation; this helper only derives a safe URL. */
  sessionWebSocketUrl(sandboxId: string, sessionId: string): string {
    const url = new URL(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/sessions/${idPart(sessionId, "session id")}/ws`, this.endpoint);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  async writeFile(sandboxId: string, input: WorkboxFileWriteInput): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/files`, { method: "PUT", body: input });
  }

  async listCheckpoints(sandboxId: string): Promise<unknown> {
    return this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/checkpoints`, { method: "GET" });
  }

  async createCheckpoint(sandboxId: string, input: { name?: string } = {}): Promise<WorkboxCheckpointRecord> {
    return (await this.requestJson(`/v1/sandboxes/${idPart(sandboxId, "sandbox id")}/checkpoints`, { method: "POST", body: input })) as WorkboxCheckpointRecord;
  }

  async listEvents(options: { cursor?: string; sandboxId?: string } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.sandboxId) query.set("sandboxId", options.sandboxId);
    return this.requestJson(`/v1/events${query.size ? `?${query}` : ""}`, { method: "GET" });
  }

  async listAsks(): Promise<unknown> {
    return this.requestJson("/v1/asks", { method: "GET" });
  }

  async answerAsk(askId: string, answer: unknown): Promise<unknown> {
    return this.requestJson(`/v1/asks/${idPart(askId, "ask id")}/answer`, { method: "POST", body: { answer } });
  }

  private async request(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<SafeFetchResponse> {
    const headers = jsonHeaders(this.apiKey);
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const response = await this.transport(joinPath(this.endpoint, path), {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      timeoutMs: this.timeoutMs,
      allowPrivate: this.allowPrivate,
      allowHttp: this.allowHttp,
      maxBodyBytes: this.maxBodyBytes,
    });
    if (response.ok) return response;
    const { statusCode, code } = sanitizeProviderStatus(response.status);
    throw new AppError("The Workbox provider rejected the request. Inspect the target before retrying.", statusCode, code);
  }

  private async requestJson(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<unknown> {
    const response = await this.request(path, options);
    try {
      return await response.json();
    } catch {
      throw new AppError("Workbox returned an invalid response", 502, "WORKBOX_RESPONSE_INVALID");
    }
  }
}

/** A narrow factory that keeps provider wiring easy to inject in platform composition. */
export function createWorkboxProvider(options: WorkboxClientOptions): WorkboxProvider {
  return new WorkboxProvider(options);
}

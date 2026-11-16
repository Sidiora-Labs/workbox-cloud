import { AppError } from "@repo/core";
import { safeFetch, type SafeFetchResponse } from "../../../lib/safe-fetch";

/** The credential/account scope selected by the caller. */
export interface VercelAccountScope {
  /** The Workbox Cloud connection row. Required so two accounts cannot be conflated. */
  connectionId: string;
  /** Provider-reported user/account identity captured when the connection was verified. */
  accountId: string;
  /** Optional Vercel team scope. */
  teamId?: string;
}

export interface VercelProjectTarget extends VercelAccountScope {
  projectId?: string;
  projectName?: string;
}

export interface VercelApiRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Used by tests and by a composition layer that already owns provider transport. */
  request?: (path: string, options: Required<Pick<VercelApiRequest, "method">> & { query: Record<string, string>; body?: unknown; headers: Record<string, string> }) => Promise<unknown>;
}

export interface VercelApiClient {
  request(path: string, options?: VercelApiRequest): Promise<unknown>;
}

const VERCEL_ORIGIN = "https://api.vercel.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function cleanQuery(query: VercelApiRequest["query"]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

function assertPath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new AppError("Invalid Vercel API path", 400, "EXTERNAL_PROVIDER_PATH_INVALID");
}

function scopedQuery(scope: VercelAccountScope, query: VercelApiRequest["query"]): Record<string, string> {
  const out = cleanQuery(query);
  if (scope.teamId) out.teamId = scope.teamId;
  return out;
}

async function readProviderError(response: SafeFetchResponse): Promise<never> {
  // Provider bodies are intentionally not returned: deployment bodies can echo env values.
  const status = response.status;
  const auth = status === 401 || status === 403;
  throw new AppError(
    auth
      ? "Vercel refused access for the selected account or team."
      : status === 429
        ? "Vercel rate limit reached. Retry after the provider delay."
        : "Vercel request failed. Retry after checking the selected target.",
    auth ? 403 : status === 429 ? 429 : 502,
    auth ? "EXTERNAL_PROVIDER_ACCESS_DENIED" : status === 429 ? "EXTERNAL_PROVIDER_RATE_LIMIT" : "EXTERNAL_PROVIDER_REQUEST_FAILED",
  );
}

async function defaultRequest(
  path: string,
  options: Required<Pick<VercelApiRequest, "method">> & { query: Record<string, string>; body?: unknown; headers: Record<string, string> },
): Promise<unknown> {
  assertPath(path);
  const url = new URL(path, VERCEL_ORIGIN);
  for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
  const response = await safeFetch(url.href, {
    method: options.method,
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBodyBytes: MAX_BODY_BYTES,
  });
  if (!response.ok) await readProviderError(response);
  try {
    return await response.json();
  } catch {
    throw new AppError("Vercel returned an invalid response.", 502, "EXTERNAL_PROVIDER_RESPONSE_INVALID");
  }
}

/**
 * Construct an account-scoped Vercel client. `apiToken` is accepted only in the
 * composition boundary and is never returned or included in normalized values.
 */
export function createVercelApiClient(
  scope: VercelAccountScope,
  apiToken: string,
  transport: VercelApiRequest["request"] = defaultRequest,
): VercelApiClient {
  if (!scope.connectionId || !scope.accountId)
    throw new AppError("A verified Vercel account scope is required.", 400, "EXTERNAL_PROVIDER_SCOPE_REQUIRED");
  if (!apiToken) throw new AppError("Reconnect Vercel before deploying.", 409, "CONNECTION_RECONNECT_REQUIRED");
  return {
    async request(path: string, options: VercelApiRequest = {}) {
      assertPath(path);
      const method = options.method ?? "GET";
      const headers = {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.headers ?? {}),
      };
      return transport(path, {
        method,
        query: scopedQuery(scope, options.query),
        body: options.body,
        headers,
      });
    },
  };
}

export interface VercelProject {
  id: string;
  name: string;
  accountId: string;
  teamId?: string;
  framework?: string | null;
  link?: unknown;
  targets?: Record<string, unknown>;
}

export const VERCEL_PROJECT_CAPABILITIES = Object.freeze({
  workloadKind: "service" as const,
  supportsSource: true,
  supportsPrebuiltOutput: true,
  supportsVariables: true,
  supportsDomains: true,
  supportsLogs: true,
  supportsExec: false,
  supportsSnapshots: false,
  supportsPersistentStorage: false,
  supportsRollback: true,
});

export interface VercelDeployment {
  id: string;
  url?: string;
  inspectorUrl?: string;
  state?: string;
  readyState?: string;
  target?: string | null;
  projectId?: string;
  createdAt?: string | number;
  buildingAt?: string | number;
  ready?: string | number;
  meta?: Record<string, unknown>;
}

export interface VercelDeploymentObservation {
  kind: "vercel-project-deployment";
  provider: "vercel";
  resourceId: string;
  projectId: string | null;
  status: "queued" | "building" | "ready" | "failed" | "canceled" | "unknown";
  providerStatus: string | null;
  url: string | null;
  inspectorUrl: string | null;
  target: string | null;
  observedAt: string;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function deploymentUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function normalizedStatus(value: unknown): VercelDeploymentObservation["status"] {
  const status = String(value ?? "").toUpperCase();
  if (["READY", "COMPLETE", "COMPLETED"].includes(status)) return "ready";
  if (["ERROR", "FAILED", "FAILURE"].includes(status)) return "failed";
  if (["CANCELED", "CANCELLED"].includes(status)) return "canceled";
  if (["BUILDING", "INITIALIZING", "QUEUED", "ANALYZING", "DEPLOYING"].includes(status))
    return status === "BUILDING" || status === "DEPLOYING" ? "building" : "queued";
  return "unknown";
}

export function normalizeVercelDeployment(value: unknown): VercelDeploymentObservation {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const id = stringValue(row.id) ?? stringValue(row.uid);
  if (!id) throw new AppError("Vercel deployment response did not include an id.", 502, "EXTERNAL_PROVIDER_RESPONSE_INVALID");
  return {
    kind: "vercel-project-deployment",
    provider: "vercel",
    resourceId: id,
    projectId: stringValue(row.projectId),
    status: normalizedStatus(row.readyState ?? row.state ?? row.status),
    providerStatus: stringValue(row.readyState ?? row.state ?? row.status),
    url: deploymentUrl(row.url),
    inspectorUrl: stringValue(row.inspectorUrl),
    target: stringValue(row.target),
    observedAt: new Date().toISOString(),
  };
}

export interface VercelProjectProvider {
  listProjects(): Promise<unknown>;
  getProject(projectIdOrName: string): Promise<unknown>;
  createProject(input: Record<string, unknown>): Promise<unknown>;
  updateProject(projectIdOrName: string, input: Record<string, unknown>): Promise<unknown>;
  createDeployment(input: Record<string, unknown>): Promise<VercelDeploymentObservation>;
  getDeployment(deploymentIdOrUrl: string): Promise<VercelDeploymentObservation>;
  deploymentEvents(deploymentIdOrUrl: string): Promise<unknown>;
  cancelDeployment(deploymentId: string): Promise<unknown>;
  promoteDeployment(deploymentId: string, alias?: string): Promise<unknown>;
}

/** Project deployment operations. Sandbox operations are deliberately separate below. */
export function createVercelProjectProvider(client: VercelApiClient, target: VercelProjectTarget): VercelProjectProvider {
  if (!target.projectId && !target.projectName)
    throw new AppError("A Vercel project target is required.", 400, "EXTERNAL_PROVIDER_TARGET_REQUIRED");
  return {
    listProjects: () => client.request("/v9/projects", { query: { limit: "100" } }),
    getProject: (projectIdOrName) => client.request(`/v9/projects/${encodeURIComponent(projectIdOrName)}`),
    createProject: (input) => client.request("/v9/projects", { method: "POST", body: input }),
    updateProject: (projectIdOrName, input) => client.request(`/v9/projects/${encodeURIComponent(projectIdOrName)}`, { method: "PATCH", body: input }),
    async createDeployment(input) {
      const result = await client.request("/v13/deployments", { method: "POST", body: { ...input, ...(target.projectId ? { project: target.projectId } : {}) } });
      return normalizeVercelDeployment(result);
    },
    async getDeployment(deploymentIdOrUrl) {
      const result = await client.request(`/v13/deployments/${encodeURIComponent(deploymentIdOrUrl)}`);
      return normalizeVercelDeployment(result);
    },
    deploymentEvents: (deploymentIdOrUrl) => client.request(`/v3/deployments/${encodeURIComponent(deploymentIdOrUrl)}/events`),
    cancelDeployment: (deploymentId) => client.request(`/v12/deployments/${encodeURIComponent(deploymentId)}/cancel`, { method: "PATCH" }),
    promoteDeployment: (deploymentId, alias) => client.request(`/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, { method: "POST", body: { alias: alias ?? undefined } }),
  };
}

export type VercelSandboxState = "running" | "stopped" | "starting" | "stopping" | "failed" | "unknown";

export interface VercelSandboxObservation {
  kind: "vercel-sandbox";
  provider: "vercel";
  name: string;
  projectId: string;
  state: VercelSandboxState;
  persistent: boolean;
  sessionId: string | null;
  snapshotId: string | null;
  image: string | null;
  networkPolicy: string | null;
  ports: number[];
  tags: Record<string, string>;
  observedAt: string;
}

export const VERCEL_SANDBOX_CAPABILITIES = Object.freeze({
  workloadKind: "vercel-sandbox" as const,
  supportsExec: true,
  supportsSessions: true,
  supportsFiles: true,
  supportsSnapshots: true,
  supportsPersistent: true,
  supportsNonPersistent: true,
  supportsAutoResume: true,
  supportsCustomImages: true,
  supportsPrivilegedProcesses: true,
  supportsNetworkPolicy: true,
});

function sandboxState(value: unknown): VercelSandboxState {
  const state = String(value ?? "").toLowerCase();
  if (["running", "ready", "active"].includes(state)) return "running";
  if (["stopped", "sleeping", "suspended"].includes(state)) return "stopped";
  if (["starting", "booting", "resuming"].includes(state)) return "starting";
  if (["stopping"].includes(state)) return "stopping";
  if (["failed", "error"].includes(state)) return "failed";
  return "unknown";
}

export function normalizeVercelSandbox(value: unknown, target: { projectId: string }): VercelSandboxObservation {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const name = stringValue(row.name) ?? stringValue(row.sandboxId);
  if (!name) throw new AppError("Vercel Sandbox response did not include a name.", 502, "EXTERNAL_PROVIDER_RESPONSE_INVALID");
  const ports = Array.isArray(row.ports) ? row.ports.filter((port): port is number => typeof port === "number") : [];
  const tags = row.tags && typeof row.tags === "object"
    ? Object.fromEntries(
        Object.entries(row.tags as Record<string, unknown>)
          .filter(([, value]) => typeof value === "string")
          .map(([key, value]) => [key, value as string]),
      )
    : {};
  return {
    kind: "vercel-sandbox",
    provider: "vercel",
    name,
    projectId: target.projectId,
    state: sandboxState(row.status ?? row.state),
    persistent: row.persistent !== false,
    sessionId: stringValue(row.sessionId),
    snapshotId: stringValue(row.snapshotId ?? row.currentSnapshotId),
    image: stringValue(row.image ?? row.imageRef),
    networkPolicy: stringValue(row.networkPolicy),
    ports,
    tags,
    observedAt: new Date().toISOString(),
  };
}

export interface VercelSandboxClient {
  create(input: Record<string, unknown>): Promise<unknown>;
  get(name: string): Promise<unknown>;
  list(input?: Record<string, unknown>): Promise<unknown>;
  runCommand(name: string, input: Record<string, unknown>): Promise<unknown>;
  update(name: string, input: Record<string, unknown>): Promise<unknown>;
  stop(name: string): Promise<unknown>;
  delete(name: string, options?: Record<string, unknown>): Promise<unknown>;
  snapshots?(name: string, input?: Record<string, unknown>): Promise<unknown>;
}

export interface VercelSandboxProvider {
  createOrGet(input: Record<string, unknown>): Promise<VercelSandboxObservation>;
  inspect(name: string): Promise<VercelSandboxObservation>;
  list(input?: Record<string, unknown>): Promise<unknown>;
  runCommand(name: string, input: Record<string, unknown>): Promise<unknown>;
  update(name: string, input: Record<string, unknown>): Promise<VercelSandboxObservation>;
  stop(name: string): Promise<unknown>;
  remove(name: string, options?: Record<string, unknown>): Promise<unknown>;
  snapshots(name: string, input?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Sandbox operations accept the official SDK client at composition time. This
 * keeps the platform package independent of the provider's rapidly changing
 * SDK release while preserving the current V2 sandbox/session contract.
 */
export function createVercelSandboxProvider(
  client: VercelSandboxClient,
  target: { connectionId: string; accountId: string; projectId: string },
): VercelSandboxProvider {
  if (!target.connectionId || !target.accountId || !target.projectId)
    throw new AppError("A verified Vercel project scope is required for Sandboxes.", 400, "EXTERNAL_PROVIDER_SCOPE_REQUIRED");
  return {
    async createOrGet(input) {
      const result = await client.create({ ...input, projectId: target.projectId });
      return normalizeVercelSandbox(result, target);
    },
    async inspect(name) {
      return normalizeVercelSandbox(await client.get(name), target);
    },
    list: (input) => client.list({ ...input, projectId: target.projectId }),
    runCommand: (name, input) => client.runCommand(name, input),
    async update(name, input) {
      return normalizeVercelSandbox(await client.update(name, input), target);
    },
    stop: (name) => client.stop(name),
    remove: (name, options) => client.delete(name, options),
    snapshots: (name, input) => client.snapshots?.(name, input) ?? Promise.reject(new AppError("Vercel Sandbox snapshots are unavailable in this SDK version.", 501, "EXTERNAL_PROVIDER_UNSUPPORTED")),
  };
}

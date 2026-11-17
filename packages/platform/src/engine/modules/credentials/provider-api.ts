import { AppError } from "@repo/core";
import { safeFetch } from "../../lib/safe-fetch";

export type MigrationProvider = "railway" | "vercel";
export type FixedProvider = MigrationProvider | "fly-machines" | "fly-sprites";
export interface ProviderAccess {
  provider: MigrationProvider;
  publicFields: Record<string, string>;
  secrets: Record<string, string>;
}

export const FIXED_PROVIDER_ORIGINS = Object.freeze([
  "https://api.vercel.com",
  "https://backboard.railway.com",
  "https://api.machines.dev",
  "https://api.sprites.dev",
] as const);

/** Fixed provider origins, bounded responses, no redirects, and no upstream
 * response bodies in errors: provider errors can contain credentials or env. */
export async function providerJson<T>(
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<T> {
  if (!(FIXED_PROVIDER_ORIGINS as readonly string[]).includes(url.origin))
    throw new AppError("Unsupported connection endpoint", 400, "CONNECTION_ENDPOINT_INVALID");
  let response;
  try {
    response = await safeFetch(url.href, {
      ...options,
      timeoutMs: 30_000,
      maxBodyBytes: 8 * 1024 * 1024,
    });
  } catch {
    throw new AppError(
      "The provider could not be reached. Retry the connection.",
      502,
      "CONNECTION_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    const auth = response.status === 401 || response.status === 403;
    throw new AppError(
      auth
        ? "The provider refused access. Reconnect with access to the selected workspace and projects."
        : response.status === 429
          ? "The provider rate limit was reached. Wait and retry."
          : "The provider request failed. Retry discovery before importing.",
      auth ? 403 : 502,
      auth ? "CONNECTION_ACCESS_DENIED" : "CONNECTION_REQUEST_FAILED",
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new AppError(
      "The provider returned an invalid response",
      502,
      "CONNECTION_RESPONSE_INVALID",
    );
  }
}

/**
 * Workbox endpoints are operator-configured rather than one global provider
 * origin. The URL is still fetched through safeFetch so DNS is pinned and
 * private/loopback targets remain available only to a self-hosted instance.
 */
export async function workboxReady(
  baseUrl: string,
  apiKey: string,
  options: { allowPrivate?: boolean; allowHttp?: boolean } = {},
): Promise<void> {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new AppError("Workbox endpoint is invalid", 400, "CONNECTION_ENDPOINT_INVALID");
  }
  if (base.protocol !== "https:" && !(options.allowHttp && base.protocol === "http:"))
    throw new AppError("Workbox endpoint must use HTTPS", 400, "CONNECTION_ENDPOINT_INVALID");
  if (!apiKey) throw new AppError("Reconnect Workbox before verifying", 409, "CONNECTION_RECONNECT_REQUIRED");
  // /readyz is public upstream; also verify the bearer against a read-only,
  // authenticated endpoint before saving the connection as verified.
  for (const path of ["readyz", "v1/sandboxes?limit=1"]) {
    const endpoint = new URL(path, `${base.href.replace(/\/$/, "")}/`);
    let response;
    try {
      response = await safeFetch(endpoint.href, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        timeoutMs: 10_000,
        maxBodyBytes: 256 * 1024,
        allowPrivate: options.allowPrivate ?? false,
        allowHttp: options.allowHttp ?? false,
        maxRedirects: 0,
      });
    } catch {
      throw new AppError("Workbox could not be reached. Check the endpoint and retry.", 502, "CONNECTION_UNAVAILABLE");
    }
    if (!response.ok) {
      const auth = response.status === 401 || response.status === 403;
      throw new AppError(
        auth ? "Workbox rejected this scoped API key." : "Workbox readiness check failed. Retry the connection.",
        auth ? 403 : 502,
        auth ? "CONNECTION_ACCESS_DENIED" : "CONNECTION_REQUEST_FAILED",
      );
    }
  }
}

export async function railwayQuery<T>(
  access: ProviderAccess,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = access.secrets.apiToken;
  if (!token)
    throw new AppError("Reconnect Railway before importing", 409, "CONNECTION_RECONNECT_REQUIRED");
  let result: { data?: T; errors?: unknown[] };
  try {
    result = await providerJson<{ data?: T; errors?: unknown[] }>(
      new URL("https://backboard.railway.com/graphql/v2"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(access.publicFields.tokenType === "project"
            ? { "Project-Access-Token": token }
            : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ query, variables }),
      },
    );
  } catch (error) {
    if (/^\s*mutation\b/.test(query) && error instanceof AppError && ["CONNECTION_UNAVAILABLE", "CONNECTION_RESPONSE_INVALID", "CONNECTION_REQUEST_FAILED"].includes(error.code ?? "")) {
      throw new AppError("Railway did not confirm the operation result. Check the provider resource before retrying.", 502, "EXTERNAL_UNKNOWN_OUTCOME");
    }
    throw error;
  }
  if (result.errors?.length || !result.data)
    throw new AppError(
      "Railway could not read the selected resources. Check the connection's scope and retry.",
      502,
      "RAILWAY_QUERY_FAILED",
    );
  return result.data;
}

export function vercelRequest<T>(
  access: ProviderAccess,
  path: string,
  query: Record<string, string> = {},
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Expected a Vercel API path");
  if (!access.secrets.apiToken)
    throw new AppError("Reconnect Vercel before importing", 409, "CONNECTION_RECONNECT_REQUIRED");
  const url = new URL(path, "https://api.vercel.com");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  if (access.publicFields.teamId) url.searchParams.set("teamId", access.publicFields.teamId);
  return providerJson<T>(url, { headers: { Authorization: `Bearer ${access.secrets.apiToken}` } });
}

export async function verifyProviderAccess(access: ProviderAccess): Promise<void> {
  if (access.provider === "vercel") {
    await vercelRequest(access, "/v9/projects", { limit: "1" });
  } else if (access.publicFields.tokenType === "project") {
    await railwayQuery(access, "query { projectToken { project { id } environment { id } } }");
  } else if (access.publicFields.tokenType === "workspace") {
    if (!access.publicFields.workspaceId)
      throw new AppError(
        "A workspace ID is required for this Railway token",
        400,
        "CONNECTION_SCOPE_REQUIRED",
      );
    await railwayQuery(
      access,
      "query($id: String!) { projects(workspaceId: $id, first: 1) { edges { node { id } } } }",
      { id: access.publicFields.workspaceId },
    );
  } else {
    await railwayQuery(access, "query { me { id } }");
  }
}

import { AppError, NotFoundError } from "@repo/core";
import type { ExternalDiscoveryInput, ExternalDiscoveryOutput, ExternalProvider } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { readCredentialSecrets } from "../credentials/credential.service";
import { getProviderAccess } from "../credentials/connection-authorization";
import { providerJson, railwayQuery, type ProviderAccess } from "../credentials/provider-api";
import { migrationProviders } from "../migration/providers";

interface DiscoveryCredential {
  provider: string;
  status: string;
  publicFields: Record<string, string> | null;
  secrets: Record<string, string>;
}

/** Injectable transport boundary; production always resolves an exact org-owned row. */
export interface ExternalDiscoveryDependencies {
  credential(organizationId: string, connectionId: string): Promise<DiscoveryCredential | null>;
  platformAccess(organizationId: string, connectionId: string): Promise<ProviderAccess>;
  projects: typeof migrationProviders;
  railway: typeof railwayQuery;
  json: typeof providerJson;
}

const dependencies: ExternalDiscoveryDependencies = {
  async credential(organizationId, connectionId) {
    const row = await repos.credential.findById(organizationId, connectionId);
    return row ? { provider: row.provider, status: row.status, publicFields: row.publicFields, secrets: readCredentialSecrets(row) } : null;
  },
  platformAccess: getProviderAccess,
  projects: migrationProviders,
  railway: railwayQuery,
  json: providerJson,
};

const named = (value: unknown): { id: string; name: string } => {
  const row = value as { id?: unknown; name?: unknown } | null;
  if (!row || typeof row.id !== "string" || !row.id || typeof row.name !== "string") {
    throw new AppError("The provider returned an invalid resource list.", 502, "CONNECTION_RESPONSE_INVALID");
  }
  return { id: row.id, name: row.name };
};

/** No deployment is created, and provider variables/secrets never enter the response. */
export async function discoverExternalTargets(
  ctx: Pick<ExecutionContext, "organizationId">,
  input: ExternalDiscoveryInput,
  deps = dependencies,
): Promise<ExternalDiscoveryOutput> {
  const credential = await deps.credential(ctx.organizationId, input.connectionId);
  if (!credential) throw new NotFoundError("Credential", input.connectionId);
  if (credential.status !== "active" || !Object.keys(credential.secrets).length) {
    throw new AppError("Reconnect the selected provider before discovering deployment targets.", 409, "CONNECTION_RECONNECT_REQUIRED");
  }
  const provider = credential.provider as ExternalProvider;
  const result: ExternalDiscoveryOutput = {
    provider, connectionId: input.connectionId, projects: [], apps: [], environments: [], images: [], warnings: [],
  };
  if (provider === "railway" || provider === "vercel") {
    const access = await deps.platformAccess(ctx.organizationId, input.connectionId);
    if (access.provider !== provider) throw new AppError("The selected provider connection changed. Refresh and retry.", 409, "CONNECTION_INVALID");
    const projects = await deps.projects[provider].projects(access);
    result.projects = projects.map(project => ({
      ...named(project), environments: project.environments.map(named), services: [],
    }));
    if (input.projectId && !result.projects.some(project => project.id === input.projectId)) {
      throw new AppError("The selected connection cannot access that project.", 403, "EXTERNAL_TARGET_SCOPE_DENIED");
    }
    if (provider === "railway" && input.projectId) {
      const selected = result.projects.find(project => project.id === input.projectId)!;
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const data: { project: { services: { edges: { node: unknown }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } = await deps.railway(access,
          "query($id: String!, $after: String) { project(id: $id) { services(first: 100, after: $after) { edges { node { id name } } pageInfo { hasNextPage endCursor } } } }",
          { id: input.projectId, after: cursor });
        const connection = data?.project?.services;
        if (!Array.isArray(connection?.edges) || !connection.pageInfo) {
          throw new AppError("Railway returned an invalid service list.", 502, "CONNECTION_RESPONSE_INVALID");
        }
        selected.services.push(...connection.edges.map(edge => named(edge.node)));
        if (!connection.pageInfo.hasNextPage) break;
        const next = connection.pageInfo.endCursor;
        if (!next || next === cursor || page === 19) {
          throw new AppError("Railway service discovery is incomplete. Narrow the connection scope.", 502, "EXTERNAL_DISCOVERY_INCOMPLETE");
        }
        cursor = next;
      }
    }
    return result;
  }
  if (provider === "fly") {
    const organization = credential.publicFields?.organizationId;
    if (!organization || !credential.secrets.apiToken) {
      throw new AppError("The Fly connection needs an organization slug and Machines token.", 409, "CONNECTION_RECONNECT_REQUIRED");
    }
    const url = new URL("https://api.machines.dev/v1/apps");
    url.searchParams.set("org_slug", organization);
    // Non-paginated requests retain Fly's documented full-list behaviour.
    const data = await deps.json<{ apps?: Array<{ id: string; name: string; organization?: { slug?: string } }> }>(url, {
      headers: { Authorization: `Bearer ${credential.secrets.apiToken}` },
    });
    if (!Array.isArray(data.apps)) throw new AppError("Fly returned an invalid app list.", 502, "CONNECTION_RESPONSE_INVALID");
    result.apps = data.apps.filter(app => !app.organization?.slug || app.organization.slug === organization).map(named);
    if (!credential.secrets.spriteToken) result.warnings.push("Fly Sprites requires a separate Sprites token. This connection currently supports Machines.");
    return result;
  }
  if (provider === "workbox") {
    result.warnings.push("Workbox does not expose an environment, rootfs or runtime catalog over its API. Enter a rootfs and runtime prepared on the connected Workbox host.");
    return result;
  }
  if (provider === "blaxel") {
    result.warnings.push("Use a Blaxel registry image available to this workspace, or a public blaxel sandbox image. Applications require Blaxel private-preview access.");
    return result;
  }
  throw new AppError("Select a connected cloud provider. Self-managed servers use the server deployment flow.", 422, "EXTERNAL_PROVIDER_UNAVAILABLE");
}

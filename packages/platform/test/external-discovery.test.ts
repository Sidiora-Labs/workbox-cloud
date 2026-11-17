import { describe, expect, it, vi } from "vitest";
import { discoverExternalTargets, type ExternalDiscoveryDependencies } from "../src/engine/modules/external-deployments/external.discovery";

vi.mock("@repo/db", () => ({ repos: { credential: {} } }));
vi.mock("../src/engine/modules/credentials/credential.service", () => ({ readCredentialSecrets: vi.fn() }));
vi.mock("../src/engine/modules/credentials/connection-authorization", () => ({ getProviderAccess: vi.fn() }));
vi.mock("../src/engine/modules/credentials/provider-api", () => ({ providerJson: vi.fn(), railwayQuery: vi.fn() }));
vi.mock("../src/engine/modules/migration/providers", () => ({ migrationProviders: {} }));

const context = { organizationId: "org-a" };
const input = { connectionId: "credential-a" };
function setup(provider = "railway") {
  const credential = vi.fn().mockResolvedValue({
    provider, status: "active", publicFields: { organizationId: "fly-org" },
    secrets: { apiToken: "private-token" },
  });
  const projects = vi.fn().mockResolvedValue([{ id: "project-a", name: "Project A", environments: [{ id: "env-a", name: "Production" }], private: "never-return" }]);
  const platformAccess = vi.fn().mockResolvedValue({ provider, publicFields: {}, secrets: { apiToken: "private-token" } });
  const railway = vi.fn();
  const json = vi.fn();
  const deps = {
    credential, platformAccess, projects: { railway: { projects }, vercel: { projects } }, railway, json,
  } as unknown as ExternalDiscoveryDependencies;
  return { deps, credential, projects, platformAccess, railway, json };
}

describe("external target discovery", () => {
  it("looks up the exact organization credential and rejects missing rows before provider access", async () => {
    const fixture = setup();
    fixture.credential.mockResolvedValue(null);
    await expect(discoverExternalTargets(context, input, fixture.deps)).rejects.toMatchObject({ statusCode: 404 });
    expect(fixture.credential).toHaveBeenCalledWith("org-a", "credential-a");
    expect(fixture.platformAccess).not.toHaveBeenCalled();
    expect(fixture.json).not.toHaveBeenCalled();
  });

  it("rejects revoked credentials before network calls", async () => {
    const fixture = setup();
    fixture.credential.mockResolvedValue({ provider: "railway", status: "invalid", publicFields: {}, secrets: { apiToken: "private-token" } });
    await expect(discoverExternalTargets(context, input, fixture.deps)).rejects.toMatchObject({ code: "CONNECTION_RECONNECT_REQUIRED" });
    expect(fixture.platformAccess).not.toHaveBeenCalled();
  });

  it("projects only public names and IDs from refreshed platform access", async () => {
    const fixture = setup("vercel");
    const result = await discoverExternalTargets(context, input, fixture.deps);
    expect(fixture.platformAccess).toHaveBeenCalledWith("org-a", "credential-a");
    expect(result.projects).toEqual([{ id: "project-a", name: "Project A", environments: [{ id: "env-a", name: "Production" }], services: [] }]);
    expect(JSON.stringify(result)).not.toMatch(/private-token|never-return/);
  });

  it("cannot query a Railway project outside the credential inventory", async () => {
    const fixture = setup();
    await expect(discoverExternalTargets(context, { ...input, projectId: "foreign-project" }, fixture.deps)).rejects.toMatchObject({ code: "EXTERNAL_TARGET_SCOPE_DENIED" });
    expect(fixture.railway).not.toHaveBeenCalled();
  });

  it("paginates selected Railway service names without fetching service variables", async () => {
    const fixture = setup();
    fixture.railway
      .mockResolvedValueOnce({ project: { services: { edges: [{ node: { id: "service-a", name: "Web", variables: { PASSWORD: "never-return" } } }], pageInfo: { hasNextPage: true, endCursor: "next" } } } })
      .mockResolvedValueOnce({ project: { services: { edges: [{ node: { id: "service-b", name: "Worker" } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    const result = await discoverExternalTargets(context, { ...input, projectId: "project-a" }, fixture.deps);
    expect(result.projects[0].services).toEqual([{ id: "service-a", name: "Web" }, { id: "service-b", name: "Worker" }]);
    expect(fixture.railway.mock.calls[1][2]).toEqual({ id: "project-a", after: "next" });
    expect(fixture.railway.mock.calls[0][1]).not.toMatch(/variables|environmentVariables/);
    expect(JSON.stringify(result)).not.toContain("never-return");
  });

  it("fails incomplete Railway pagination instead of displaying a silently truncated inventory", async () => {
    const fixture = setup();
    fixture.railway.mockResolvedValue({ project: { services: { edges: [], pageInfo: { hasNextPage: true, endCursor: null } } } });
    await expect(discoverExternalTargets(context, { ...input, projectId: "project-a" }, fixture.deps)).rejects.toMatchObject({ code: "EXTERNAL_DISCOVERY_INCOMPLETE" });
  });

  it("binds Fly requests to the saved organization and filters an unexpected foreign app", async () => {
    const fixture = setup("fly");
    fixture.json.mockResolvedValue({ apps: [
      { id: "app-a", name: "Our app", organization: { slug: "fly-org" }, secret: "never-return" },
      { id: "app-b", name: "Foreign app", organization: { slug: "foreign-org" } },
    ] });
    const result = await discoverExternalTargets(context, input, fixture.deps);
    const [url, options] = fixture.json.mock.calls[0];
    expect(url.href).toBe("https://api.machines.dev/v1/apps?org_slug=fly-org");
    expect(options.headers.Authorization).toBe("Bearer private-token");
    expect(result.apps).toEqual([{ id: "app-a", name: "Our app" }]);
    expect(result.warnings[0]).toContain("separate Sprites token");
    expect(JSON.stringify(result)).not.toMatch(/private-token|never-return/);
  });

  it("reports unavailable Workbox catalogs explicitly without guessing API paths", async () => {
    const fixture = setup("workbox");
    const result = await discoverExternalTargets(context, input, fixture.deps);
    expect(result.environments).toEqual([]);
    expect(result.images).toEqual([]);
    expect(result.warnings[0]).toContain("does not expose");
    expect(fixture.json).not.toHaveBeenCalled();
  });
});

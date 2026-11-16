import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";

const target = {
  provider: "vercel" as const,
  workloadKind: "vercel-sandbox" as const,
  connectionId: "vercel-account-a",
  providerIdentity: { organizationId: "org-1", accountId: "acct-a", teamId: "team-a" },
  resource: { projectId: "project-a", name: "agent-a" },
};

const profile = {
  provider: "vercel" as const,
  workloadKind: "vercel-sandbox" as const,
  checkedAt: "2026-11-16T00:00:00Z",
  supported: ["apply", "observe", "exec", "session", "snapshot", "stop", "resume", "destroy"],
  unsupported: [],
  limits: { maxMemoryMb: 2048 },
  observedIdentity: { organizationId: "org-1", accountId: "acct-a" },
};

describe("SDK external deployment operations", () => {
  it("lists explicit provider targets without exposing credential secrets", async () => {
    const targets = [{
      targetId: "target-1",
      organizationId: "org-1",
      provider: "vercel" as const,
      workloadKind: "vercel-sandbox" as const,
      connectionId: "vercel-account-a",
      providerIdentity: { accountId: "acct-a" },
      resource: { projectId: "project-a", name: "agent-a" },
      capturedAt: "2026-11-16T00:00:00Z",
    }];
    const fetcher = vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe("/api/external-deployments/targets");
      return Response.json({ data: targets });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", token: "token", fetch: fetcher });
    await expect(client.externalDeployments.targets()).resolves.toEqual(targets);
  });

  it("sends explicit target identity and unwraps capability responses", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new URL(url).pathname).toBe("/api/external-deployments/capabilities");
      expect(JSON.parse(String(init?.body))).toEqual(target);
      return Response.json({ data: profile });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", token: "token", fetch: fetcher });
    await expect(client.externalDeployments.capabilities(target)).resolves.toEqual(profile);
  });

  it("rejects malformed provider responses", async () => {
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: vi.fn(async () => Response.json({ data: { provider: "vercel" } })),
    });
    await expect(client.externalDeployments.capabilities(target)).rejects.toMatchObject({ status: 502 });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createVercelApiClient,
  createVercelProjectProvider,
  createVercelSandboxProvider,
  normalizeVercelDeployment,
  normalizeVercelSandbox,
} from "./vercel";

describe("Vercel external provider adapters", () => {
  it("keeps team scope on every API request", async () => {
    const request = vi.fn(async () => ({ projects: [] }));
    const client = createVercelApiClient(
      { connectionId: "conn-a", accountId: "acct-a", teamId: "team-a" },
      "token-a",
      request,
    );
    await client.request("/v9/projects", { query: { limit: 10 } });
    expect(request).toHaveBeenCalledWith("/v9/projects", {
      method: "GET",
      query: { limit: "10", teamId: "team-a" },
      body: undefined,
      headers: { Authorization: "Bearer token-a", Accept: "application/json" },
    });
  });

  it("normalizes project deployments without leaking provider metadata", () => {
    expect(
      normalizeVercelDeployment({
        uid: "dpl_1",
        projectId: "prj_1",
        readyState: "READY",
        url: "example.vercel.app",
        meta: { token: "must-not-be-returned" },
      }),
    ).toMatchObject({
      kind: "vercel-project-deployment",
      resourceId: "dpl_1",
      projectId: "prj_1",
      status: "ready",
      url: "https://example.vercel.app",
    });
    expect(normalizeVercelDeployment({ uid: "dpl_1" })).not.toHaveProperty("meta");
  });

  it("normalizes current persistent Vercel Sandbox state", () => {
    expect(
      normalizeVercelSandbox(
        {
          name: "agent-a",
          state: "stopped",
          persistent: true,
          currentSnapshotId: "snap_1",
          ports: [3000, "bad"],
          tags: { owner: "alice", count: 2 },
        },
        { projectId: "prj_1" },
      ),
    ).toMatchObject({
      kind: "vercel-sandbox",
      name: "agent-a",
      projectId: "prj_1",
      state: "stopped",
      persistent: true,
      snapshotId: "snap_1",
      ports: [3000],
      tags: { owner: "alice" },
    });
  });

  it("keeps project deployments and sandbox operations separate", async () => {
    const projectClient = {
      request: vi.fn(async (path: string) =>
        path === "/v13/deployments" ? { id: "dpl_1", readyState: "QUEUED" } : { projects: [] },
      ),
    };
    const projects = createVercelProjectProvider(projectClient, {
      connectionId: "conn-a",
      accountId: "acct-a",
      projectId: "prj_1",
    });
    await expect(projects.createDeployment({ name: "app" })).resolves.toMatchObject({
      kind: "vercel-project-deployment",
      status: "queued",
    });

    const sandboxClient = {
      create: vi.fn(async () => ({ name: "sbx_1", state: "running" })),
      get: vi.fn(),
      list: vi.fn(),
      runCommand: vi.fn(),
      update: vi.fn(),
      stop: vi.fn(),
      delete: vi.fn(),
    };
    const sandboxes = createVercelSandboxProvider(sandboxClient, {
      connectionId: "conn-a",
      accountId: "acct-a",
      projectId: "prj_1",
    });
    await expect(sandboxes.createOrGet({ name: "agent-a", persistent: true })).resolves.toMatchObject({
      kind: "vercel-sandbox",
      name: "sbx_1",
      state: "running",
    });
    expect(sandboxClient.create).toHaveBeenCalledWith({
      name: "agent-a",
      persistent: true,
      projectId: "prj_1",
    });
  });
});

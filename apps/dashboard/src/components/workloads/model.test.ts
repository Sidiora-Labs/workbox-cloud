import { describe, expect, it } from "vitest";
import type { ExternalOperation } from "@repo/contracts";
import type { Credential } from "@/lib/api/credentials";
import { currentWorkloads, initialDraft, launchInput, parseVariables } from "./model";
const connection = (provider: string): Credential => ({
  id: "cred-chosen",
  provider,
  providerLabel: provider,
  name: "Selected account",
  selector: null,
  publicFields: { teamId: "team-2" },
  secretsMasked: { apiToken: "***" },
  status: "active",
  lastVerifiedAt: null,
  lastError: null,
  createdAt: "",
  updatedAt: "",
});
describe("workload launch requests", () => {
  it("binds a Vercel sandbox to the explicitly chosen account and project", () => {
    const input = launchInput(
      "vercel",
      "vercel-sandbox",
      connection("vercel"),
      {
        ...initialDraft,
        name: "dev",
        projectId: "project-7",
        variables: "TOKEN=has=equals\nEMPTY=",
        persistent: false,
        timeoutMinutes: "15",
      },
      "review-001",
    );
    expect(input.target).toMatchObject({
      connectionId: "cred-chosen",
      providerIdentity: { teamId: "team-2" },
      resource: { projectId: "project-7", name: "dev", persistent: "false", timeoutMs: "900000" },
    });
    expect(input.environment).toEqual({ TOKEN: "has=equals", EMPTY: "" });
    expect(JSON.stringify(input.target)).not.toContain("has=equals");
  });
  it("keeps a Railway service and a Railway sandbox distinct", () => {
    const draft = {
      ...initialDraft,
      name: "web",
      projectId: "project",
      environmentId: "production",
      image: "registry/app:v1",
    };
    expect(
      launchInput("railway", "service", connection("railway"), draft, "review-002").target.resource
        .serviceId,
    ).toBeUndefined();
    const sandbox = launchInput(
      "railway",
      "railway-sandbox",
      connection("railway"),
      { ...draft, image: "", networkIsolation: "ISOLATED", memoryGB: "2" },
      "review-003",
    );
    expect(sandbox.target.resource).toMatchObject({
      networkIsolation: "ISOLATED",
      memoryGB: "2",
      idleTimeoutMinutes: "30",
    });
    expect(sandbox.image).toBeUndefined();
  });
  it("requires a Fly application and image", () => {
    expect(() =>
      launchInput(
        "fly",
        "fly-machine",
        connection("fly"),
        { ...initialDraft, name: "web" },
        "review-004",
      ),
    ).toThrow("Fly application");
    expect(() =>
      launchInput(
        "fly",
        "fly-machine",
        connection("fly"),
        { ...initialDraft, name: "web", appName: "chosen-app" },
        "review-005",
      ),
    ).toThrow("container image");
    expect(
      launchInput(
        "fly",
        "fly-machine",
        connection("fly"),
        { ...initialDraft, name: "web", appName: "chosen-app", image: "alpine:3", createApp: true },
        "review-006",
      ).target.resource,
    ).toMatchObject({ appName: "chosen-app", createApp: "true" });
  });
  it("honours the chosen branch when deploying a Vercel project's linked repository", () => {
    const input = launchInput("vercel", "service", connection("vercel"), {
      ...initialDraft, name: "preview", projectId: "project-a", branch: "staging",
    }, "review-linked-repo");
    expect(input.source).toEqual({ ref: "staging" });
  });
  it("validates environment assignments and preserves embedded equals", () => {
    expect(parseVariables("# comment\nA=b=c\n")).toEqual({ A: "b=c" });
    expect(() => parseVariables("missing-value")).toThrow("NAME=value");
    expect(() => parseVariables("BAD KEY=x")).toThrow("NAME=value");
  });
  it("exposes one current operation per resource and excludes un-applied plans", () => {
    const op = (id: string, targetId: string, kind: ExternalOperation["kind"], updatedAt: string) =>
      ({
        id,
        targetId,
        kind,
        updatedAt,
        providerResourceId: kind === "plan" ? undefined : `resource-${targetId}`,
      }) as ExternalOperation;
    const rows = [
      op("old", "a", "apply", "2026-01-01"),
      op("new", "a", "observe", "2026-01-02"),
      op("plan-only", "b", "plan", "2026-01-03"),
    ];
    expect(currentWorkloads(rows).map((row) => row.id)).toEqual(["new"]);
  });
});

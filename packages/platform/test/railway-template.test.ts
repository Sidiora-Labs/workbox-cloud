import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import type { ExternalOperation, ExternalPlan, ExternalTargetInput } from "@repo/contracts";
import fixture from "./fixtures/railway-postgres-template.json";
import { railwayQuery } from "../src/engine/modules/credentials/provider-api";
import { env } from "../src/engine/config/env";
import {
  createRailwayTemplateAdapter,
  railwayTemplateHash,
  railwayTemplateVariables,
} from "../src/engine/modules/external-deployments/providers/railway-template";
vi.mock("../src/engine/modules/credentials/provider-api", () => ({ railwayQuery: vi.fn() }));
vi.mock("../src/engine/modules/apps/catalog-source", async () => {
  const fixture = (await import("./fixtures/railway-postgres-template.json")).default;
  const { createHash } = await import("node:crypto");
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return {
    getRuntimeTemplate: () => ({
      id: "postgresql",
      deploymentRecipes: [
        {
          id: "railway",
          provider: "railway",
          resource: { createProject: "true" },
          source: {
            templateCode: "postgres",
            templateId: fixture.data.template.id,
            templateConfigSha256: createHash("sha256")
              .update(JSON.stringify(canonical(fixture.data.template.serializedConfig)))
              .digest("hex"),
          },
        },
      ],
    }),
  };
});

const query = vi.mocked(railwayQuery);
const context = { organizationId: "org-one" };
const target: ExternalTargetInput = {
  provider: "railway",
  workloadKind: "service",
  connectionId: "cred-one",
  providerIdentity: { workspaceId: "workspace-one" },
  resource: {
    name: "my-database",
    createProject: "true",
    appTemplateId: "postgresql",
    appRecipeId: "railway",
  },
};
function withProof(operation: ExternalOperation) {
  operation.target.resource.expectedServiceNames ??= "[]";
  operation.target.resource.managedProjectProof = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(
      JSON.stringify([
        operation.target.organizationId,
        operation.target.connectionId,
        operation.target.resource.appTemplateId,
        operation.target.resource.appRecipeId,
        operation.target.resource.projectId,
        operation.target.resource.ownershipMarker,
        operation.target.resource.expectedServiceNames,
      ]),
    )
    .digest("hex");
  return operation;
}
const adapter = () =>
  createRailwayTemplateAdapter(async () => ({
    publicFields: { workspaceId: "workspace-one", tokenType: "workspace" },
    secrets: { apiToken: "secret" },
  }));
const project = (description: string) => ({
  id: "project-one",
  name: "my-database",
  description,
  workspaceId: "workspace-one",
  environments: { edges: [{ node: { id: "env-one", name: "production" } }] },
  services: { edges: [] },
});
beforeEach(() => {
  query.mockReset();
});
describe("Railway catalog template lifecycle", () => {
  it("retains the entire graph and replaces only declared variable values", () => {
    const graph = fixture.data.template.serializedConfig;
    const output = railwayTemplateVariables(graph, { "Postgres.POSTGRES_DB": "application" });
    const id = Object.keys(graph.services)[0]!;
    expect(output.services[id]!.volumeMounts).toEqual(
      graph.services[id as keyof typeof graph.services].volumeMounts,
    );
    expect(output.services[id]!.haConversionConfig).toEqual(
      graph.services[id as keyof typeof graph.services].haConversionConfig,
    );
    expect(
      (output.services[id]!.variables as Record<string, { value?: string }>).POSTGRES_DB!.value,
    ).toBe("application");
    expect(
      (output.services[id]!.variables as Record<string, { value?: string }>).POSTGRES_PASSWORD!
        .value,
    ).toContain("secret(");
    expect(() => railwayTemplateVariables(graph, { "Other.SECRET": "unknown" })).toThrow(
      "not supported",
    );
  });
  it("blocks changed upstream graphs and project-scoped credentials during review", async () => {
    query.mockImplementation(async (_auth, text) =>
      text.includes("template(")
        ? ({ template: { ...fixture.data.template, serializedConfig: { services: {} } } } as never)
        : ({} as never),
    );
    await expect(adapter().preflight(context, target)).rejects.toMatchObject({
      code: "EXTERNAL_TEMPLATE_REVISION_CHANGED",
    });
    const limited = createRailwayTemplateAdapter(async () => ({
      publicFields: { tokenType: "project" },
      secrets: { apiToken: "secret" },
    }));
    await expect(limited.preflight(context, target)).rejects.toMatchObject({
      code: "EXTERNAL_TEMPLATE_SCOPE_REQUIRED",
    });
  });
  it("creates a dedicated owned project and preserves template identity on uncertain workflow completion", async () => {
    let marker = "";
    query.mockImplementation(async (_auth, text, variables) => {
      if (text.includes("template(")) return { template: fixture.data.template } as never;
      if (text.includes("projectCreate")) {
        marker = (variables!.input as { description: string }).description;
        return { projectCreate: project(marker) } as never;
      }
      if (text.includes("templateDeployV2"))
        return {
          templateDeployV2: { projectId: "project-one", workflowId: "workflow-one" },
        } as never;
      if (text.includes("project(id:")) return { project: project(marker) } as never;
      if (text.includes("workflowStatus"))
        return { workflowStatus: { status: "Running" } } as never;
      return {} as never;
    });
    const source = {
      templateCode: "postgres",
      templateId: fixture.data.template.id,
      templateConfigSha256: railwayTemplateHash(fixture.data.template.serializedConfig),
    };
    const plan = await adapter().plan(context, {
      target,
      environment: { "Postgres.POSTGRES_DB": "app" },
      idempotencyKey: "test-template-plan",
    });
    const applied = await adapter().apply(
      context,
      { planId: plan.planId, confirm: true, idempotencyKey: "test-template-apply" },
      { ...plan, source, environment: { "Postgres.POSTGRES_DB": "app" } } as ExternalPlan,
    );
    expect(applied.providerResourceId).toBe("project-one");
    expect(applied.target.resource.workflowId).toBe("workflow-one");
    expect(applied.target.resource.ownershipMarker).toBe(marker);
    expect(applied.status).toBe("provisioning");
    const deployment = query.mock.calls.find(([, text]) => text.includes("templateDeployV2"));
    expect((deployment![2]!.input as { serializedConfig: unknown }).serializedConfig).toBeTypeOf(
      "object",
    );
  });
  it("never deletes a project with a changed owner or newly added services", async () => {
    const operation = {
      target: {
        ...target,
        targetId: "target-one",
        organizationId: context.organizationId,
        capturedAt: new Date().toISOString(),
        resource: {
          ...target.resource,
          projectId: "project-one",
          ownershipMarker: "own-marker",
          templateServiceIds: '["owned-service"]',
        },
      },
    } as ExternalOperation;
    query.mockResolvedValue({ project: project("foreign-marker") } as never);
    withProof(operation);
    await expect(adapter().destroy!(context, operation)).rejects.toMatchObject({
      code: "EXTERNAL_OWNERSHIP_CONFLICT",
    });
    query.mockResolvedValue({
      project: {
        ...project("own-marker"),
        services: { edges: [{ node: { id: "foreign-service", name: "foreign" } }] },
      },
    } as never);
    withProof(operation);
    await expect(adapter().destroy!(context, operation)).rejects.toMatchObject({
      code: "EXTERNAL_OWNERSHIP_CONFLICT",
    });
    expect(query.mock.calls.every(([, text]) => !text.includes("projectDelete"))).toBe(true);
  });
  it("deletes only an owned project and returns stopped", async () => {
    const operation = {
      target: {
        ...target,
        targetId: "target-one",
        organizationId: context.organizationId,
        capturedAt: new Date().toISOString(),
        resource: {
          ...target.resource,
          projectId: "project-one",
          ownershipMarker: "own-marker",
          templateServiceIds: "[]",
        },
      },
    } as ExternalOperation;
    query.mockImplementation(async (_auth, text) =>
      text.includes("projectDelete")
        ? ({ projectDelete: true } as never)
        : ({ project: project("own-marker") } as never),
    );
    withProof(operation);
    expect((await adapter().destroy!(context, operation)).status).toBe("stopped");
    expect(query.mock.calls.at(-1)?.[2]).toEqual({ id: "project-one" });
  });
  it("does not adopt manually added services while refreshing or reading logs", async () => {
    const operation = withProof({
      target: {
        ...target,
        targetId: "target-one",
        organizationId: context.organizationId,
        capturedAt: new Date().toISOString(),
        resource: {
          ...target.resource,
          projectId: "project-one",
          environmentId: "env-one",
          ownershipMarker: "own-marker",
          templateServiceIds: '["owned-service"]',
          expectedServiceNames: '["Postgres"]',
        },
      },
    } as ExternalOperation);
    query.mockResolvedValue({
      project: {
        ...project("own-marker"),
        services: {
          edges: [
            { node: { id: "owned-service", name: "Postgres" } },
            { node: { id: "manual-service", name: "Unrelated" } },
          ],
        },
      },
    } as never);
    await expect(adapter().observe(context, { target: operation.target })).rejects.toMatchObject({
      code: "EXTERNAL_OWNERSHIP_CONFLICT",
    });
    const logs = async () => {
      for await (const _row of adapter().logs!(context, operation)) {
        /* consume */
      }
    };
    await expect(logs()).rejects.toMatchObject({ code: "EXTERNAL_OWNERSHIP_CONFLICT" });
    expect(operation.target.resource.templateServiceIds).toBe('["owned-service"]');
    expect(
      query.mock.calls.every(
        ([, text]) => !text.includes("environmentLogs") && !text.includes("projectDelete"),
      ),
    ).toBe(true);
  });
});

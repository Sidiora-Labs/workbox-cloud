import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../../config/env";
import { AppError } from "@repo/core";
import type {
  ExternalCapabilityProfile,
  ExternalOperation,
  ExternalPlan,
  ExternalPlanInput,
  ExternalTargetInput,
  ExternalTargetSnapshot,
} from "@repo/contracts";
import type {
  ExternalProviderAdapter,
  ExternalProviderContext,
} from "../../../../external-deployments";
import { railwayQuery, type ProviderAccess } from "../../credentials/provider-api";
import { getRuntimeTemplate } from "../../apps/catalog-source";
import type { RailwayCredentialResolver } from "./railway-external";

const now = () => new Date().toISOString();
const supported = [
  "discover",
  "preflight",
  "apply",
  "observe",
  "logs",
  "destroy",
  "reconcile",
  "public-ingress",
  "persistent-storage",
  "private-network",
] as const;
type TemplateSource = Record<string, string>;
type Template = {
  id: string;
  name: string;
  serializedConfig: { services: Record<string, Record<string, unknown>>; [key: string]: unknown };
};
type Project = {
  id: string;
  name: string;
  description?: string | null;
  workspaceId?: string | null;
  environments: { edges: { node: { id: string; name: string } }[] };
  services: { edges: { node: { id: string; name: string } }[] };
};
const PROJECT_FIELDS =
  "id name description workspaceId environments(first: 100) { edges { node { id name } } } services(first: 100) { edges { node { id name } } }";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
}
export const railwayTemplateHash = (config: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(config)))
    .digest("hex");
function recipeSource(target: ExternalTargetInput): TemplateSource {
  const app = getRuntimeTemplate(target.resource.appTemplateId);
  const recipe = app?.deploymentRecipes?.find(
    (row) => row.id === target.resource.appRecipeId && row.provider === "railway",
  );
  if (!app || !recipe || !recipe.source?.templateCode || recipe.resource?.createProject !== "true")
    throw new AppError(
      "Select a supported Railway template from Apps.",
      400,
      "EXTERNAL_TEMPLATE_INVALID",
    );
  return recipe.source;
}
function snapshot(
  context: ExternalProviderContext,
  target: ExternalTargetInput,
): ExternalTargetSnapshot {
  return {
    ...target,
    targetId: String(target.resource.name ?? target.connectionId),
    organizationId: context.organizationId,
    capturedAt: now(),
  };
}
function capability(target: ExternalTargetInput): ExternalCapabilityProfile {
  return {
    provider: "railway",
    workloadKind: "service",
    checkedAt: now(),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    supported: [...supported],
    unsupported: [],
    limits: { deploymentScope: "Dedicated project; deletion removes all template data" },
    observedIdentity: target.providerIdentity,
  };
}
function result(
  target: ExternalTargetSnapshot,
  status: ExternalOperation["status"],
  message?: string,
): ExternalOperation {
  return {
    id: `railway-template:${target.resource.projectId ?? target.targetId}`,
    organizationId: target.organizationId,
    targetId: target.targetId,
    kind: "apply",
    workloadKind: "service",
    status,
    idempotencyKey: "railway-template-operation",
    target,
    ...(target.resource.projectId ? { providerResourceId: target.resource.projectId } : {}),
    ...(target.resource.workflowId ? { providerRequestId: target.resource.workflowId } : {}),
    ...(message ? { message } : {}),
    createdAt: now(),
    updatedAt: now(),
  };
}
function workspace(access: ProviderAccess, target: ExternalTargetInput): string {
  const saved = access.publicFields.workspaceId;
  if (!saved || access.publicFields.tokenType === "project")
    throw new AppError(
      "This template needs a Railway workspace connection that can create projects.",
      422,
      "EXTERNAL_TEMPLATE_SCOPE_REQUIRED",
    );
  if (target.providerIdentity.workspaceId && target.providerIdentity.workspaceId !== saved)
    throw new AppError(
      "The selected Railway workspace does not match this connection.",
      403,
      "EXTERNAL_TARGET_SCOPE_DENIED",
    );
  return saved;
}
async function template(access: ProviderAccess, source: TemplateSource): Promise<Template> {
  const response = await railwayQuery<{ template: Template }>(
    access,
    "query($code:String!){template(code:$code){id name serializedConfig}}",
    { code: source.templateCode },
  );
  const value = response.template;
  if (
    !value?.serializedConfig?.services ||
    value.id !== source.templateId ||
    railwayTemplateHash(value.serializedConfig) !== source.templateConfigSha256
  )
    throw new AppError(
      "This Railway template changed since it was reviewed. Refresh its catalog recipe before deployment.",
      409,
      "EXTERNAL_TEMPLATE_REVISION_CHANGED",
    );
  return value;
}
export function railwayTemplateVariables(
  config: Template["serializedConfig"],
  values: Record<string, string> = {},
) {
  const output = structuredClone(config);
  const recognized = new Set<string>();
  for (const service of Object.values(output.services)) {
    const variables = object(service.variables);
    for (const [key, raw] of Object.entries(variables)) {
      if (raw === null) continue;
      const variable = object(raw);
      const scoped = `${service.name}.${key}`;
      recognized.add(scoped);
      const selected =
        values[scoped] ??
        (typeof variable.defaultValue === "string" && variable.defaultValue
          ? variable.defaultValue
          : undefined);
      if (selected !== undefined) variable.value = selected;
      else if (variable.isOptional !== true && typeof variable.value !== "string")
        throw new AppError(
          `The template requires ${scoped}.`,
          400,
          "EXTERNAL_TEMPLATE_INPUT_REQUIRED",
        );
      variables[key] = variable;
    }
  }
  if (Object.keys(values).some((key) => !recognized.has(key)))
    throw new AppError(
      "One or more inputs are not supported by this Railway template.",
      400,
      "EXTERNAL_TEMPLATE_INPUT_INVALID",
    );
  return output;
}
async function project(access: ProviderAccess, id: string) {
  return (
    await railwayQuery<{ project: Project }>(
      access,
      `query($id:String!){project(id:$id){${PROJECT_FIELDS}}}`,
      { id },
    )
  ).project;
}
function ownershipProof(target: ExternalTargetSnapshot): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(JSON.stringify([target.organizationId, target.connectionId, target.resource.appTemplateId, target.resource.appRecipeId, target.resource.projectId, target.resource.ownershipMarker, target.resource.expectedServiceNames])).digest("hex");
}
function owned(access: ProviderAccess, target: ExternalTargetSnapshot, live: Project) {
  const proof = target.resource.managedProjectProof;
  const expectedProof = ownershipProof(target);
  if (!proof || proof.length !== expectedProof.length || !timingSafeEqual(Buffer.from(proof), Buffer.from(expectedProof))) throw new AppError("The Railway project has no valid installation ownership receipt.", 409, "EXTERNAL_OWNERSHIP_CONFLICT");
  if (
    !target.resource.ownershipMarker ||
    live.id !== target.resource.projectId ||
    live.description !== target.resource.ownershipMarker ||
    live.workspaceId !== workspace(access, target)
  )
    throw new AppError(
      "The Railway project no longer matches the recorded Workbox Cloud owner.",
      409,
      "EXTERNAL_OWNERSHIP_CONFLICT",
    );
}
async function observeProject(
  access: ProviderAccess,
  target: ExternalTargetSnapshot,
): Promise<ExternalOperation> {
  const live = await project(access, target.resource.projectId!);
  owned(access, target, live);
  const environments = live.environments.edges.map((x) => x.node);
  const environmentId =
    target.resource.environmentId ??
    environments.find((x) => x.name === "production")?.id ??
    environments[0]?.id;
  const liveServices = live.services.edges.map((x) => x.node);
  const expectedNames = JSON.parse(target.resource.expectedServiceNames ?? "[]") as string[];
  const capturedIds = JSON.parse(target.resource.templateServiceIds ?? "[]") as string[];
  if (liveServices.some(row => capturedIds.length ? !capturedIds.includes(row.id) : !expectedNames.includes(row.name))) throw new AppError("The project has services outside the installed template. Inspect the added services before managing this installation.", 409, "EXTERNAL_OWNERSHIP_CONFLICT");
  const serviceIds = capturedIds.length ? capturedIds : liveServices.map(x => x.id);
  const captured: ExternalTargetSnapshot = {
    ...target,
    resource: {
      ...target.resource,
      ...(environmentId ? { environmentId } : {}),
      ...(capturedIds.length ? {} : { templateServiceNames: JSON.stringify(liveServices.map((x) => x.name)) }),
    },
  };
  if (target.resource.workflowId) {
    const workflow = (
      await railwayQuery<{ workflowStatus: { status: string } }>(
        access,
        "query($id:String!){workflowStatus(workflowId:$id){status}}",
        { id: target.resource.workflowId },
      )
    ).workflowStatus;
    if (workflow.status === "Error")
      return result(
        captured,
        "failed",
        "Railway could not finish the template workflow. Inspect its resources before retrying.",
      );
    if (workflow.status === "Running") return result(captured, "provisioning");
    if (workflow.status === "NotFound")
      return result(
        captured,
        "action_required",
        "Railway no longer retains this template workflow. Inspect the project resources.",
      );
  }
  if (!environmentId || serviceIds.length !== expectedNames.length) return result(captured, "provisioning");
  if (!capturedIds.length) captured.resource.templateServiceIds = JSON.stringify(serviceIds);
  const environment = (
    await railwayQuery<{
      environment: {
        serviceInstances: {
          edges: {
            node: {
              serviceId: string;
              serviceName: string;
              activeDeployments: { id: string; status: string; deploymentStopped?: boolean }[];
              domains: { serviceDomains: { domain: string }[] };
            };
          }[];
        };
      };
    }>(
      access,
      "query($id:String!,$project:String!){environment(id:$id,projectId:$project){serviceInstances(first:100){edges{node{serviceId serviceName activeDeployments{id status deploymentStopped} domains{serviceDomains{domain}}}}}}}",
      { id: environmentId, project: live.id },
    )
  ).environment;
  const instances = environment.serviceInstances.edges.map((x) => x.node);
  const statuses = serviceIds.map(
    (id) =>
      instances.find((x) => x.serviceId === id)?.activeDeployments.find((x) => !x.deploymentStopped)
        ?.status ?? "PENDING",
  );
  const failed = statuses.some((state) =>
    ["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(state),
  );
  const ready =
    statuses.length === serviceIds.length && statuses.every((state) => state === "SUCCESS");
  const urls = instances.flatMap((x) =>
    x.domains.serviceDomains.map((domain) => `https://${domain.domain}`),
  );
  captured.resource.serviceCount = String(serviceIds.length);
  if (urls[0]) captured.resource.url = urls[0];
  return {
    ...result(captured, failed ? "failed" : ready ? "ready" : "provisioning"),
    providerStatus: statuses.join(", "),
    ...(urls[0] ? { message: urls[0] } : {}),
  };
}

/** Deploy the complete reviewed Railway graph in an independently owned project. */
export function createRailwayTemplateAdapter(
  resolve: RailwayCredentialResolver,
): ExternalProviderAdapter {
  async function access(
    context: ExternalProviderContext,
    target: ExternalTargetInput,
  ): Promise<ProviderAccess> {
    const credential = await resolve(context, target.connectionId);
    if (!credential.secrets.apiToken)
      throw new AppError(
        "Reconnect Railway before deploying.",
        409,
        "CONNECTION_RECONNECT_REQUIRED",
      );
    return { provider: "railway", ...credential };
  }
  async function plan(
    context: ExternalProviderContext,
    target: ExternalTargetInput,
    environment?: Record<string, string>,
  ): Promise<ExternalPlan> {
    const auth = await access(context, target);
    const ws = workspace(auth, target);
    const source = recipeSource(target);
    if (target.resource.projectId || target.resource.environmentId)
      throw new AppError(
        "Catalog templates create a dedicated project. Choose a project name instead of an existing destination.",
        400,
        "EXTERNAL_TEMPLATE_DESTINATION_INVALID",
      );
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(target.resource.name ?? ""))
      throw new AppError(
        "Choose a Railway project name of 1–80 letters, numbers, spaces, dots, underscores or hyphens.",
        400,
        "EXTERNAL_TEMPLATE_NAME_INVALID",
      );
    await railwayQuery(
      auth,
      "query($workspace:String!){projects(workspaceId:$workspace,first:1){edges{node{id}}}}",
      { workspace: ws },
    );
    const details = await template(auth, source);
    railwayTemplateVariables(details.serializedConfig, environment);
    const cap = capability(target);
    return {
      planId: `railway-template:${details.id}`,
      target: snapshot(context, target),
      capability: cap,
      accepted: true,
      blockers: [],
      warnings: [
        `Creates ${Object.keys(details.serializedConfig.services).length} services in a new Railway project. Deleting this workload removes the project and its persistent data.`,
        "Provider-generated secrets and service references are preserved. Upstream template changes require a new review.",
      ],
      expiresAt: cap.expiresAt!,
    };
  }
  return {
    provider: "railway",
    workloads: ["service"],
    async capabilities(_context, target) {
      recipeSource(target);
      return capability(target);
    },
    preflight: (context, target) => plan(context, target),
    plan: (context, input) => plan(context, input.target, input.environment),
    async apply(context, input, approved) {
      const auth = await access(context, approved.target);
      const ws = workspace(auth, approved.target);
      const source = (approved as ExternalPlan & Pick<ExternalPlanInput, "source">).source;
      if (!source?.templateCode || !source.templateId || !source.templateConfigSha256) throw new AppError("The approved template source is missing.", 400, "EXTERNAL_TEMPLATE_INVALID");
      const details = await template(auth, source);
      const config = railwayTemplateVariables(
        details.serializedConfig,
        (approved as ExternalPlan & Pick<ExternalPlanInput, "environment">).environment,
      );
      const ownershipMarker = `workbox-cloud:${context.organizationId}:${createHash("sha256").update(input.idempotencyKey).digest("hex")}`;
      let captured = {
        ...approved.target,
        resource: {
          ...approved.target.resource,
          ownershipMarker,
          expectedServiceNames: JSON.stringify(Object.values(config.services).map((x) => x.name)),
        },
      };
      try {
        const created = await railwayQuery<{ projectCreate: Project }>(
          auth,
          `mutation($input:ProjectCreateInput!){projectCreate(input:$input){${PROJECT_FIELDS}}}`,
          {
            input: {
              name: approved.target.resource.name,
              description: ownershipMarker,
              workspaceId: ws,
              defaultEnvironmentName: "production",
            },
          },
        );
        captured = {
          ...captured,
          resource: {
            ...captured.resource,
            projectId: created.projectCreate.id,
            ...(created.projectCreate.environments.edges[0]?.node.id
              ? { environmentId: created.projectCreate.environments.edges[0].node.id }
              : {}),
          },
        };
        captured.resource = { ...captured.resource, managedProjectProof: ownershipProof(captured) };
        const deployed = await railwayQuery<{
          templateDeployV2: { projectId: string; workflowId?: string };
        }>(
          auth,
          "mutation($input:TemplateDeployV2Input!){templateDeployV2(input:$input){projectId workflowId}}",
          {
            input: {
              templateId: details.id,
              serializedConfig: config,
              workspaceId: ws,
              projectId: captured.resource.projectId,
              environmentId: captured.resource.environmentId,
            },
          },
        );
        if (deployed.templateDeployV2.projectId !== captured.resource.projectId)
          throw new AppError(
            "Railway returned an unexpected template project.",
            502,
            "EXTERNAL_TARGET_SCOPE_DENIED",
          );
        captured.resource = {
          ...captured.resource,
          ...(deployed.templateDeployV2.workflowId
            ? { workflowId: deployed.templateDeployV2.workflowId }
            : {}),
        };
        return await observeProject(auth, captured);
      } catch (error) {
        if (!captured.resource.projectId) throw error;
        return result(
          captured,
          "action_required",
          "The dedicated Railway project exists, but template provisioning could not be confirmed. Check status before retrying or delete this workload to remove the project.",
        );
      }
    },
    async observe(context, input) {
      return observeProject(await access(context, input.target), snapshot(context, input.target));
    },
    async reconcile(context, operation) {
      return observeProject(await access(context, operation.target), operation.target);
    },
    async *logs(context, operation) {
      const auth = await access(context, operation.target);
      const live = await project(auth, operation.target.resource.projectId!);
      owned(auth, operation.target, live);
      const environmentId = operation.target.resource.environmentId;
      if (!environmentId)
        throw new AppError(
          "The template environment is not ready for logs.",
          409,
          "EXTERNAL_LOGS_NOT_READY",
        );
      const response = await railwayQuery<{
        environmentLogs: { timestamp: string; message: string; severity?: string }[];
      }>(
        auth,
        "query($id:String!){environmentLogs(environmentId:$id,beforeLimit:100){timestamp message severity}}",
        { id: environmentId },
      );
      for (const [index, row] of response.environmentLogs.entries())
        yield {
          cursor: `${index}`,
          timestamp: new Date(row.timestamp).toISOString(),
          stream: row.severity === "error" ? ("stderr" as const) : ("stdout" as const),
          message: row.message,
        };
    },
    async destroy(context, operation) {
      const auth = await access(context, operation.target);
      const live = await project(auth, operation.target.resource.projectId!);
      owned(auth, operation.target, live);
      const expected = JSON.parse(operation.target.resource.templateServiceIds ?? "[]") as string[];
      const expectedNames = JSON.parse(
        operation.target.resource.expectedServiceNames ?? "[]",
      ) as string[];
      const services = live.services.edges.map((x) => x.node);
      if (
        live.environments.edges.length > 1 ||
        services.some((row) =>
          expected.length ? !expected.includes(row.id) : !expectedNames.includes(row.name),
        )
      )
        throw new AppError(
          "This project contains resources added outside the template. Remove those resources or manage the project in Railway before deleting it here.",
          409,
          "EXTERNAL_OWNERSHIP_CONFLICT",
        );
      await railwayQuery(auth, "mutation($id:String!){projectDelete(id:$id)}", { id: live.id });
      return {
        ...operation,
        kind: "destroy",
        status: "stopped",
        providerStatus: "DELETED",
        updatedAt: now(),
      };
    },
  };
}

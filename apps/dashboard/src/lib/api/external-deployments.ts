import type {
  ExternalTargetSnapshot,
  ExternalTargetInput,
  ExternalPlanInput,
  ExternalPlan,
  ExternalOperation,
  ExternalExecOutput,
  ExternalDiscoveryOutput,
  ExternalLogsOutput,
} from "@repo/contracts";
import { api } from "./client";
import { endpoints } from "./endpoints";

/** Explicit provider targets saved by preflight/plan or an operator. */
export const externalDeploymentsApi = {
  targets: () => api.get<{ data: ExternalTargetSnapshot[] }>(endpoints.externalDeployments.targets),
  operations: () => api.get<{ data: ExternalOperation[] }>("external-deployments/operations"),
  logs: (operationId: string, cursor?: string) =>
    api.get<{ data: ExternalLogsOutput }>(
      `external-deployments/logs?operationId=${encodeURIComponent(operationId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { timeout: 20_000 },
    ),
  discover: (connectionId: string, projectId?: string) =>
    api.get<{ data: ProviderDiscovery }>(
      `external-deployments/discover?connectionId=${encodeURIComponent(connectionId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
      { timeout: 120_000 },
    ),
  preflight: (target: ExternalTargetInput) =>
    api.post<{ data: ExternalPlan }>(endpoints.externalDeployments.preflight, target, {
      timeout: 120_000,
    }),
  plan: (input: ExternalPlanInput) =>
    api.post<{ data: ExternalPlan }>(endpoints.externalDeployments.plan, input, {
      timeout: 120_000,
    }),
  apply: (planId: string, idempotencyKey: string) =>
    api.post<{ data: ExternalOperation }>(
      endpoints.externalDeployments.apply,
      { planId, idempotencyKey, confirm: true },
      { timeout: 120_000 },
    ),
  observe: (operation: ExternalOperation) => {
    const { provider, workloadKind, connectionId, providerIdentity, resource, revision } =
      operation.target;
    return api.post<{ data: ExternalOperation }>(
      endpoints.externalDeployments.observe,
      {
        target: {
          provider,
          workloadKind,
          connectionId,
          providerIdentity,
          resource,
          ...(revision ? { revision } : {}),
        },
        operationId: operation.id,
      },
      { timeout: 120_000 },
    );
  },
  exec: (operationId: string, argv: string[]) =>
    api.post<{ data: ExternalExecOutput }>(
      "external-deployments/exec",
      { operationId, argv },
      { timeout: 120_000 },
    ),
  destroy: (operationId: string) =>
    api.post<{ data: ExternalOperation }>(
      "external-deployments/destroy",
      { operationId, confirm: true },
      { timeout: 120_000 },
    ),
};

export type ProviderDiscovery = ExternalDiscoveryOutput;

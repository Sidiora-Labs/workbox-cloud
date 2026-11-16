import type { ExternalTargetSnapshot } from "@repo/contracts";
import { api } from "./client";
import { endpoints } from "./endpoints";

/** Explicit provider targets saved by preflight/plan or an operator. */
export const externalDeploymentsApi = {
  targets: () => api.get<{ data: ExternalTargetSnapshot[] }>(endpoints.externalDeployments.targets),
};

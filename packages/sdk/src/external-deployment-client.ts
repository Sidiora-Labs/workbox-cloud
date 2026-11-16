import { type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ExternalApplyInputSchema,
  ExternalCapabilityProfileSchema,
  ExternalObserveInputSchema,
  ExternalOperationSchema,
  ExternalPlanInputSchema,
  ExternalPlanSchema,
  ExternalTargetInputSchema,
  ExternalTargetListOutputSchema,
  ExternalExecInputSchema,
  ExternalExecOutputSchema,
  ExternalDestroyInputSchema,
  type ExternalApplyInput,
  type ExternalCapabilityProfile,
  type ExternalObserveInput,
  type ExternalOperation,
  type ExternalPlan,
  type ExternalPlanInput,
  type ExternalTargetInput,
  type ExternalTargetListOutput,
  type ExternalExecInput,
  type ExternalExecOutput,
  type ExternalDestroyInput,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { ApiError } from "./errors";

/** Remote operations for provider targets, sandboxes and Workbox resources. */
export interface ExternalDeploymentOperations {
  targets(): Promise<ExternalTargetListOutput>;
  capabilities(input: ExternalTargetInput): Promise<ExternalCapabilityProfile>;
  preflight(input: ExternalTargetInput): Promise<ExternalPlan>;
  plan(input: ExternalPlanInput): Promise<ExternalPlan>;
  apply(input: ExternalApplyInput): Promise<ExternalOperation>;
  observe(input: ExternalObserveInput): Promise<ExternalOperation>;
  exec(input: ExternalExecInput): Promise<ExternalExecOutput>;
  destroy(input: ExternalDestroyInput): Promise<ExternalOperation>;
}

function checked<T>(value: unknown, schema: TSchema, label: string): T {
  if (!Value.Check(schema, value)) throw new ApiError(`Invalid ${label} response`, 502, value);
  return value as T;
}

async function post<TInput, TOutput>(http: HttpClient, operation: string, input: TInput, inputSchema: TSchema, outputSchema: TSchema, label: string): Promise<TOutput> {
  const body = input as unknown;
  if (!Value.Check(inputSchema, body)) throw new ApiError(`Invalid ${label} input`, 400, body);
  const response = await http.request<unknown>(`/external-deployments/${operation}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = response && typeof response === "object" && "data" in response
    ? (response as { data?: unknown }).data
    : response;
  return checked<TOutput>(data, outputSchema, label);
}

export function createRemoteExternalDeploymentOperations(http: HttpClient): ExternalDeploymentOperations {
  return Object.freeze({
    async targets() {
      const response = await http.request<unknown>("/external-deployments/targets", { method: "GET" });
      const data = response && typeof response === "object" && "data" in response
        ? (response as { data?: unknown }).data
        : response;
      return checked<ExternalTargetListOutput>(data, ExternalTargetListOutputSchema, "external targets");
    },
    capabilities: (input: ExternalTargetInput) => post<ExternalTargetInput, ExternalCapabilityProfile>(http, "capabilities", input, ExternalTargetInputSchema, ExternalCapabilityProfileSchema, "external capability"),
    preflight: (input: ExternalTargetInput) => post<ExternalTargetInput, ExternalPlan>(http, "preflight", input, ExternalTargetInputSchema, ExternalPlanSchema, "external preflight"),
    plan: (input: ExternalPlanInput) => post<ExternalPlanInput, ExternalPlan>(http, "plan", input, ExternalPlanInputSchema, ExternalPlanSchema, "external plan"),
    apply: (input: ExternalApplyInput) => post<ExternalApplyInput, ExternalOperation>(http, "apply", input, ExternalApplyInputSchema, ExternalOperationSchema, "external apply"),
    observe: (input: ExternalObserveInput) => post<ExternalObserveInput, ExternalOperation>(http, "observe", input, ExternalObserveInputSchema, ExternalOperationSchema, "external observation"),
    exec: (input: ExternalExecInput) => post<ExternalExecInput, ExternalExecOutput>(http, "exec", input, ExternalExecInputSchema, ExternalExecOutputSchema, "external execution"),
    destroy: (input: ExternalDestroyInput) => post<ExternalDestroyInput, ExternalOperation>(http, "destroy", input, ExternalDestroyInputSchema, ExternalOperationSchema, "external destroy"),
  });
}

export type ExternalDeploymentInput = Static<typeof ExternalPlanInputSchema>;

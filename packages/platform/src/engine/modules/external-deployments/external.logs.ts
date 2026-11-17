import { AppError, NotFoundError, type ExternalProvider, type ExternalWorkloadKind } from "@repo/core";
import { repos } from "@repo/db";
import type { ExternalLogsInput, ExternalLogsOutput, ExternalOperation } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import type { ExternalProviderRegistry } from "../../../external-deployments";
import { collectExternalLogs } from "./external-log-collector";
import { readCredentialSecrets } from "../credentials/credential.service";
import { decryptSecretField } from "../../lib/credential-encryption";

type OperationRow = NonNullable<Awaited<ReturnType<typeof repos.externalDeployment.findOperationById>>>;
type TargetRow = NonNullable<Awaited<ReturnType<typeof repos.externalDeployment.findTargetById>>>;

export function createExternalLogReader(
  registry: ExternalProviderRegistry,
  format: (row: OperationRow, target: TargetRow) => ExternalOperation,
) {
  return async (ctx: ExecutionContext, input: ExternalLogsInput): Promise<ExternalLogsOutput> => {
    const row = await repos.externalDeployment.findOperationById(ctx.organizationId, input.operationId);
    if (!row) throw new NotFoundError("External operation", input.operationId);
    const target = await repos.externalDeployment.findTargetById(ctx.organizationId, row.targetId);
    if (!target) throw new NotFoundError("External target", row.targetId);
    const credential = await repos.credential.findById(ctx.organizationId, target.credentialId);
    if (!credential || credential.provider !== target.provider || credential.status !== "active")
      throw new AppError("Reconnect the selected provider connection before reading logs.", 409, "CONNECTION_INVALID");
    const operation = format(row, target);
    const adapter = registry.get(target.provider as ExternalProvider, target.workloadKind as ExternalWorkloadKind);
    if (!adapter.logs || !operation.target.capability?.supported.includes("logs"))
      throw new AppError("Logs are not available for this workload.", 422, "EXTERNAL_CAPABILITY_UNSUPPORTED");
    if (!row.providerResourceId)
      throw new AppError("Wait for the provider resource to be confirmed before reading logs.", 409, "EXTERNAL_RESOURCE_PENDING");
    const secrets = Object.values(readCredentialSecrets(credential));
    const encrypted = row.request.environmentEnc;
    if (typeof encrypted === "string") {
      const environment = JSON.parse(decryptSecretField(encrypted) ?? "{}") as Record<string, unknown>;
      for (const value of Object.values(environment)) if (typeof value === "string") secrets.push(value);
    }
    const controller = new AbortController();
    try {
      return await collectExternalLogs(adapter.logs(
        { organizationId: ctx.organizationId, actorId: ctx.userId, requestId: ctx.traceId, executionContext: ctx, signal: controller.signal },
        operation,
        { cursor: input.cursor, signal: controller.signal },
      ), secrets);
    } catch {
      throw new AppError("The provider could not return workload logs. Refresh its status and try again.", 502, "EXTERNAL_LOGS_UNAVAILABLE");
    } finally { controller.abort(); }
  };
}

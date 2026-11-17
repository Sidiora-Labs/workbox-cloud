import { AppError } from "@repo/core";
import { createHash } from "node:crypto";
import type {
  ExternalCapabilityName,
  ExternalCapabilityProfile,
  ExternalOperation,
  ExternalOperationStatus,
  ExternalPlan,
  ExternalPlanInput,
  ExternalTargetInput,
  ExternalTargetSnapshot,
} from "@repo/contracts";
import type {
  ExternalProviderAdapter,
  ExternalProviderContext,
} from "../../../../external-deployments";
import { safeFetch } from "../../../lib/safe-fetch";

/** REST avoids the Blaxel SDK's process-wide environment credentials: every
 * request stays bound to the selected organization connection. */
export const BLAXEL_API_VERSION = "2026-04-28";
export const BLAXEL_CAPABILITIES: readonly ExternalCapabilityName[] = [
  "discover",
  "preflight",
  "apply",
  "observe",
  "destroy",
];
export type BlaxelCredentialResolver = (
  context: ExternalProviderContext,
  connectionId: string,
) => Promise<{
  readonly publicFields: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}>;
interface Access {
  apiKey: string;
  workspaceId: string;
}
interface Resource {
  metadata?: { name?: string; url?: string; labels?: Record<string, string> };
  status?: string;
}
const now = () => new Date().toISOString();
const sandbox = (target: ExternalTargetInput | ExternalTargetSnapshot) =>
  target.workloadKind === "blaxel-sandbox";
const collection = (target: ExternalTargetInput | ExternalTargetSnapshot) =>
  sandbox(target) ? "sandboxes" : "applications";
const nameFor = (target: ExternalTargetInput | ExternalTargetSnapshot) =>
  target.resource.name || target.resource.id || "";
const previewWarning =
  "Blaxel Applications are in private preview. The selected workspace must have access; Blaxel does not recommend production use yet.";
const imageWarning =
  "Images must be available in the Blaxel registry. Sandbox standby preserves memory and files; deleting a sandbox permanently removes its local data.";

export async function blaxelRequest<T>(
  access: Access,
  path: string,
  options: { method?: string; body?: unknown; allowMissing?: boolean; endpoint?: string } = {},
): Promise<T | null> {
  let url = new URL(`https://api.blaxel.ai/v0/${path}`);
  if (options.endpoint) {
    const endpoint = new URL(options.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      !endpoint.hostname.endsWith(".bl.run") ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.port && endpoint.port !== "443")
    ) {
      throw new AppError(
        "Blaxel returned an invalid sandbox endpoint.",
        502,
        "CONNECTION_ENDPOINT_INVALID",
      );
    }
    url = new URL(path, `${endpoint.origin}/`);
  }
  let response;
  try {
    response = await safeFetch(url.href, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${access.apiKey}`,
        "X-Blaxel-Workspace": access.workspaceId,
        "Blaxel-Version": BLAXEL_API_VERSION,
        Accept: "application/json",
        "Content-Type": "application/json",
        // Blaxel's edge rejects requests without an identifiable user agent.
        "User-Agent": "workbox-cloud/1.0",
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      timeoutMs: 30_000,
      maxBodyBytes: 2 * 1024 * 1024,
      maxRedirects: 0,
    });
  } catch {
    const mutation = options.method && options.method !== "GET";
    throw new AppError(
      "Blaxel could not be reached. Check resource status before retrying a deployment.",
      502,
      mutation ? "EXTERNAL_UNKNOWN_OUTCOME" : "CONNECTION_UNAVAILABLE",
    );
  }
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) {
    const auth = response.status === 401 || response.status === 403;
    throw new AppError(
      auth
        ? "Blaxel refused access to the selected workspace or resource."
        : response.status === 409
          ? "A Blaxel resource with this name already exists."
          : "Blaxel could not complete the request. Refresh resource status before retrying.",
      auth ? 403 : 502,
      auth ? "CONNECTION_ACCESS_DENIED" : "CONNECTION_REQUEST_FAILED",
    );
  }
  if (response.status === 204) return null;
  try {
    return (await response.json()) as T;
  } catch {
    throw new AppError("Blaxel returned an invalid response.", 502, "CONNECTION_RESPONSE_INVALID");
  }
}

export async function verifyBlaxelAccess(access: Access): Promise<void> {
  await blaxelRequest(access, "sandboxes?limit=1");
}

function capability(target: ExternalTargetInput): ExternalCapabilityProfile {
  return {
    provider: "blaxel",
    workloadKind: target.workloadKind,
    checkedAt: now(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    apiVersion: BLAXEL_API_VERSION,
    supported: [
      ...BLAXEL_CAPABILITIES,
      ...(sandbox(target)
        ? (["exec", "persistent-storage", "idle-policy"] as const)
        : (["public-ingress"] as const)),
    ],
    unsupported: [],
    limits: {
      imageRegistry: "Blaxel",
      lifecycle: sandbox(target) ? "automatic-standby" : "private-preview",
    },
    observedIdentity: target.providerIdentity,
  };
}
function snapshot(
  context: ExternalProviderContext,
  target: ExternalTargetInput,
): ExternalTargetSnapshot {
  return {
    ...target,
    targetId: nameFor(target),
    organizationId: context.organizationId,
    capturedAt: now(),
  };
}
function status(value?: string): ExternalOperationStatus {
  switch (value?.toUpperCase()) {
    case "DEPLOYED":
      return "ready";
    case "FAILED":
      return "failed";
    case "ARCHIVED":
    case "DEACTIVATED":
    case "TERMINATED":
      return "stopped";
    case "DELETING":
    case "DEACTIVATING":
    case "ARCHIVING":
      return "stopping";
    case "UPLOADING":
    case "BUILDING":
    case "DEPLOYING":
    case "UNARCHIVING":
      return "provisioning";
    default:
      return "unknown";
  }
}
function operation(
  target: ExternalTargetSnapshot,
  resource: Resource,
  kind: ExternalOperation["kind"],
): ExternalOperation {
  return {
    id: `blaxel:${nameFor(target)}`,
    organizationId: target.organizationId,
    targetId: target.targetId,
    kind,
    workloadKind: target.workloadKind,
    status: status(resource.status),
    idempotencyKey: `blaxel:${target.targetId}`,
    target,
    providerResourceId: resource.metadata?.name || nameFor(target),
    providerStatus: resource.status ?? "unknown",
    createdAt: now(),
    updatedAt: now(),
  };
}
function validate(target: ExternalTargetInput | ExternalTargetSnapshot, image?: string): string[] {
  const blockers: string[] = [];
  if (!/^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?$/.test(nameFor(target)))
    blockers.push("Use a Blaxel name of up to 49 lowercase letters, digits and hyphens.");
  if (!target.resource.region) blockers.push("Choose a Blaxel deployment region.");
  const memory = target.resource.memoryMb ?? target.resource.memory;
  if (memory && (!/^\d+$/.test(memory) || Number(memory) <= 0))
    blockers.push("Blaxel memory must be a positive number of MB.");
  if (!sandbox(target) && image === "")
    blockers.push("Choose a Blaxel registry image for this application.");
  if (image && (image.includes("://") || image.split("/")[0]?.includes(".")))
    blockers.push("Push this image to the Blaxel registry before deploying it.");
  const ports = sandbox(target)
    ? (target.resource.ports?.split(",").filter(Boolean) ?? [])
    : [target.resource.port ?? "8080"];
  if (
    ports.some(
      (port) =>
        !/^\d+$/.test(port.trim()) ||
        Number(port) < 1 ||
        Number(port) > 65535 ||
        (sandbox(target) && [80, 443, 8080].includes(Number(port))),
    )
  )
    blockers.push("Choose valid workload ports; Blaxel reserves sandbox ports 80, 443 and 8080.");
  if (
    target.resource.ttl &&
    (!/^\d+[smhdw]$/.test(target.resource.ttl) ||
      (() => {
        const m = /^(\d+)([smhdw])$/.exec(target.resource.ttl)!;
        return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2]!] ?? 0) < 300;
      })())
  )
    blockers.push(
      "Sandbox TTL must be at least 5 minutes (for example 1h or 7d). TTL deletes the sandbox; it is not an idle timeout.",
    );
  return blockers;
}

export function createBlaxelExternalAdapter(
  resolve: BlaxelCredentialResolver,
): ExternalProviderAdapter {
  const access = async (
    context: ExternalProviderContext,
    target: ExternalTargetInput | ExternalTargetSnapshot,
  ): Promise<Access> => {
    const credential = await resolve(context, target.connectionId);
    const apiKey = credential.secrets.apiKey;
    const workspaceId = credential.publicFields.workspaceId;
    if (!apiKey || !workspaceId)
      throw new AppError(
        "Reconnect Blaxel with an API key and workspace.",
        409,
        "CONNECTION_RECONNECT_REQUIRED",
      );
    if (target.providerIdentity.workspaceId && target.providerIdentity.workspaceId !== workspaceId)
      throw new AppError(
        "The target workspace differs from the selected Blaxel connection.",
        409,
        "CONNECTION_IDENTITY_MISMATCH",
      );
    return { apiKey, workspaceId };
  };
  const planFor = (
    context: ExternalProviderContext,
    target: ExternalTargetInput,
    blockers: string[],
  ): ExternalPlan => {
    const caps = capability(target);
    return {
      planId: `blaxel:${nameFor(target)}`,
      target: snapshot(context, target),
      capability: caps,
      accepted: blockers.length === 0,
      blockers,
      warnings: [sandbox(target) ? imageWarning : previewWarning],
      expiresAt: caps.expiresAt!,
    };
  };
  return {
    provider: "blaxel",
    workloads: ["service", "blaxel-sandbox"],
    async capabilities(_context, target) {
      return capability(target);
    },
    async preflight(context, target) {
      await blaxelRequest(await access(context, target), `${collection(target)}?limit=1`);
      return planFor(context, target, validate(target));
    },
    async plan(context, input) {
      await access(context, input.target);
      return planFor(
        context,
        input.target,
        validate(
          input.target,
          input.image ??
            input.source?.image ??
            input.target.resource.image ??
            (sandbox(input.target) ? "blaxel/base-image:latest" : ""),
        ),
      );
    },
    async apply(context, input, plan) {
      const auth = await access(context, plan.target);
      const request = plan as ExternalPlan &
        Pick<ExternalPlanInput, "image" | "environment" | "source">;
      const image =
        request.image ??
        request.source?.image ??
        plan.target.resource.image ??
        (sandbox(plan.target) ? "blaxel/base-image:latest" : "");
      const blockers = validate(plan.target, image);
      if (blockers.length) throw new AppError(blockers.join(" "), 400, "EXTERNAL_TARGET_INVALID");
      const name = nameFor(plan.target);
      const operationKey = createHash("sha256").update(input.idempotencyKey).digest("hex");
      const existing = await blaxelRequest<Resource>(
        auth,
        `${collection(plan.target)}/${encodeURIComponent(name)}`,
        { allowMissing: true },
      );
      if (existing) {
        if (existing.metadata?.labels?.workboxTargetId !== plan.target.targetId)
          throw new AppError(
            "This Blaxel name belongs to an existing resource. Choose a different name.",
            409,
            "EXTERNAL_TARGET_CONFLICT",
          );
        if (existing.metadata.labels.workboxOperationKey === operationKey)
          return operation(plan.target, existing, "apply");
        if (sandbox(plan.target))
          throw new AppError(
            "This sandbox already exists. Manage it from Workloads or choose a new name; replacing it can reset its state.",
            409,
            "EXTERNAL_TARGET_CONFLICT",
          );
      }
      const runtime = {
        image,
        memory: Number(
          plan.target.resource.memoryMb ??
            plan.target.resource.memory ??
            (sandbox(plan.target) ? 4096 : 2048),
        ),
        envs: Object.entries(request.environment ?? {}).map(([name, value]) => ({ name, value })),
        ...(sandbox(plan.target)
          ? {
              ports: plan.target.resource.ports
                ?.split(",")
                .filter(Boolean)
                .map((port) => ({ target: Number(port.trim()), protocol: "HTTP" })),
              ...(plan.target.resource.ttl ? { ttl: plan.target.resource.ttl } : {}),
            }
          : { port: Number(plan.target.resource.port ?? "8080") }),
      };
      const resource = await blaxelRequest<Resource>(
        auth,
        existing
          ? `${collection(plan.target)}/${encodeURIComponent(name)}`
          : collection(plan.target),
        {
          method: existing ? "PUT" : "POST",
          body: {
            metadata: {
              name,
              labels: {
                workboxTargetId: plan.target.targetId,
                workboxOrganizationId: context.organizationId,
                workboxOperationKey: operationKey,
              },
            },
            spec: {
              enabled: true,
              region: plan.target.resource.region,
              ...(sandbox(plan.target) ? { runtime } : runtime),
            },
          },
        },
      );
      return operation(plan.target, resource!, "apply");
    },
    async observe(context, input) {
      const result = await blaxelRequest<Resource>(
        await access(context, input.target),
        `${collection(input.target)}/${encodeURIComponent(nameFor(input.target))}`,
        { allowMissing: true },
      );
      if (!result)
        return {
          ...operation(snapshot(context, input.target), { status: "TERMINATED" }, "observe"),
          status: "stopped",
        };
      return operation(snapshot(context, input.target), result!, "observe");
    },
    async exec(context, op, input) {
      if (!sandbox(op.target))
        throw new AppError(
          "Blaxel command execution is available for sandboxes.",
          422,
          "EXTERNAL_CAPABILITY_UNSUPPORTED",
        );
      const auth = await access(context, op.target);
      const resource = await blaxelRequest<Resource>(
        auth,
        `sandboxes/${encodeURIComponent(nameFor(op.target))}`,
      );
      if (!resource?.metadata?.url)
        throw new AppError(
          "The Blaxel sandbox endpoint is not ready.",
          409,
          "EXTERNAL_TARGET_NOT_READY",
        );
      const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
      const result = await blaxelRequest<{
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        status?: string;
      }>(auth, "process", {
        endpoint: resource.metadata.url,
        method: "POST",
        body: {
          command: input.argv.map(quote).join(" "),
          workingDir: input.cwd,
          env: input.env,
          waitForCompletion: true,
          timeout: 20,
        },
      });
      return {
        operation: op,
        stdout: String(result?.stdout ?? "").slice(0, 20_000),
        stderr: String(result?.stderr ?? "").slice(0, 20_000),
        exitCode:
          result && ["completed", "failed", "stopped", "killed"].includes(result.status ?? "")
            ? (result.exitCode ?? null)
            : null,
      };
    },
    async destroy(context, op) {
      const result = await blaxelRequest<Resource>(
        await access(context, op.target),
        `${collection(op.target)}/${encodeURIComponent(nameFor(op.target))}`,
        { method: "DELETE", allowMissing: true },
      );
      const complete = !result || ["TERMINATED", "DEACTIVATED"].includes(result.status ?? "");
      return {
        ...op,
        kind: "destroy",
        status: complete ? "stopped" : "stopping",
        providerStatus: result?.status ?? "TERMINATED",
        updatedAt: now(),
      };
    },
  };
}

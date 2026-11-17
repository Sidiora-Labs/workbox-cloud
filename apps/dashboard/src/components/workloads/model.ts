import type {
  ExternalOperation,
  ExternalPlanInput,
  ExternalTargetInput,
  ExternalWorkloadKind,
} from "@repo/contracts";
import type { Credential } from "@/lib/api/credentials";

export type WorkloadProvider = "native" | "railway" | "vercel" | "fly" | "blaxel" | "workbox";
export const providers: Array<{ id: WorkloadProvider; name: string; description: string }> = [
  {
    id: "native",
    name: "Workbox Cloud & your servers",
    description: "Applications on managed Cloud, a VPS, or bare metal.",
  },
  {
    id: "railway",
    name: "Railway",
    description: "Container services and isolated Railway sandboxes.",
  },
  { id: "vercel", name: "Vercel", description: "Project deployments and Vercel sandboxes." },
  { id: "fly", name: "Fly.io", description: "Application Machines and persistent Sprites." },
  { id: "blaxel", name: "Blaxel", description: "Sandboxes and container applications." },
  {
    id: "workbox",
    name: "Workbox environments",
    description: "Child sandboxes on a connected Workbox host.",
  },
];
export const kinds: Record<
  Exclude<WorkloadProvider, "native">,
  Array<{ id: ExternalWorkloadKind; name: string; description: string }>
> = {
  railway: [
    {
      id: "service",
      name: "Application / service",
      description: "A container service with deployment history and a service lifecycle.",
    },
    {
      id: "railway-sandbox",
      name: "Railway Sandbox",
      description:
        "An isolated environment for development and agent tasks, with its own lifetime.",
    },
  ],
  vercel: [
    {
      id: "service",
      name: "Vercel project",
      description: "Deploy a linked Git project using Vercel's build and hosting platform.",
    },
    {
      id: "vercel-sandbox",
      name: "Vercel Sandbox",
      description: "A sandbox with separate sessions, persistence and timeout controls.",
    },
  ],
  fly: [
    {
      id: "fly-machine",
      name: "Fly Machine",
      description: "Run an application image in a Fly Machine.",
    },
    {
      id: "fly-sprite",
      name: "Fly Sprite",
      description: "A persistent development machine. Requires a separate Sprites token.",
    },
  ],
  blaxel: [
    {
      id: "blaxel-sandbox",
      name: "Blaxel Sandbox",
      description: "An isolated sandbox with command execution and an explicit lifetime.",
    },
    {
      id: "service",
      name: "Blaxel application",
      description: "A container application. Private preview; requires access enabled by Blaxel.",
    },
  ],
  workbox: [
    {
      id: "workbox-sandbox",
      name: "Workbox Sandbox",
      description: "Create a child sandbox through the connected Workbox host and environment.",
    },
  ],
};
export const kindLabel = (provider: string, kind: string) =>
  kinds[provider as keyof typeof kinds]?.find((item) => item.id === kind)?.name ?? kind;
export interface LaunchDraft {
  name: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  appName: string;
  region: string;
  image: string;
  repo: string;
  branch: string;
  variables: string;
  ports: string;
  memoryMb: string;
  vcpus: string;
  timeoutMinutes: string;
  persistent: boolean;
  createApp: boolean;
  rootfs: string;
  runtime: string;
  ttl: string;
  networkIsolation: string;
  cpu: string;
  memoryGB: string;
}
export const initialDraft: LaunchDraft = {
  name: "",
  projectId: "",
  environmentId: "",
  serviceId: "",
  appName: "",
  region: "",
  image: "",
  repo: "",
  branch: "main",
  variables: "",
  ports: "",
  memoryMb: "",
  vcpus: "",
  timeoutMinutes: "30",
  persistent: true,
  createApp: false,
  rootfs: "",
  runtime: "",
  ttl: "1h",
  networkIsolation: "PRIVATE",
  cpu: "",
  memoryGB: "",
};
export function parseVariables(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const split = line.indexOf("=");
    if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, split).trim()))
      throw new Error("Enter environment variables as NAME=value, one per line.");
    result[line.slice(0, split).trim()] = line.slice(split + 1);
  }
  return result;
}
export function launchInput(
  provider: Exclude<WorkloadProvider, "native">,
  kind: ExternalWorkloadKind,
  credential: Credential,
  draft: LaunchDraft,
  key: string,
): ExternalPlanInput {
  if (!draft.name.trim()) throw new Error("Enter a workload name.");
  if (credential.provider !== provider)
    throw new Error("Choose a connection for the selected provider.");
  for (const field of ["memoryMb", "vcpus", "timeoutMinutes", "cpu", "memoryGB"] as const) {
    if (draft[field] && (!Number.isFinite(Number(draft[field])) || Number(draft[field]) <= 0))
      throw new Error("Resource sizes and timeouts must be positive numbers.");
  }
  if (
    draft.ports &&
    draft.ports
      .split(",")
      .some((port) => !/^\d+$/.test(port.trim()) || Number(port) < 1 || Number(port) > 65535)
  )
    throw new Error("Ports must be numbers between 1 and 65535, separated by commas.");
  const resource: Record<string, string> = { name: draft.name.trim() };
  const put = (key: string, value: string) => {
    if (value.trim()) resource[key] = value.trim();
  };
  for (const field of [
    "projectId",
    "environmentId",
    "serviceId",
    "appName",
    "region",
    "ports",
    "memoryMb",
    "vcpus",
  ] as const)
    put(field, draft[field]);
  if ((provider === "railway" || provider === "vercel") && !draft.projectId)
    throw new Error("Select a provider project.");
  if (provider === "railway" && !draft.environmentId)
    throw new Error("Select a Railway environment.");
  if (kind === "fly-machine") {
    if (!draft.appName)
      throw new Error("Select a Fly application or enter a new application name.");
    if (!draft.image) throw new Error("Enter the container image to run.");
    resource.createApp = String(draft.createApp);
  }
  if (provider === "blaxel" && !draft.region) throw new Error("Enter a Blaxel region.");
  if (provider === "blaxel" && kind === "blaxel-sandbox") put("ttl", draft.ttl);
  if (draft.ports) put("port", draft.ports.split(",")[0]!);
  if (kind === "vercel-sandbox") {
    resource.persistent = String(draft.persistent);
    if (draft.timeoutMinutes) resource.timeoutMs = String(Number(draft.timeoutMinutes) * 60_000);
    put("runtime", draft.runtime);
  }
  if (kind === "railway-sandbox") {
    if (draft.timeoutMinutes) resource.idleTimeoutMinutes = draft.timeoutMinutes;
    put("networkIsolation", draft.networkIsolation);
    put("cpu", draft.cpu);
    put("memoryGB", draft.memoryGB);
  }
  if (kind === "workbox-sandbox") {
    put("rootfs", draft.rootfs);
    put("runtime", draft.runtime);
  }
  const environment = parseVariables(draft.variables);
  return {
    target: {
      provider,
      workloadKind: kind,
      connectionId: credential.id,
      providerIdentity: { ...credential.publicFields },
      resource,
    },
    ...(draft.image.trim() ? { image: draft.image.trim() } : {}),
    ...(draft.repo.trim()
      ? {
          source: {
            repo: draft.repo.trim(),
            ref: draft.branch.trim() || "main",
            branch: draft.branch.trim() || "main",
          },
        }
      : provider === "vercel" && kind === "service" && draft.branch.trim()
        ? { source: { ref: draft.branch.trim() } }
        : {}),
    ...(Object.keys(environment).length ? { environment } : {}),
    ...(kind === "workbox-sandbox" && (draft.memoryMb || draft.vcpus)
      ? {
          workload: {
            ...(draft.memoryMb ? { memoryMb: draft.memoryMb } : {}),
            ...(draft.vcpus ? { cpuMillis: String(Number(draft.vcpus) * 1000) } : {}),
          },
        }
      : {}),
    idempotencyKey: key,
  };
}
export function operationTarget(operation: ExternalOperation): ExternalTargetInput {
  const { provider, workloadKind, connectionId, providerIdentity, resource, revision } =
    operation.target;
  return {
    provider,
    workloadKind,
    connectionId,
    providerIdentity,
    resource,
    ...(revision ? { revision } : {}),
  };
}
/** One current entry per resource. Planning alone is not a deployed workload. */
export function currentWorkloads(operations: ExternalOperation[]): ExternalOperation[] {
  const byTarget = new Map<string, ExternalOperation>();
  for (const operation of [...operations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (
      operation.kind === "plan" ||
      operation.kind === "preflight" ||
      (!operation.providerResourceId && operation.kind !== "apply")
    )
      continue;
    if (!byTarget.has(operation.targetId)) byTarget.set(operation.targetId, operation);
  }
  return [...byTarget.values()];
}

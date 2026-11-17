import { api } from "./client";
import type { WorkboxHost, WorkboxHostPreflight } from "@repo/contracts";
export type { WorkboxHost, WorkboxHostPreflight } from "@repo/contracts";

export const workboxHostsApi = {
  list: () => api.get<{ data: WorkboxHost[] }>("workbox-hosts"),
  get: (id: string) => api.get<{ data: WorkboxHost }>(`workbox-hosts/${encodeURIComponent(id)}`),
  preflight: (serverId: string) =>
    api.post<{ data: WorkboxHostPreflight }>(
      "workbox-hosts/preflight",
      { serverId },
      { timeout: 120_000 },
    ),
  install: (input: { serverId: string; name: string; rootfs: "minimal" | "agents" }) =>
    api.post<{ data: WorkboxHost }>(
      "workbox-hosts",
      { ...input, confirm: true },
      { timeout: 120_000 },
    ),
  action: (id: string, action: "start" | "stop" | "retry" | "remove") =>
    api.post<{ data: WorkboxHost }>(
      `workbox-hosts/${encodeURIComponent(id)}/action`,
      { action, ...(action === "remove" ? { confirm: true } : {}) },
      { timeout: 120_000 },
    ),
};

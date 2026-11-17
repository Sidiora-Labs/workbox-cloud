import { randomBytes } from "node:crypto";
import { AppError, generateId, NotFoundError } from "@repo/core";
import type { WorkboxHost, WorkboxHostPreflight } from "@repo/contracts";
import { repos, type WorkboxHostRecord } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { withServerProvisioning } from "../system/server-provisioning";
import { withServerExecution } from "../../lib/server-execution";
import { deferBackgroundWork } from "../../lib/background-work";
import { encryptSecretField, decryptSecretField } from "../../lib/credential-encryption";
import { writeCredentialSecrets } from "../credentials/credential.service";
import {
  createWorkboxProvider,
  type WorkboxRequest,
} from "../external-deployments/providers/workbox";
import {
  hostSteps,
  assertWorkboxHostIdle,
  runManagedWorkboxCommand,
  installWorkboxHost,
  probeWorkboxHost,
  rootExecutor,
  privateRequest,
  WORKBOX_REVISION,
  WORKBOX_PORT,
  WORKBOX_CONFIG,
  WORKBOX_UNIT,
} from "./installer";

const active = new Set<string>();
const leaseMs = 45 * 60_000;
const currentGeneration = new Map<string, number>();
const publicHost = (row: WorkboxHostRecord): WorkboxHost => ({
  id: row.id,
  serverId: row.serverId,
  name: row.name,
  rootfs: row.rootfs as WorkboxHost["rootfs"],
  version: row.version,
  status: row.status as WorkboxHost["status"],
  connectionId: row.connectionId,
  progress: row.progress,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
async function authorized(ctx: ExecutionContext, row: WorkboxHostRecord, action: "read" | "admin") {
  await authorization.authorize(ctx, { resourceType: "server", resourceId: row.serverId, action });
  if (action === "admin")
    await authorization.authorize(ctx, {
      resourceType: "settings",
      resourceId: "*",
      action: "admin",
    });
}
async function find(ctx: ExecutionContext, id: string, action: "read" | "admin" = "read") {
  const row = await repos.workboxHost.find(ctx.organizationId, id);
  if (!row) throw new NotFoundError("Workbox host", id);
  await authorized(ctx, row, action);
  return row;
}
async function settleInterrupted(row: WorkboxHostRecord) {
  if (
    ["queued", "installing", "removing"].includes(row.status) &&
    row.leaseUntil &&
    row.leaseUntil.getTime() < Date.now() &&
    !active.has(row.id)
  )
    return (
      (await repos.workboxHost.update(
        row.organizationId,
        row.id,
        {
          status: "failed",
          error:
            "Preparation was interrupted. Retry to verify the same host and resume its owned installation.",
          leaseUntil: null,
        },
        row.generation,
      )) ?? row
    );
  return row;
}
export async function listWorkboxHosts(ctx: ExecutionContext) {
  const result: WorkboxHost[] = [];
  for (const row of await repos.workboxHost.list(ctx.organizationId))
    if (
      await authorization.checkPermissionOnResource(ctx, {
        resourceType: "server",
        resourceId: row.serverId,
        action: "read",
      })
    )
      result.push(publicHost(await settleInterrupted(row)));
  return result;
}
export async function getWorkboxHost(ctx: ExecutionContext, id: string) {
  return publicHost(await settleInterrupted(await find(ctx, id)));
}
export async function preflightWorkboxHost(
  ctx: ExecutionContext,
  serverId: string,
): Promise<WorkboxHostPreflight> {
  await authorization.authorize(ctx, {
    resourceType: "server",
    resourceId: serverId,
    action: "admin",
  });
  return withServerProvisioning(ctx, serverId, async () =>
    withServerExecution(ctx.organizationId, serverId, async (executor) => {
      const existing = await repos.workboxHost.byServer(ctx.organizationId, serverId);
      const { identity, ...result } = await probeWorkboxHost(executor, existing?.id);
      return result;
    }),
  );
}
function launch(ctx: ExecutionContext, row: WorkboxHostRecord) {
  active.add(row.id);
  currentGeneration.set(row.id, row.generation);
  void deferBackgroundWork(async () => {
    try {
      await withServerProvisioning(ctx, row.serverId, async () =>
        withServerExecution(ctx.organizationId, row.serverId, async (executor) => {
          const probe = await probeWorkboxHost(executor, row.id);
          if (!probe.accepted)
            throw new AppError(probe.blockers.join(" "), 409, "WORKBOX_HOST_UNSUPPORTED");
          if (probe.identity !== row.hostIdentity)
            throw new AppError(
              "The connected machine identity changed. Reconnect the original server before retrying.",
              409,
              "WORKBOX_HOST_CHANGED",
            );
          const progress = hostSteps();
          const step = async (id: string, message: string) => {
            await authorized(ctx, row, "admin");
            const current = await repos.workboxHost.find(ctx.organizationId, row.id);
            if (!current || current.generation !== row.generation)
              throw new AppError(
                "Preparation no longer owns this installation.",
                409,
                "WORKBOX_HOST_SUPERSEDED",
              );
            for (const entry of progress) {
              if (entry.status === "running") entry.status = "completed";
              if (entry.id === id) {
                entry.status = "running";
                entry.message = message;
              }
            }
            await repos.workboxHost.update(
              ctx.organizationId,
              row.id,
              {
                status: "installing",
                progress: structuredClone(progress),
                leaseUntil: new Date(Date.now() + leaseMs),
              },
              row.generation,
            );
          };
          const token = decryptSecretField(row.tokenEnc)!;
          await installWorkboxHost(
            executor,
            {
              id: row.id,
              organizationId: ctx.organizationId,
              identity: row.hostIdentity,
              rootfs: row.rootfs as "minimal" | "agents",
              token,
            },
            step,
          );
          await step("connection", "Registering the verified private Workbox connection.");
          const transport: WorkboxRequest = (url, options) =>
            privateRequest(executor, new URL(url).pathname + new URL(url).search, options);
          const client = createWorkboxProvider({
            baseUrl: `http://127.0.0.1:${WORKBOX_PORT}`,
            apiKey: token,
            request: transport,
          });
          const checked = await client.preflight();
          if (!checked.ready || !checked.reachable)
            throw new AppError(
              "Workbox did not verify its private endpoint.",
              502,
              "WORKBOX_HOST_NOT_READY",
            );
          const publicFields = {
            baseUrl: `http://127.0.0.1:${WORKBOX_PORT}`,
            serverId: row.serverId,
            managedHostId: row.id,
            scope: "admin",
          };
          let connectionId = row.connectionId;
          if (!connectionId) {
            const saved = (await repos.credential.listByOrg(ctx.organizationId)).find(
              (item) => item.provider === "workbox" && item.selector === `managed:${row.id}`,
            );
            if (saved) {
              if (
                saved.publicFields.managedHostId !== row.id ||
                saved.publicFields.serverId !== row.serverId
              )
                throw new AppError(
                  "An existing Workbox connection has a different host binding.",
                  409,
                  "WORKBOX_CONNECTION_CONFLICT",
                );
              connectionId = saved.id;
            }
          }
          if (connectionId) {
            await repos.credential.update(ctx.organizationId, connectionId, {
              publicFields,
              status: "active",
              lastVerifiedAt: new Date(),
              lastError: null,
              secretsEnc: writeCredentialSecrets({ apiKey: token }),
            });
          } else {
            connectionId = (
              await repos.credential.create({
                organizationId: ctx.organizationId,
                provider: "workbox",
                name: row.name,
                selector: `managed:${row.id}`,
                publicFields,
                status: "active",
                lastVerifiedAt: new Date(),
                lastError: null,
                secretsEnc: writeCredentialSecrets({ apiKey: token }),
              })
            ).id;
          }
          for (const entry of progress) entry.status = "completed";
          await repos.workboxHost.update(
            ctx.organizationId,
            row.id,
            { status: "ready", connectionId, progress, error: null, leaseUntil: null },
            row.generation,
          );
        }),
      );
    } catch (error) {
      const current = await repos.workboxHost.find(ctx.organizationId, row.id);
      if (current?.generation !== row.generation) return;
      const progress = current?.progress ?? hostSteps();
      for (const entry of progress) if (entry.status === "running") entry.status = "failed";
      const message =
        error instanceof AppError
          ? error.message
          : "Workbox preparation failed. Check SSH access, host capabilities and package repository access, then retry.";
      await repos.workboxHost.update(
        ctx.organizationId,
        row.id,
        { status: "failed", progress, error: message, leaseUntil: null },
        row.generation,
      );
    } finally {
      if (currentGeneration.get(row.id) === row.generation) {
        active.delete(row.id);
        currentGeneration.delete(row.id);
      }
    }
  });
}
export async function createWorkboxHost(
  ctx: ExecutionContext,
  input: { serverId: string; name: string; rootfs: "minimal" | "agents"; confirm: true },
) {
  await authorization.authorize(ctx, {
    resourceType: "settings",
    resourceId: "*",
    action: "admin",
  });
  return withServerProvisioning(ctx, input.serverId, async () =>
    withServerExecution(ctx.organizationId, input.serverId, async (executor) => {
      let row = await repos.workboxHost.byServer(ctx.organizationId, input.serverId);
      if (row && row.status !== "removed") {
        await authorized(ctx, row, "admin");
        return publicHost(await settleInterrupted(row));
      }
      const probe = await probeWorkboxHost(executor, row?.id);
      if (!probe.accepted)
        throw new AppError(probe.blockers.join(" "), 409, "WORKBOX_HOST_UNSUPPORTED");
      if (row && probe.identity !== row.hostIdentity)
        throw new AppError(
          "The connected machine identity changed. Remove this saved installation before preparing another host.",
          409,
          "WORKBOX_HOST_CHANGED",
        );
      const data = {
        name: input.name.trim(),
        rootfs: input.rootfs,
        version: WORKBOX_REVISION,
        status: "queued",
        hostIdentity: probe.identity,
        port: WORKBOX_PORT,
        progress: hostSteps(),
        error: null,
        leaseUntil: new Date(Date.now() + leaseMs),
        tokenEnc: row?.tokenEnc || encryptSecretField(randomBytes(32).toString("hex"))!,
      };
      row = row
        ? (await repos.workboxHost.update(ctx.organizationId, row.id, {
            ...data,
            generation: row.generation + 1,
          }))!
        : await repos.workboxHost.create({
            ...data,
            id: generateId("wbhost"),
            organizationId: ctx.organizationId,
            serverId: input.serverId,
          });
      // Let the admission lock release before the long-running worker acquires it.
      const snapshot = row;
      setImmediate(() => launch(ctx, snapshot));
      return publicHost(row);
    }),
  );
}
export async function actOnWorkboxHost(
  ctx: ExecutionContext,
  id: string,
  input: { action: "start" | "stop" | "retry" | "remove"; confirm?: true },
) {
  let row = await settleInterrupted(await find(ctx, id, "admin"));
  if (["queued", "installing", "removing"].includes(row.status))
    throw new AppError("Workbox host preparation is already running.", 409, "WORKBOX_HOST_BUSY");
  if (input.action === "retry") {
    return withServerProvisioning(ctx, row.serverId, async () => {
      row = await settleInterrupted(await find(ctx, id, "admin"));
      if (row.status !== "failed")
        throw new AppError("Only a failed preparation can be retried.", 409, "WORKBOX_HOST_BUSY");
      await withServerExecution(ctx.organizationId, row.serverId, async (executor) => {
        await assertWorkboxHostIdle(await rootExecutor(executor));
      });
      row = (await repos.workboxHost.update(
        ctx.organizationId,
        id,
        {
          status: "queued",
          generation: row.generation + 1,
          error: null,
          leaseUntil: new Date(Date.now() + leaseMs),
        },
        row.generation,
      ))!;
      const snapshot = row;
      setImmediate(() => launch(ctx, snapshot));
      return publicHost(row);
    });
  }
  if (row.status === "removed")
    throw new AppError(
      "This Workbox host was removed. Install it again before managing it.",
      409,
      "WORKBOX_HOST_REMOVED",
    );
  if (input.action === "remove" && !input.confirm)
    throw new AppError(
      "Confirm removal of this managed Workbox host.",
      400,
      "CONFIRMATION_REQUIRED",
    );
  return withServerProvisioning(ctx, row.serverId, async () =>
    withServerExecution(ctx.organizationId, row.serverId, async (executor) => {
      row = await find(ctx, id, "admin");
      if (["queued", "installing", "removing", "removed"].includes(row.status))
        throw new AppError(
          "This host changed while waiting for its management lock. Refresh its state.",
          409,
          "WORKBOX_HOST_BUSY",
        );
      const root = await rootExecutor(executor);
      await assertWorkboxHostIdle(root);
      const owner = JSON.parse(await root.readFile(`${WORKBOX_CONFIG}/owner.json`));
      if (
        owner.id !== row.id ||
        owner.organizationId !== ctx.organizationId ||
        (await executor.exec("cat /etc/machine-id")).trim() !== row.hostIdentity
      )
        throw new AppError("Managed Workbox host ownership changed.", 409, "WORKBOX_HOST_CHANGED");
      if (input.action === "remove") {
        const unitPresent = await root.exists(`/etc/systemd/system/${WORKBOX_UNIT}`);
        if (unitPresent) {
          const token = decryptSecretField(row.tokenEnc)!;
          const response = await privateRequest(executor, "/v1/sandboxes", {
            headers: { Authorization: `Bearer ${token}` },
          });
          const payload = (await response.json()) as { sandboxes?: unknown[]; items?: unknown[] };
          if (!response.ok || !Array.isArray(payload.sandboxes ?? payload.items))
            throw new AppError(
              "Start the host and verify its sandbox inventory before removal.",
              409,
              "WORKBOX_HOST_INVENTORY_UNAVAILABLE",
            );
          if ((payload.sandboxes ?? payload.items)!.length)
            throw new AppError(
              "Remove this host's sandboxes before removing its daemon.",
              409,
              "WORKBOX_HOST_IN_USE",
            );
          await runManagedWorkboxCommand(
            root,
            `systemctl disable --now ${WORKBOX_UNIT} && rm -f /etc/systemd/system/${WORKBOX_UNIT} && systemctl daemon-reload`,
            60_000,
          );
        } else {
          // Resume a removal that deleted its owned unit before the DB receipt was saved.
          await root.exec(`! systemctl is-active --quiet ${WORKBOX_UNIT}`, { timeout: 15_000 });
        }
        if (row.connectionId)
          await repos.credential.markInvalid(
            ctx.organizationId,
            row.connectionId,
            "Managed Workbox host was removed.",
          );
        row = (await repos.workboxHost.update(ctx.organizationId, id, {
          status: "removed",
          error: null,
          leaseUntil: null,
        }))!;
      } else {
        await runManagedWorkboxCommand(root, `systemctl ${input.action} ${WORKBOX_UNIT}`, 60_000);
        if (input.action === "start") {
          let ready = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            try {
              ready = (await privateRequest(executor, "/readyz", {})).ok;
            } catch {}
            if (ready) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (!ready)
            throw new AppError("Workbox started but is not ready.", 502, "WORKBOX_HOST_NOT_READY");
        }
        row = (await repos.workboxHost.update(ctx.organizationId, id, {
          status: input.action === "start" ? "ready" : "stopped",
          error: null,
        }))!;
      }
      return publicHost(row);
    }),
  );
}

/** Resolve only registered, organization-owned SSH-backed loopback transports. */
export async function managedWorkboxClient(
  organizationId: string,
  publicFields: Record<string, string>,
  apiKey: string,
  ctx?: ExecutionContext,
  verifyOnly = false,
) {
  const row = await repos.workboxHost.find(organizationId, publicFields.managedHostId ?? "");
  if (!row || row.serverId !== publicFields.serverId || row.status !== "ready")
    throw new AppError("The managed Workbox host is not ready.", 409, "WORKBOX_HOST_UNAVAILABLE");
  const request: WorkboxRequest = async (url, options) => {
    const mutation = (options.method ?? "GET") !== "GET";
    if (!ctx && !verifyOnly)
      throw new AppError(
        "Managed Workbox calls require the original scoped authority.",
        403,
        "WORKBOX_AUTHORITY_REQUIRED",
      );
    if (verifyOnly && mutation)
      throw new AppError(
        "Verification cannot mutate a managed host.",
        403,
        "WORKBOX_AUTHORITY_REQUIRED",
      );
    if (ctx)
      await authorization.authorize(ctx, {
        resourceType: "server",
        resourceId: row.serverId,
        action: mutation ? "write" : "read",
      });
    const run = () =>
      withServerExecution(organizationId, row.serverId, async (executor) => {
        const fresh = await repos.workboxHost.find(organizationId, row.id);
        if (fresh?.status !== "ready")
          throw new AppError(
            "The managed Workbox host is not ready.",
            409,
            "WORKBOX_HOST_UNAVAILABLE",
          );
        if (
          (await executor.exec("cat /etc/machine-id", { timeout: 10_000 })).trim() !==
          row.hostIdentity
        )
          throw new AppError("Workbox host identity changed.", 409, "WORKBOX_HOST_CHANGED");
        if (mutation) await assertWorkboxHostIdle(await rootExecutor(executor));
        const parsed = new URL(url);
        if (parsed.origin !== `http://127.0.0.1:${WORKBOX_PORT}`)
          throw new AppError("Invalid managed Workbox endpoint", 400, "WORKBOX_PATH_INVALID");
        return privateRequest(executor, parsed.pathname + parsed.search, options);
      });
    return mutation && ctx ? withServerProvisioning(ctx, row.serverId, run) : run();
  };
  return createWorkboxProvider({ baseUrl: `http://127.0.0.1:${WORKBOX_PORT}`, apiKey, request });
}

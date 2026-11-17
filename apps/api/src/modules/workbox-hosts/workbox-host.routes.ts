import { Hono } from "hono";
import {
  WorkboxHostPreflightInput,
  WorkboxHostCreateInput,
  WorkboxHostActionInput,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import { operationContext, operationData } from "../../lib/operation-context";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
const operations = () => getPlatformKernel().workboxHosts;
const r = secureRouter(new Hono(), { module: "workbox-hosts", basePath: "/api/workbox-hosts" });
r.get(
  "/",
  {
    tag: "server:read",
    collection: true,
    mcp: { description: "List prepared Workbox hosts visible through your server permissions." },
  },
  async (c) => c.json({ data: await operationData(c, operations().list(operationContext(c))) }),
);
r.post(
  "/preflight",
  {
    tag: "server:admin",
    collection: true,
    body: WorkboxHostPreflightInput,
    mcp: {
      description:
        "Inspect a connected Linux server for managed Workbox installation compatibility.",
    },
  },
  async (c) =>
    c.json({
      data: await operationData(c, operations().preflight(operationContext(c), await c.req.json())),
    }),
);
r.post(
  "/",
  {
    tag: "server:admin",
    collection: true,
    body: WorkboxHostCreateInput,
    mcp: {
      description:
        "Prepare a connected Linux server, install a pinned Workbox runtime, and connect its private API after explicit confirmation.",
    },
  },
  async (c) =>
    c.json(
      {
        data: await operationData(c, operations().create(operationContext(c), await c.req.json())),
      },
      202,
    ),
);
r.get(
  "/:id",
  {
    tag: "server:read",
    collection: true,
    mcp: { description: "Read saved Workbox host preparation progress and connection status." },
  },
  async (c) =>
    c.json({
      data: await operationData(
        c,
        operations().get(operationContext(c), { id: c.req.param("id")! }),
      ),
    }),
);
r.post(
  "/:id/action",
  {
    tag: "server:admin",
    collection: true,
    body: WorkboxHostActionInput,
    mcp: {
      description:
        "Start, stop, retry, or remove a managed Workbox host; removal requires confirmation and an empty sandbox inventory.",
      destructive: true,
    },
  },
  async (c) =>
    c.json({
      data: await operationData(
        c,
        operations().action(operationContext(c), {
          ...(await c.req.json()),
          id: c.req.param("id")!,
        }),
      ),
    }),
);
export const workboxHostRoutes = r.hono;

/** Provider-neutral external target planning and operation routes. */
import { Hono } from "hono";
import { ExternalDeploymentCollectionSchemas } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as controller from "./external-deployment.controller";

const r = secureRouter(new Hono(), {
  module: "external-deployments",
  basePath: "/api/external-deployments",
});

r.get(
  "/targets",
  {
    tag: "settings:read",
    collection: true,
    mcp: {
      description:
        "List the organization's explicit external deployment targets. Provider credentials and secrets are never returned.",
    },
  },
  controller.targets,
);

r.post(
  "/capabilities",
  {
    tag: "settings:read",
    collection: true,
    body: ExternalDeploymentCollectionSchemas.capabilities.input,
    mcp: {
      description:
        "Read the capability profile for an explicit provider target and workload kind.",
    },
  },
  controller.capabilities,
);

r.post(
  "/preflight",
  {
    tag: "settings:read",
    collection: true,
    body: ExternalDeploymentCollectionSchemas.preflight.input,
    mcp: {
      description:
        "Check whether an explicit provider target can host the requested workload before mutation.",
    },
  },
  controller.preflight,
);

r.post(
  "/plan",
  {
    tag: "settings:read",
    collection: true,
    body: ExternalDeploymentCollectionSchemas.plan.input,
    mcp: {
      description:
        "Build an expiring external deployment plan from an explicit target, source/image and environment.",
    },
  },
  controller.plan,
);

r.post(
  "/apply",
  {
    tag: "deployment:write",
    collection: true,
    body: ExternalDeploymentCollectionSchemas.apply.input,
    mcp: {
      description:
        "Apply a reviewed external deployment plan with confirmation and an idempotency key.",
    },
  },
  controller.apply,
);

r.post(
  "/observe",
  {
    tag: "settings:read",
    collection: true,
    body: ExternalDeploymentCollectionSchemas.observe.input,
    mcp: {
      description: "Observe an explicit external target or operation and reconcile provider state.",
    },
  },
  controller.observe,
);

r.post(
  "/exec",
  {
    tag: "deployment:write",
    collection: true,
    body: ExternalDeploymentCollectionSchemas.exec.input,
    mcp: {
      description: "Execute a reviewed command in an external sandbox or Workbox child and return bounded output.",
    },
  },
  controller.exec,
);

r.post(
  "/destroy",
  {
    tag: "deployment:write",
    collection: true,
    body: ExternalDeploymentCollectionSchemas.destroy.input,
    mcp: {
      description: "Destroy an external sandbox or workload after explicit confirmation.",
      destructive: true,
    },
  },
  controller.destroy,
);

export const externalDeploymentRoutes = r.hono;

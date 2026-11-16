/** HTTP envelopes for the provider-neutral external deployment operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";

const operations = () => getPlatformKernel().externalDeployments;

export async function targets(c: Context) {
  return c.json({
    data: await operationData(c, operations().targets(operationContext(c))),
  });
}

export async function capabilities(c: Context) {
  return c.json({
    data: await operationData(
      c,
      operations().capabilities(operationContext(c), await c.req.json()),
    ),
  });
}

export async function preflight(c: Context) {
  return c.json({
    data: await operationData(
      c,
      operations().preflight(operationContext(c), await c.req.json()),
    ),
  });
}

export async function plan(c: Context) {
  return c.json({
    data: await operationData(c, operations().plan(operationContext(c), await c.req.json())),
  });
}

export async function apply(c: Context) {
  return c.json(
    {
      data: await operationData(c, operations().apply(operationContext(c), await c.req.json())),
    },
    202,
  );
}

export async function observe(c: Context) {
  return c.json({
    data: await operationData(
      c,
      operations().observe(operationContext(c), await c.req.json()),
    ),
  });
}

export async function exec(c: Context) {
  return c.json({
    data: await operationData(c, operations().exec(operationContext(c), await c.req.json())),
  });
}

export async function destroy(c: Context) {
  return c.json({
    data: await operationData(c, operations().destroy(operationContext(c), await c.req.json())),
  });
}

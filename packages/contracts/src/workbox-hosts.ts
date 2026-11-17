import { Type, type Static } from "@sinclair/typebox";
const text = Type.String();
const hostStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("installing"),
  Type.Literal("ready"),
  Type.Literal("stopped"),
  Type.Literal("failed"),
  Type.Literal("removing"),
  Type.Literal("removed"),
]);
const stepStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);
const hostAction = Type.Union([
  Type.Literal("start"),
  Type.Literal("stop"),
  Type.Literal("retry"),
  Type.Literal("remove"),
]);
export const WorkboxHostSchema = Type.Object({
  id: text,
  serverId: text,
  name: text,
  rootfs: Type.Union([Type.Literal("minimal"), Type.Literal("agents")]),
  version: text,
  status: hostStatus,
  connectionId: Type.Union([text, Type.Null()]),
  progress: Type.Array(
    Type.Object({ id: text, label: text, status: stepStatus, message: Type.Optional(text) }),
  ),
  error: Type.Union([text, Type.Null()]),
  createdAt: text,
  updatedAt: text,
});
export type WorkboxHost = Static<typeof WorkboxHostSchema>;
export const WorkboxHostPreflightSchema = Type.Object({
  accepted: Type.Boolean(),
  checks: Type.Array(Type.Object({ id: text, label: text, ok: Type.Boolean(), detail: text })),
  blockers: Type.Array(text),
});
export type WorkboxHostPreflight = Static<typeof WorkboxHostPreflightSchema>;
export const WorkboxHostPreflightInput = Type.Object(
  { serverId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export const WorkboxHostCreateInput = Type.Object(
  {
    serverId: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    rootfs: Type.Union([Type.Literal("minimal"), Type.Literal("agents")]),
    confirm: Type.Literal(true),
  },
  { additionalProperties: false },
);
export const WorkboxHostActionInput = Type.Object(
  { action: hostAction, confirm: Type.Optional(Type.Literal(true)) },
  { additionalProperties: false },
);
export const WorkboxHostOperationSchemas = {
  list: { action: "read", scope: "list", output: Type.Array(WorkboxHostSchema) },
  get: {
    action: "read",
    scope: "list",
    input: Type.Object({ id: Type.String({ minLength: 1 }) }),
    output: WorkboxHostSchema,
  },
  preflight: {
    action: "admin",
    input: WorkboxHostPreflightInput,
    output: WorkboxHostPreflightSchema,
  },
  create: { action: "admin", input: WorkboxHostCreateInput, output: WorkboxHostSchema },
  action: {
    action: "admin",
    input: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        action: hostAction,
        confirm: Type.Optional(Type.Literal(true)),
      },
      { additionalProperties: false },
    ),
    output: WorkboxHostSchema,
  },
} as const;

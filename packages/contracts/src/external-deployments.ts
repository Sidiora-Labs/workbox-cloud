import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";

const id = Type.String({ minLength: 1, maxLength: 200 });
const text = Type.String({ maxLength: 20_000 });
// Keep this schema self-contained. The contracts package is also consumed by
// callers that do not register TypeBox's optional format registry.
const timestamp = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});

/** Provider resources that are controlled by the external deployment layer. */
export const ExternalProviderSchema = Type.Union([
  Type.Literal("railway"),
  Type.Literal("vercel"),
  Type.Literal("fly"),
  Type.Literal("blaxel"),
  Type.Literal("self-managed"),
  Type.Literal("workbox"),
]);
export type ExternalProvider = Static<typeof ExternalProviderSchema>;

/** The workload semantics are deliberately separate from provider identity. */
export const ExternalWorkloadKindSchema = Type.Union([
  Type.Literal("service"),
  Type.Literal("railway-sandbox"),
  Type.Literal("vercel-sandbox"),
  Type.Literal("fly-machine"),
  Type.Literal("fly-sprite"),
  Type.Literal("blaxel-sandbox"),
  Type.Literal("self-managed-server"),
  Type.Literal("workbox-host"),
  Type.Literal("workbox-sandbox"),
]);
export type ExternalWorkloadKind = Static<typeof ExternalWorkloadKindSchema>;

export const ExternalOperationKindSchema = Type.Union([
  Type.Literal("discover"),
  Type.Literal("capabilities"),
  Type.Literal("preflight"),
  Type.Literal("plan"),
  Type.Literal("apply"),
  Type.Literal("observe"),
  Type.Literal("logs"),
  Type.Literal("exec"),
  Type.Literal("session"),
  Type.Literal("files"),
  Type.Literal("snapshot"),
  Type.Literal("checkpoint"),
  Type.Literal("stop"),
  Type.Literal("resume"),
  Type.Literal("promote"),
  Type.Literal("rollback"),
  Type.Literal("destroy"),
  Type.Literal("reconcile"),
]);
export type ExternalOperationKind = Static<typeof ExternalOperationKindSchema>;

export const ExternalOperationStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("provisioning"),
  Type.Literal("running"),
  Type.Literal("stopping"),
  Type.Literal("stopped"),
  Type.Literal("ready"),
  Type.Literal("failed"),
  Type.Literal("unsupported"),
  Type.Literal("action_required"),
  Type.Literal("unknown"),
  Type.Literal("reconciling"),
]);
export type ExternalOperationStatus = Static<typeof ExternalOperationStatusSchema>;

export const ExternalCapabilityNameSchema = Type.Union([
  Type.Literal("discover"),
  Type.Literal("preflight"),
  Type.Literal("apply"),
  Type.Literal("observe"),
  Type.Literal("logs"),
  Type.Literal("exec"),
  Type.Literal("session"),
  Type.Literal("files"),
  Type.Literal("snapshot"),
  Type.Literal("checkpoint"),
  Type.Literal("stop"),
  Type.Literal("resume"),
  Type.Literal("promote"),
  Type.Literal("rollback"),
  Type.Literal("destroy"),
  Type.Literal("reconcile"),
  Type.Literal("public-ingress"),
  Type.Literal("persistent-storage"),
  Type.Literal("shared-storage"),
  Type.Literal("private-network"),
  Type.Literal("idle-policy"),
]);
export type ExternalCapabilityName = Static<typeof ExternalCapabilityNameSchema>;

export const ExternalCapabilityProfileSchema = Type.Object(
  {
    provider: ExternalProviderSchema,
    workloadKind: ExternalWorkloadKindSchema,
    checkedAt: timestamp,
    expiresAt: Type.Optional(timestamp),
    apiVersion: Type.Optional(text),
    sdkVersion: Type.Optional(text),
    supported: Type.Array(ExternalCapabilityNameSchema),
    unsupported: Type.Array(
      Type.Object({ capability: ExternalCapabilityNameSchema, reason: text }),
    ),
    limits: Type.Record(Type.String({ maxLength: 100 }), Type.Union([Type.String(), Type.Number()])),
    observedIdentity: Type.Record(Type.String({ maxLength: 100 }), text),
  },
  { additionalProperties: false },
);
export type ExternalCapabilityProfile = Static<typeof ExternalCapabilityProfileSchema>;

export const ExternalCatalogIdentitySchema = Type.Object({
  templateId: id, recipeId: id, name: text, logo: text,
  version: Type.Optional(text), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
}, { additionalProperties: false });
export type ExternalCatalogIdentity = Static<typeof ExternalCatalogIdentitySchema>;

/** Immutable binding used by every external operation and deployment snapshot. */
export const ExternalTargetSnapshotSchema = Type.Object(
  {
    targetId: id,
    organizationId: id,
    provider: ExternalProviderSchema,
    workloadKind: ExternalWorkloadKindSchema,
    connectionId: id,
    providerIdentity: Type.Record(Type.String({ maxLength: 100 }), text),
    resource: Type.Record(Type.String({ maxLength: 100 }), text),
    revision: Type.Optional(text),
    capability: Type.Optional(ExternalCapabilityProfileSchema),
    catalog: Type.Optional(ExternalCatalogIdentitySchema),
    capturedAt: timestamp,
  },
  { additionalProperties: false },
);
export type ExternalTargetSnapshot = Static<typeof ExternalTargetSnapshotSchema>;

export const ExternalOperationSchema = Type.Object(
  {
    id: id,
    organizationId: id,
    targetId: id,
    kind: ExternalOperationKindSchema,
    workloadKind: ExternalWorkloadKindSchema,
    status: ExternalOperationStatusSchema,
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
    target: ExternalTargetSnapshotSchema,
    providerRequestId: Type.Optional(text),
    providerResourceId: Type.Optional(text),
    providerStatus: Type.Optional(text),
    message: Type.Optional(text),
    errorCode: Type.Optional(text),
    logCursor: Type.Optional(Type.String({ maxLength: 200 })),
    createdAt: timestamp,
    updatedAt: timestamp,
    reconciledAt: Type.Optional(timestamp),
  },
  { additionalProperties: false },
);
export type ExternalOperation = Static<typeof ExternalOperationSchema>;

export const ExternalExecInputSchema = Type.Object({
  operationId: id,
  argv: Type.Array(text, { minItems: 1, maxItems: 128 }),
  cwd: Type.Optional(text),
  env: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), text)),
});
export type ExternalExecInput = Static<typeof ExternalExecInputSchema>;

export const ExternalExecOutputSchema = Type.Object({
  operation: ExternalOperationSchema,
  stdout: text,
  stderr: text,
  exitCode: Type.Union([Type.Number(), Type.Null()]),
});
export type ExternalExecOutput = Static<typeof ExternalExecOutputSchema>;

export const ExternalDestroyInputSchema = Type.Object({
  operationId: id,
  confirm: Type.Boolean(),
});
export type ExternalDestroyInput = Static<typeof ExternalDestroyInputSchema>;

export const ExternalTargetInputSchema = Type.Object(
  {
    provider: ExternalProviderSchema,
    workloadKind: ExternalWorkloadKindSchema,
    connectionId: id,
    providerIdentity: Type.Record(Type.String({ maxLength: 100 }), text),
    resource: Type.Record(Type.String({ maxLength: 100 }), text),
    revision: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type ExternalTargetInput = Static<typeof ExternalTargetInputSchema>;

export const ExternalPlanInputSchema = Type.Object(
  {
    target: ExternalTargetInputSchema,
    catalog: Type.Optional(Type.Object({
      templateId: id, recipeId: id,
      config: Type.Optional(Type.Record(Type.String({ maxLength: 100 }), text)),
    }, { additionalProperties: false })),
    source: Type.Optional(Type.Record(Type.String({ maxLength: 100 }), text)),
    image: Type.Optional(text),
    environment: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), text)),
    workload: Type.Optional(Type.Record(Type.String({ maxLength: 100 }), text)),
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type ExternalPlanInput = Static<typeof ExternalPlanInputSchema>;

export const ExternalPlanSchema = Type.Object(
  {
    planId: id,
    target: ExternalTargetSnapshotSchema,
    capability: ExternalCapabilityProfileSchema,
    accepted: Type.Boolean(),
    blockers: Type.Array(text),
    warnings: Type.Array(text),
    expiresAt: timestamp,
  },
  { additionalProperties: false },
);
export type ExternalPlan = Static<typeof ExternalPlanSchema>;

export const ExternalApplyInputSchema = Type.Object(
  {
    planId: id,
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
    confirm: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ExternalApplyInput = Static<typeof ExternalApplyInputSchema>;

export const ExternalObserveInputSchema = Type.Object(
  {
    target: ExternalTargetInputSchema,
    operationId: Type.Optional(id),
  },
  { additionalProperties: false },
);
export type ExternalObserveInput = Static<typeof ExternalObserveInputSchema>;

/** Organization-scoped target bindings available to dashboard/CLI pickers. */
export const ExternalTargetListOutputSchema = Type.Array(ExternalTargetSnapshotSchema);
export type ExternalTargetListOutput = Static<typeof ExternalTargetListOutputSchema>;

/** Read-only, credential-scoped inputs for the deployment destination picker. */
export const ExternalDiscoveryInputSchema = Type.Object({
  connectionId: id,
  projectId: Type.Optional(id),
}, { additionalProperties: false });
export type ExternalDiscoveryInput = Static<typeof ExternalDiscoveryInputSchema>;
const discoveryNamed = Type.Object({ id, name: text }, { additionalProperties: false });
export const ExternalDiscoveryOutputSchema = Type.Object({
  provider: ExternalProviderSchema,
  connectionId: id,
  projects: Type.Array(Type.Object({
    id,
    name: text,
    environments: Type.Array(discoveryNamed),
    services: Type.Array(discoveryNamed),
  }, { additionalProperties: false })),
  apps: Type.Array(Type.Object({ id, name: text, region: Type.Optional(text) }, { additionalProperties: false })),
  environments: Type.Array(discoveryNamed),
  images: Type.Array(discoveryNamed),
  warnings: Type.Array(text),
}, { additionalProperties: false });
export type ExternalDiscoveryOutput = Static<typeof ExternalDiscoveryOutputSchema>;

export const ExternalOperationListInputSchema = Type.Object({
  targetId: Type.Optional(id),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, { additionalProperties: false });
export type ExternalOperationListInput = Static<typeof ExternalOperationListInputSchema>;
export const ExternalOperationListOutputSchema = Type.Array(ExternalOperationSchema);

export const ExternalLogEntrySchema = Type.Object(
  {
    cursor: Type.String({ maxLength: 200 }),
    timestamp: timestamp,
    stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("system")]),
    message: text,
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ExternalLogEntry = Static<typeof ExternalLogEntrySchema>;

export const ExternalLogsInputSchema = Type.Object({
  operationId: id, cursor: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false });
export type ExternalLogsInput = Static<typeof ExternalLogsInputSchema>;
export const ExternalLogsOutputSchema = Type.Object({
  entries: Type.Array(ExternalLogEntrySchema, { maxItems: 200 }),
  cursor: Type.Optional(Type.String({ maxLength: 200 })), truncated: Type.Boolean(),
}, { additionalProperties: false });
export type ExternalLogsOutput = Static<typeof ExternalLogsOutputSchema>;

export const ExternalErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 100 }),
    message: Type.String({ minLength: 1, maxLength: 1000 }),
    retryable: Type.Boolean(),
    unknownOutcome: Type.Boolean(),
    providerStatus: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);
export type ExternalError = Static<typeof ExternalErrorSchema>;

export const ExternalDeploymentCollectionSchemas = {
  logs: { action: "read", scope: "list", input: ExternalLogsInputSchema, output: ExternalLogsOutputSchema },
  discover: {
    action: "read",
    scope: "list",
    input: ExternalDiscoveryInputSchema,
    output: ExternalDiscoveryOutputSchema,
  },
  operations: {
    action: "read",
    scope: "list",
    input: ExternalOperationListInputSchema,
    output: ExternalOperationListOutputSchema,
  },
  targets: {
    action: "read",
    scope: "list",
    output: ExternalTargetListOutputSchema,
  },
  capabilities: {
    action: "write",
    input: ExternalTargetInputSchema,
    output: ExternalCapabilityProfileSchema,
  },
  preflight: {
    action: "write",
    input: ExternalTargetInputSchema,
    output: ExternalPlanSchema,
  },
  plan: {
    action: "write",
    input: ExternalPlanInputSchema,
    output: ExternalPlanSchema,
  },
  apply: {
    action: "write",
    input: ExternalApplyInputSchema,
    output: ExternalOperationSchema,
  },
  observe: {
    action: "write",
    input: ExternalObserveInputSchema,
    output: ExternalOperationSchema,
  },
  exec: {
    action: "write",
    input: ExternalExecInputSchema,
    output: ExternalExecOutputSchema,
  },
  destroy: {
    action: "write",
    input: ExternalDestroyInputSchema,
    output: ExternalOperationSchema,
  },
} as const satisfies Record<string, ResourceOperationSchema>;

import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./organization";
import { credential } from "./credential";
import { project } from "./project";
import { deployment } from "./deployment";

/**
 * An organization-scoped binding to an external provider resource.
 *
 * This table deliberately does not replace project.serverId/workspaceId. Those
 * columns remain authoritative for Openship host runtimes. External targets use
 * this record so provider accounts, sandboxes and service resources have an
 * explicit identity and cannot be inferred from a credential's recency.
 */
export const externalDeploymentTarget = pgTable(
  "external_deployment_target",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credential.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    workloadKind: text("workload_kind").notNull(),
    /** Provider account/team/workspace identity captured during verification. */
    providerIdentity: jsonb("provider_identity")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Opaque provider resource IDs and selectors (never secrets). */
    resource: jsonb("resource")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Stable canonical target fingerprint used for idempotent target reuse. */
    fingerprint: text("fingerprint").notNull(),
    displayName: text("display_name").notNull(),
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown> | null>(),
    status: text("status").notNull().default("active"),
    lastPreflightAt: timestamp("last_preflight_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_external_target_org_fingerprint").on(
      table.organizationId,
      table.fingerprint,
    ),
    index("idx_external_target_org_provider").on(
      table.organizationId,
      table.provider,
      table.workloadKind,
    ),
    index("idx_external_target_credential").on(table.credentialId),
  ],
);

/** Durable intent and reconciliation state for an external provider mutation. */
export const externalDeploymentOperation = pgTable(
  "external_deployment_operation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => externalDeploymentTarget.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
    deploymentId: text("deployment_id").references(() => deployment.id, { onDelete: "set null" }),
    operation: text("operation").notNull(),
    workloadKind: text("workload_kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("queued"),
    /** Provider request or operation identifier, once returned. */
    providerRequestId: text("provider_request_id"),
    providerResourceId: text("provider_resource_id"),
    /** Immutable request/target snapshot. Never store decrypted secrets here. */
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    providerStatus: text("provider_status"),
    observed: jsonb("observed").$type<Record<string, unknown> | null>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    reconcileAfter: timestamp("reconcile_after"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_external_operation_org_idempotency").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("idx_external_operation_target_status").on(
      table.targetId,
      table.status,
      table.createdAt,
    ),
    index("idx_external_operation_reconcile").on(
      table.status,
      table.reconcileAfter,
    ),
    index("idx_external_operation_project").on(table.projectId, table.createdAt),
  ],
);

export type ExternalDeploymentTarget = typeof externalDeploymentTarget.$inferSelect;
export type NewExternalDeploymentTarget = typeof externalDeploymentTarget.$inferInsert;
export type ExternalDeploymentOperation = typeof externalDeploymentOperation.$inferSelect;
export type NewExternalDeploymentOperation = typeof externalDeploymentOperation.$inferInsert;

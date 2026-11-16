-- External provider targets and durable mutation intent.
-- These tables are additive; existing project.server_id/workspace_id bindings remain authoritative for host runtimes.
CREATE TABLE IF NOT EXISTS "external_deployment_target" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL REFERENCES "credential"("id") ON DELETE RESTRICT,
  "provider" text NOT NULL,
  "workload_kind" text NOT NULL,
  "provider_identity" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "resource" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "fingerprint" text NOT NULL,
  "display_name" text NOT NULL,
  "capabilities" jsonb,
  "status" text DEFAULT 'active' NOT NULL,
  "last_preflight_at" timestamp,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_external_target_org_fingerprint"
  ON "external_deployment_target" ("organization_id", "fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_target_org_provider"
  ON "external_deployment_target" ("organization_id", "provider", "workload_kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_target_credential"
  ON "external_deployment_target" ("credential_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_deployment_operation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "target_id" text NOT NULL REFERENCES "external_deployment_target"("id") ON DELETE CASCADE,
  "project_id" text REFERENCES "project"("id") ON DELETE SET NULL,
  "deployment_id" text REFERENCES "deployment"("id") ON DELETE SET NULL,
  "operation" text NOT NULL,
  "workload_kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "provider_request_id" text,
  "provider_resource_id" text,
  "request" jsonb NOT NULL,
  "provider_status" text,
  "observed" jsonb,
  "error_code" text,
  "error_message" text,
  "lease_owner" text,
  "lease_until" timestamp,
  "reconcile_after" timestamp,
  "started_at" timestamp,
  "finished_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_external_operation_org_idempotency"
  ON "external_deployment_operation" ("organization_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_operation_target_status"
  ON "external_deployment_operation" ("target_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_operation_reconcile"
  ON "external_deployment_operation" ("status", "reconcile_after");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_operation_project"
  ON "external_deployment_operation" ("project_id", "created_at");

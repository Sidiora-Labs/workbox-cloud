import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const migration = new URL("../drizzle/0233_external_deployment_targets.sql", import.meta.url);

describe("external deployment persistence migration", () => {
  it("creates organization-scoped targets with explicit credential identity", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "external_deployment_target"');
    expect(sql).toContain('"organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE');
    expect(sql).toContain('"credential_id" text NOT NULL REFERENCES "credential"("id") ON DELETE RESTRICT');
    expect(sql).toContain('"workload_kind" text NOT NULL');
    expect(sql).toContain('"provider_identity" jsonb');
    expect(sql).toContain('"resource" jsonb');
    expect(sql).toContain('"uq_external_target_org_fingerprint"');
  });

  it("makes external mutations idempotent and recoverable", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "external_deployment_operation"');
    expect(sql).toContain('"idempotency_key" text NOT NULL');
    expect(sql).toContain('"request" jsonb NOT NULL');
    expect(sql).toContain('"provider_request_id" text');
    expect(sql).toContain('"reconcile_after" timestamp');
    expect(sql).toContain('"uq_external_operation_org_idempotency"');
  });
});

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ExternalCapabilityProfileSchema,
  ExternalOperationSchema,
  ExternalPlanInputSchema,
  ExternalTargetInputSchema,
} from "../src/external-deployments";

const target = {
  provider: "vercel" as const,
  workloadKind: "vercel-sandbox" as const,
  connectionId: "conn_v1",
  providerIdentity: { accountId: "acct_1", teamId: "team_1" },
  resource: { projectId: "proj_1", name: "agent-a" },
};

const capability = {
  provider: "vercel" as const,
  workloadKind: "vercel-sandbox" as const,
  checkedAt: "2026-11-16T12:00:00.000Z",
  supported: ["apply", "observe", "exec", "session", "snapshot", "stop", "resume", "destroy"] as const,
  unsupported: [],
  limits: { maxSessions: 1 },
  observedIdentity: { accountId: "acct_1" },
};

describe("external deployment contracts", () => {
  it("accepts distinct provider target and workload identity", () => {
    expect(Value.Check(ExternalTargetInputSchema, target)).toBe(true);
    expect(Value.Check(ExternalTargetInputSchema, { ...target, workloadKind: "service" })).toBe(true);
  });

  it("rejects malformed idempotency keys and missing target scope", () => {
    expect(Value.Check(ExternalPlanInputSchema, { target, idempotencyKey: "short" })).toBe(false);
    expect(Value.Check(ExternalPlanInputSchema, { target, idempotencyKey: "deploy:acct_1:0001" })).toBe(true);
    expect(Value.Check(ExternalTargetInputSchema, { ...target, providerIdentity: "acct_1" })).toBe(false);
  });

  it("requires a capability profile to identify provider and workload kind", () => {
    expect(Value.Check(ExternalCapabilityProfileSchema, capability)).toBe(true);
    expect(Value.Check(ExternalCapabilityProfileSchema, { ...capability, provider: "unknown" })).toBe(false);
  });

  it("keeps unknown outcomes explicit in operation records", () => {
    expect(Value.Check(ExternalOperationSchema, {
      id: "op_1",
      organizationId: "org_1",
      targetId: "target_1",
      kind: "apply",
      workloadKind: "vercel-sandbox",
      status: "unknown",
      idempotencyKey: "deploy:acct_1:0001",
      target: {
        ...target,
        targetId: "target_1",
        organizationId: "org_1",
        capturedAt: "2026-11-16T12:00:00.000Z",
      },
      createdAt: "2026-11-16T12:00:00.000Z",
      updatedAt: "2026-11-16T12:00:00.000Z",
    })).toBe(true);
  });
});

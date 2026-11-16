import { describe, expect, it } from "vitest";
import {
  ExternalProviderRegistry,
  assertExternalIdempotencyKey,
  assertExternalTargetOrganization,
  isExternalUnknownOutcome,
  normalizeExternalError,
  requireExternalCapability,
} from "../src/external-deployments";
import type { ExternalProviderAdapter } from "../src/external-deployments";
import { AppError } from "@repo/core";

const adapter = (provider: "railway" | "vercel"): ExternalProviderAdapter => ({
  provider,
  workloads: provider === "railway" ? ["service", "railway-sandbox"] : ["service", "vercel-sandbox"],
  capabilities: async () => { throw new Error("not used"); },
  preflight: async () => { throw new Error("not used"); },
  plan: async () => { throw new Error("not used"); },
  apply: async () => { throw new Error("not used"); },
  observe: async () => { throw new Error("not used"); },
});

describe("external deployment adapter boundary", () => {
  it("selects providers and rejects unsupported workloads", () => {
    const registry = new ExternalProviderRegistry([adapter("railway"), adapter("vercel")]);
    expect(registry.get("railway", "railway-sandbox").provider).toBe("railway");
    expect(() => registry.get("vercel", "railway-sandbox")).toThrow("does not support workload");
    expect(() => registry.get("fly")).toThrow("not configured");
  });

  it("enforces capabilities and target organization", () => {
    const profile = {
      provider: "railway" as const,
      workloadKind: "railway-sandbox" as const,
      checkedAt: "2026-11-16T12:00:00.000Z",
      supported: ["exec"] as const,
      unsupported: [{ capability: "snapshot" as const, reason: "not enabled" }],
      limits: {},
      observedIdentity: {},
    };
    requireExternalCapability(profile, "exec");
    expect(() => requireExternalCapability(profile, "snapshot")).toThrow("not enabled");
    expect(() => assertExternalTargetOrganization(
      { organizationId: "org_1" },
      { providerIdentity: { organizationId: "org_2" } } as never,
    )).toThrow("another organization");
  });

  it("treats network loss during mutation as an unknown outcome", () => {
    const error = new Error("socket hang up");
    expect(isExternalUnknownOutcome(error)).toBe(true);
    expect(normalizeExternalError(error, { mutation: true })).toMatchObject({
      code: "EXTERNAL_PROVIDER_ERROR",
      retryable: true,
      unknownOutcome: true,
    });
    expect(normalizeExternalError(new AppError("bad request", 400, "INVALID_REQUEST"), { mutation: true })).toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
      unknownOutcome: false,
    });
  });

  it("validates idempotency key shape", () => {
    assertExternalIdempotencyKey("deploy:vercel:0001");
    expect(() => assertExternalIdempotencyKey("bad")).toThrow("invalid");
  });
});

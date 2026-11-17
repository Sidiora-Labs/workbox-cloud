import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinExternalProviderRegistry } from "../src/engine/modules/external-deployments/builtin-registry";
import { safeFetch } from "../src/engine/lib/safe-fetch";
import type { ExternalTargetInput } from "@repo/contracts";

vi.mock("../src/engine/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
beforeEach(() => vi.mocked(safeFetch).mockReset());

const context = { organizationId: "workspace-one" };
const target: ExternalTargetInput = {
  provider: "fly", workloadKind: "fly-sprite", connectionId: "connection-one",
  providerIdentity: { organizationId: "org-one" }, resource: { spriteName: "existing-sprite" },
};

function adapter(spriteToken?: string) {
  return createBuiltinExternalProviderRegistry(async () => ({
    id: "connection-one", publicFields: { organizationId: "org-one" },
    secrets: { apiToken: "machines-secret", ...(spriteToken ? { spriteToken } : {}) },
  })).get("fly");
}

describe("Fly connection workload credentials", () => {
  it("keeps Machines available and rejects Sprite plans without a Sprite token", async () => {
    const fly = adapter();
    expect((await fly.capabilities(context, { ...target, workloadKind: "fly-machine" })).supported).toContain("apply");
    expect((await fly.capabilities(context, target)).supported).toEqual([]);
    expect((await fly.preflight(context, target)).accepted).toBe(false);
    expect((await fly.plan(context, { target, idempotencyKey: "plan:0001" })).accepted).toBe(false);
    await expect(fly.observe(context, { target })).rejects.toMatchObject({ code: "CONNECTION_RECONNECT_REQUIRED" });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("uses the separate Sprite token for Sprite observation", async () => {
    vi.mocked(safeFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: "existing-sprite", state: "warm" }) } as never);
    const fly = adapter("sprites-secret");
    expect((await fly.capabilities(context, target)).supported).toContain("apply");
    await fly.observe(context, { target });
    expect(safeFetch).toHaveBeenCalledWith("https://api.sprites.dev/v1/sprites/existing-sprite", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sprites-secret" }),
    }));
  });
});

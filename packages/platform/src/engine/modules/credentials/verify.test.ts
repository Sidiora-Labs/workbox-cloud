import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialProvider, splitCredentialValues } from "@repo/core";
import { hasVerifier, verifyCredentialValues } from "./verify";
import { workboxReady } from "./provider-api";
import { safeFetch } from "../../lib/safe-fetch";

vi.mock("../../lib/safe-fetch", () => ({ safeFetch: vi.fn() }));

beforeEach(() => vi.mocked(safeFetch).mockReset());

describe("external credential verification", () => {
  it("registers Fly and Workbox verifiers", () => {
    expect(hasVerifier("fly")).toBe(true);
    expect(hasVerifier("workbox")).toBe(true);
  });

  it("rejects invalid Workbox endpoints before network access", async () => {
    await expect(workboxReady("not-a-url", "wbk_test")).rejects.toMatchObject({
      code: "CONNECTION_ENDPOINT_INVALID",
    });
    await expect(workboxReady("http://workbox.example.com", "wbk_test")).rejects.toMatchObject({
      code: "CONNECTION_ENDPOINT_INVALID",
    });
  });

  it("accepts a Machines-only Fly credential without sending its token to Sprites", async () => {
    vi.mocked(safeFetch).mockResolvedValue({ ok: true, json: async () => ({ apps: [] }) } as never);
    const verdict = await verifyCredentialValues(getCredentialProvider("fly")!, {
      selector: "org-one", publicFields: { organizationId: "org-one" }, secrets: { apiToken: "machines-secret" },
    });
    expect(verdict.ok).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch).toHaveBeenCalledWith("https://api.machines.dev/v1/apps?org_slug=org-one", expect.objectContaining({
      headers: { Authorization: "Bearer machines-secret" },
    }));
  });

  it("verifies a separately supplied Sprite token against the Sprite API", async () => {
    vi.mocked(safeFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as never);
    const values = splitCredentialValues(getCredentialProvider("fly")!, { apiToken: "machines-secret", spriteToken: "sprites-secret", organizationId: "org-one" });
    expect(values.publicFields).not.toHaveProperty("spriteToken");
    const verdict = await verifyCredentialValues(getCredentialProvider("fly")!, { selector: "org-one", ...values });
    expect(verdict.ok).toBe(true);
    expect(safeFetch).toHaveBeenNthCalledWith(2, "https://api.sprites.dev/v1/sprites", expect.objectContaining({
      headers: { Authorization: "Bearer sprites-secret" },
    }));
  });

  it("rejects a supplied Sprite token that the provider refuses", async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as never)
      .mockResolvedValueOnce({ ok: false, status: 401 } as never);
    const verdict = await verifyCredentialValues(getCredentialProvider("fly")!, {
      selector: "org-one", publicFields: { organizationId: "org-one" },
      secrets: { apiToken: "machines-secret", spriteToken: "invalid-sprites-secret" },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).not.toContain("invalid-sprites-secret");
  });
});

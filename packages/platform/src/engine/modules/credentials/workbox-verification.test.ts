import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeFetch } from "../../lib/safe-fetch";
import { workboxReady } from "./provider-api";

vi.mock("../../lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
beforeEach(() => vi.mocked(safeFetch).mockReset());

describe("Workbox credential verification", () => {
  it("checks the protected inventory after public readiness", async () => {
    vi.mocked(safeFetch).mockResolvedValue({ ok: true } as never);
    await workboxReady("https://workbox.example.test", "scoped-key");
    expect(safeFetch).toHaveBeenNthCalledWith(2, "https://workbox.example.test/v1/sandboxes?limit=1", expect.objectContaining({
      headers: { Authorization: "Bearer scoped-key", Accept: "application/json" },
    }));
  });

  it("rejects credentials when only the public readiness endpoint succeeds", async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce({ ok: true } as never)
      .mockResolvedValueOnce({ ok: false, status: 403 } as never);
    await expect(workboxReady("https://workbox.example.test", "invalid-secret")).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
  });
});

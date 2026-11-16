import { describe, expect, it } from "vitest";
import { hasVerifier } from "./verify";
import { workboxReady } from "./provider-api";

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
});

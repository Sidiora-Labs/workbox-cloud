import { describe, expect, it, vi } from "vitest";
import type { SafeFetchResponse } from "../../../lib/safe-fetch";
import {
  WorkboxProvider,
  normalizeWorkboxStatus,
  workboxPath,
} from "./workbox";

function response(value: unknown, status = 200): SafeFetchResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { "content-type": "application/json" },
    text: async () => JSON.stringify(value),
    json: async () => value,
    bytes: async () => Buffer.from(JSON.stringify(value)),
  };
}

describe("Workbox provider adapter", () => {
  it.each([
    ["REQUESTED", "requested"],
    ["READY", "ready"],
    ["DELETING", "deleting"],
    ["QUARANTINED", "quarantined"],
    ["garbage", "unknown"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeWorkboxStatus(input)).toBe(expected);
  });

  it("normalizes endpoint paths and rejects credentials in the URL", () => {
    expect(workboxPath("https://workbox.example.test/", "/v1/sandboxes")).toBe(
      "https://workbox.example.test/v1/sandboxes",
    );
    expect(workboxPath("https://workbox.example.test/workbox/", "/v1/sandboxes?limit=1")).toBe(
      "https://workbox.example.test/workbox/v1/sandboxes?limit=1",
    );
    expect(new WorkboxProvider({ baseUrl: "https://workbox.example.test/workbox", apiKey: "key" }).sessionWebSocketUrl("sbx-1", "session-1")).toBe(
      "wss://workbox.example.test/workbox/v1/sandboxes/sbx-1/sessions/session-1/ws",
    );
    expect(() => workboxPath("https://user:secret@workbox.example.test", "/healthz")).toThrow(
      "without embedded credentials",
    );
  });

  it("runs preflight and keeps the bearer token out of the result", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const request = vi.fn(async (url: string, options: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: options.headers });
      return response({ ok: true });
    });
    const provider = new WorkboxProvider({
      baseUrl: "https://workbox.example.test",
      apiKey: "wbk_super_secret",
      request,
    });

    const profile = await provider.preflight();
    expect(profile.reachable).toBe(true);
    expect(profile.ready).toBe(true);
    expect(JSON.stringify(profile)).not.toContain("wbk_super_secret");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers?.authorization).toBe("Bearer wbk_super_secret");
  });

  it("rejects a key which can reach public health but not the protected inventory", async () => {
    const provider = new WorkboxProvider({
      baseUrl: "https://workbox.example.test",
      apiKey: "invalid-key",
      request: async (url) => response({}, url.includes("/v1/sandboxes") ? 401 : 200),
    });
    const result = await provider.preflight();
    expect(result.reachable).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "authentication", ok: false }));
  });

  it("sends an idempotency key for sandbox creation", async () => {
    const request = vi.fn(async (_url: string, options: { headers?: Record<string, string>; body?: string }) => {
      expect(options.headers?.["idempotency-key"]).toBe("create-1");
      expect(JSON.parse(options.body ?? "{}")).toMatchObject({ idempotencyKey: "create-1", name: "demo" });
      return response({ id: "sbx_1", desired: "READY" }, 201);
    });
    const provider = new WorkboxProvider({ baseUrl: "https://workbox.example.test", apiKey: "wbk_secret", request });
    await expect(provider.createSandbox({ name: "demo", idempotencyKey: "create-1" })).resolves.toMatchObject({ id: "sbx_1" });
  });

  it("maps provider errors without returning response bodies", async () => {
    const request = vi.fn(async () => response({ secret: "do-not-leak" }, 401));
    const provider = new WorkboxProvider({ baseUrl: "https://workbox.example.test", apiKey: "wbk_secret", request });
    await expect(provider.inspectSandbox("sbx_1")).rejects.toMatchObject({ code: "WORKBOX_AUTHENTICATION" });
    await expect(provider.inspectSandbox("sbx_1")).rejects.not.toThrow("do-not-leak");
  });
});

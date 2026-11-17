import { describe, expect, it } from "vitest";
import type { ExternalLogEntry } from "@repo/contracts";
import { collectExternalLogs } from "../src/engine/modules/external-deployments/external-log-collector";

const entry = (message: string, cursor = "1"): ExternalLogEntry => ({
  message, cursor, stream: "stdout", timestamp: "2026-11-17T00:00:00.000Z",
});

describe("external workload log boundaries", () => {
  it("redacts configured secrets before truncation, including URL encoding", async () => {
    async function* logs() { yield entry("key=super/secret encoded=super%2Fsecret public=ready"); }
    const result = await collectExternalLogs(logs(), ["super/secret"], { maxCharacters: 40 });
    expect(result.entries[0].message).toContain("key=[redacted] encoded=[redacted]");
    expect(result.entries[0].message.length).toBeLessThanOrEqual(40);
    expect(result.entries[0].truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super");
    expect(result.truncated).toBe(true);
  });

  it("bounds an unending stream by entry count and closes it", async () => {
    let closed = false;
    async function* logs() {
      try { for (let i = 0; ; i++) yield entry("line", String(i)); }
      finally { closed = true; }
    }
    const result = await collectExternalLogs(logs(), [], { maxEntries: 3 });
    expect(result.entries).toHaveLength(3);
    expect(result.cursor).toBe("2");
    expect(result.truncated).toBe(true);
    expect(closed).toBe(true);
  });

  it("returns within its deadline when a provider never yields or closes", async () => {
    const stream: AsyncIterable<ExternalLogEntry> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: () => new Promise(() => {}) }),
    };
    const result = await collectExternalLogs(stream, [], { deadlineMs: 10 });
    expect(result).toEqual({ entries: [], truncated: true });
  });

  it("does not report a completed short stream as truncated", async () => {
    async function* logs() { yield entry("ready"); }
    const result = await collectExternalLogs(logs(), []);
    expect(result.entries[0].message).toBe("ready");
    expect(result.truncated).toBe(false);
  });
});

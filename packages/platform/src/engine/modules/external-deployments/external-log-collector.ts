import type { ExternalLogEntry, ExternalLogsOutput } from "@repo/contracts";

/** Bound both the wait and response size, even for streaming provider adapters. */
export async function collectExternalLogs(
  source: AsyncIterable<ExternalLogEntry>,
  secrets: readonly string[],
  options: { deadlineMs?: number; maxEntries?: number; maxCharacters?: number } = {},
): Promise<ExternalLogsOutput> {
  const deadline = Date.now() + (options.deadlineMs ?? 10_000);
  const maxEntries = options.maxEntries ?? 200;
  const maxCharacters = options.maxCharacters ?? 20_000;
  const sensitive = [...new Set(secrets.filter(Boolean).flatMap(value => [value, encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  const redact = (value: string) => sensitive.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
  const entries: ExternalLogEntry[] = [];
  const iterator = source[Symbol.asyncIterator]();
  let characters = 0;
  let truncated = false;
  let cursor: string | undefined;
  try {
    while (entries.length < maxEntries && characters < maxCharacters) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { truncated = true; break; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (!next) { truncated = true; break; }
      if (next.done) break;
      const entry = next.value;
      const message = redact(entry.message);
      const limit = maxCharacters - characters;
      cursor = redact(entry.cursor).slice(0, 200);
      entries.push({
        cursor,
        timestamp: Number.isFinite(Date.parse(entry.timestamp)) ? new Date(entry.timestamp).toISOString() : new Date().toISOString(),
        stream: entry.stream === "stdout" || entry.stream === "stderr" ? entry.stream : "system",
        message: message.slice(0, limit),
        ...(entry.truncated || message.length > limit ? { truncated: true } : {}),
      });
      characters += Math.min(message.length, limit);
      if (message.length > limit || entry.truncated) truncated = true;
    }
    if (entries.length >= maxEntries || characters >= maxCharacters) truncated = true;
  } finally {
    // An uncooperative streaming provider must not hold the HTTP response open.
    void iterator.return?.().catch(() => undefined);
  }
  return { entries, ...(cursor ? { cursor } : {}), truncated };
}


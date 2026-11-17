import { beforeEach, describe, expect, it, vi } from "vitest";
import { railwayQuery } from "../../src/engine/modules/credentials/provider-api";
import { safeFetch } from "../../src/engine/lib/safe-fetch";
vi.mock("../../src/engine/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
const access = { provider: "railway" as const, publicFields: {}, secrets: { apiToken: "test-token" } };
beforeEach(() => { vi.mocked(safeFetch).mockReset(); });
describe("Railway mutation outcome handling", () => {
  it("preserves an unknown outcome after a mutation network failure", async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error("socket interrupted"));
    await expect(railwayQuery(access, "mutation { serviceCreate { id } }")).rejects.toMatchObject({ code: "EXTERNAL_UNKNOWN_OUTCOME" });
  });
  it("keeps read failures as ordinary connectivity errors", async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error("socket interrupted"));
    await expect(railwayQuery(access, "query { projects { id } }")).rejects.toMatchObject({ code: "CONNECTION_UNAVAILABLE" });
  });
  it("preserves explicit permission failures instead of treating them as an uncertain mutation", async () => {
    vi.mocked(safeFetch).mockResolvedValue({ ok: false, status: 403 } as never);
    await expect(railwayQuery(access, "mutation { serviceCreate { id } }")).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
  });
});

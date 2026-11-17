import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_REPO, RELEASES_LATEST_API, SECURITY_FEED_API } from "@repo/core";

const state = vi.hoisted(() => ({
  feed: vi.fn(), claimFeed: vi.fn(), saveFeed: vi.fn(), verify: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { securityAdvisory: { feed: state.feed, claimFeed: state.claimFeed, saveFeed: state.saveFeed } } }));
vi.mock("../../config/env", () => ({ env: { CLOUD_MODE: false, DEPLOY_MODE: "selfhosted" } }));
vi.mock("../github/github.token", () => ({ tokenFor: vi.fn() }));
vi.mock("./security-signature", () => ({ verifySecurityManifest: state.verify }));
import { getAdvisoryFeed } from "./advisory-feed";

const cached = (body: unknown) => ({ body, revision: 0, etag: '"old"', failures: 0, checkedAt: new Date(), nextCheckAt: new Date(), error: null });
beforeEach(() => {
  vi.clearAllMocks();
  state.verify.mockReturnValue({ revision: 10, expiresAt: "2099-01-01T00:00:00Z", advisories: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe("fork release feed isolation", () => {
  it("does not return an existing upstream release from the legacy release cache", async () => {
    state.claimFeed.mockResolvedValue(undefined);
    state.feed.mockImplementation(async (id: string) => id === "release" ? cached({ latest: { version: "1.0.0", tag: "v1.0.0", notes: "Upstream release" }, manifest: null }) : id === "security:v2" ? cached({ signed: true }) : undefined);
    const result = await getAdvisoryFeed();
    expect(result.release).toEqual({ latest: null, manifest: null });
    expect(state.claimFeed).toHaveBeenCalledWith(`release:${GITHUB_REPO}`, expect.any(Date), expect.any(Date));
    expect(state.feed).not.toHaveBeenCalledWith("release");
    expect(state.verify).toHaveBeenCalled();
  });

  it("polls product releases from the fork while retaining the upstream signed security feed", async () => {
    state.claimFeed.mockResolvedValue(cached(null));
    state.feed.mockImplementation(async (id: string) => id === "security:v2" ? cached({ signed: true }) : undefined);
    const fetcher = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await getAdvisoryFeed();
    expect(RELEASES_LATEST_API).toBe("https://api.github.com/repos/Sidiora-Labs/workbox-cloud/releases/latest");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([RELEASES_LATEST_API, SECURITY_FEED_API]);
    expect(SECURITY_FEED_API).toContain("/oblien/openship/");
    expect(state.saveFeed.mock.calls.map(([id]) => id)).toEqual([`release:${GITHUB_REPO}`, "security:v2"]);
  });
});

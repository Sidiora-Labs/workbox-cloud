import { describe, it, expect } from "vitest";
import { resolveCatalog, type ResolvedAppTemplate } from "@repo/platform/engine/modules/apps/catalog-source";
import { getAppTemplate, type AppTemplate } from "@repo/core";

/** Minimal AppTemplate — resolveCatalog only reads id/minEngine/identity fields. */
const mk = (over: Partial<AppTemplate>): AppTemplate =>
  ({ id: "x", name: "X", description: "d", kind: "template", logo: "x", category: "other", ...over }) as AppTemplate;

describe("resolveCatalog — engine gate + bundled fallback", () => {
  it("passes through an entry this engine supports", () => {
    const e = resolveCatalog([mk({ id: "__ok", minEngine: "0.1.0", available: true })], [], "0.3.0").find(
      (x) => x.id === "__ok",
    );
    expect(e?.requiresUpdate).toBeUndefined();
    expect(e?.available).toBe(true);
  });

  it("surfaces a guided placeholder for a too-new, non-bundled app", () => {
    const e = resolveCatalog([mk({ id: "__toonew", minEngine: "999.0.0", available: true })], [], "0.3.0").find(
      (x) => x.id === "__toonew",
    );
    expect(e?.requiresUpdate?.minVersion).toBe("999.0.0");
    expect(e?.available).toBe(false);
    expect(e?.services).toBeUndefined(); // a lightweight stub, not the real template
  });

  it("falls back to the bundled copy when a too-new overlay overrides a bundled app", () => {
    // `mongodb` is bundled + engine-ok (no minEngine). A too-new overlay override
    // must NOT gate it — serve the bundled copy, flagged updateAvailable.
    const e = resolveCatalog([mk({ id: "mongodb", minEngine: "999.0.0" })], [], "0.3.0").find(
      (x) => x.id === "mongodb",
    );
    expect(e?.requiresUpdate).toBeUndefined();
    expect(e?.updateAvailable).toBe(true);
    expect((e?.services?.length ?? 0)).toBeGreaterThan(0); // the real bundled template
  });

  it("keeps complete recipe templates when a legacy overlay lacks their newer schema", () => {
    for (const id of ["n8n", "postgresql", "redis-server", "it-tools", "excalidraw", "vercel-nextjs", "vercel-blog", "vercel-portfolio"]) {
      const bundled = getAppTemplate(id)!;
      expect(bundled.deploymentRecipes?.length).toBeGreaterThan(0);
      const remote = { ...bundled, schemaVersion: undefined, deploymentRecipes: undefined, name: "Legacy template", services: [] };
      expect(resolveCatalog([remote], [], "99.0.0").find(entry => entry.id === id)).toEqual(bundled);
    }
  });

  it("allows intentional same-schema recipe updates and removals", () => {
    const bundled = getAppTemplate("vercel-nextjs")!;
    const updated = { ...bundled, deploymentRecipes: bundled.deploymentRecipes!.map(recipe => ({ ...recipe, source: { repo: "new-reviewed/project" } })) };
    expect(resolveCatalog([updated], [], "99.0.0").find(entry => entry.id === bundled.id)).toEqual(updated);
    const removed = { ...updated, deploymentRecipes: [] };
    expect(resolveCatalog([removed], [], "99.0.0").find(entry => entry.id === bundled.id)).toEqual(removed);
  });

  it("rejects a schema downgrade for a bundled native template", () => {
    const bundled = getAppTemplate("chromium")!;
    expect(bundled.schemaVersion).toBeGreaterThan(1);
    const stale = { ...bundled, schemaVersion: 1, name: "Old Chromium", services: [] };
    expect(resolveCatalog([stale], [], "99.0.0").find(entry => entry.id === bundled.id)).toEqual(bundled);
  });

  it("continues to accept same-schema native updates and remote additions", () => {
    const bundled = getAppTemplate("convex")!;
    const updated = { ...bundled, name: "Updated Convex", installLayout: undefined };
    const fresh = mk({ id: "__remote_native", schemaVersion: 3, available: true });
    const result = resolveCatalog([updated, fresh], [], "99.0.0");
    expect(result.find(entry => entry.id === bundled.id)).toEqual(updated);
    expect(result.find(entry => entry.id === fresh.id)).toEqual(fresh);
  });

  it("passes through schema-too-new identity placeholders for brand-new ids", () => {
    const ph = {
      ...mk({ id: "__shape" }),
      available: false,
      requiresUpdate: { minVersion: "2.0.0" },
    } as ResolvedAppTemplate;
    const e = resolveCatalog([], [ph], "0.3.0").find((x) => x.id === "__shape");
    expect(e?.requiresUpdate?.minVersion).toBe("2.0.0");
  });
});

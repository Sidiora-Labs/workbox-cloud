import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { appTemplateSchema } from "../src/apps/schema";
import type { AppTemplate } from "../src/app-templates";

const ids = ["chromium", "firefox", "webtop", "selenium-chromium"];
const templates = ids.map((id) => JSON.parse(readFileSync(new URL(`../src/apps/catalog/${id}.json`, import.meta.url), "utf8")) as AppTemplate);

describe("browser app deployment boundaries", () => {
  it.each(templates)("validates $id and keeps browser control behind a private authenticated gateway", (app) => {
    expect(appTemplateSchema.safeParse(app).success).toBe(true);
    expect(app.supportsCloud).toBe(false);
    expect(app.services!.filter((service: { exposed?: boolean }) => service.exposed)).toHaveLength(1);
    const gateway = app.services!.find((service: { exposed?: boolean }) => service.exposed);
    expect(gateway!.name).toMatch(/-access$/);
    expect(gateway!.secretEnv).toContain("OPENSHIP_ADMIN_PASSWORD");
    expect(app.configFields!.find((field: { key: string }) => field.key === "OPENSHIP_ADMIN_PASSWORD")).toMatchObject({ generate: "secret", secret: true });
    expect(app.endpoints).toEqual([expect.objectContaining({ service: gateway!.name, scope: "internal", defaultMode: "internal", allowedModes: ["internal", "domain"] })]);
    expect(app.files!.find((file: { path: string }) => file.path.endsWith("access.Caddyfile"))!.content).toContain("basic_auth {");
    for (const service of app.services!) {
      expect(service.image).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(service.volumes?.some((volume: string) => volume.includes("docker.sock") || volume.startsWith("/:"))).not.toBe(true);
      expect(service).not.toHaveProperty("privileged");
    }
  });

  it("keeps interactive profiles persistent and disables privileged desktop affordances", () => {
    for (const app of templates.filter((app) => app.id !== "selenium-chromium")) {
      const browser = app.services![0]!;
      expect(browser.shmSize).toBe(1024 ** 3);
      expect(browser.volumes).toEqual([`${app.id}_config:/config`]);
      expect(browser.environment).toMatchObject({ HARDEN_DESKTOP: "true", SELKIES_ENABLE_SHARING: "false|locked", SELKIES_ENABLE_SHARED: "false|locked" });
      expect(browser.ports).toBeUndefined();
    }
  });

  it("keeps Selenium sessions bounded without an unauthenticated remote desktop", () => {
    const selenium = templates.find((app) => app.id === "selenium-chromium")!.services![0]!;
    expect(selenium.shmSize).toBe(2 * 1024 ** 3);
    expect(selenium.environment).toMatchObject({ SE_NODE_MAX_SESSIONS: "1", SE_NODE_SESSION_TIMEOUT: "300", SE_START_VNC: "false", SE_START_NO_VNC: "false" });
    expect(selenium.ports).toBeUndefined();
    expect(selenium.volumes).toBeUndefined();
  });
});

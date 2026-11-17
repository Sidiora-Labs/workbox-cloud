// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { AppCatalog } from "./AppCatalog";

const h = vi.hoisted(() => ({ catalog: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/api", () => ({ appsApi: { catalog: h.catalog } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/i18n-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n-provider")>()),
  useI18n: () => ({ t: baseDictionary, locale: "en" }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }));
vi.mock("./AddCustomAppModal", () => ({ AddCustomAppModal: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.push.mockReset();
  h.catalog.mockResolvedValue({
    data: [
      {
        id: "n8n",
        name: "Automation app",
        category: "automation",
        kind: "template",
        description: "Workflow engine",
      },
      {
        id: "mail",
        name: "Mail setup",
        category: "mail",
        kind: "flow",
        flowHref: "/emails/setup",
        description: "Existing mail wizard",
      },
      { id: "future", name: "Future app", category: "other", kind: "template", comingSoon: true },
      {
        id: "newer",
        name: "Newer app",
        category: "other",
        kind: "template",
        requiresUpdate: { minVersion: "99.0.0" },
      },
    ],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(name))!;

it("opens customer-server apps through the shared install flow", async () => {
  h.catalog.mockResolvedValue({
    data: [
      {
        id: "ollama",
        name: "Ollama",
        kind: "template",
        category: "ai",
        description: "Models",
        gpu: "recommended",
        supportsCloud: false,
      },
    ],
  });
  await act(async () => root.render(<AppCatalog />));
  expect(button("Ollama").disabled).toBe(false);
  await act(async () => button("Ollama").click());
  expect(h.push).toHaveBeenCalledWith("/apps/new/ollama");
});

it("uses existing template and flow install routes without starting an installation", async () => {
  await act(async () => root.render(<AppCatalog />));
  await act(async () => button("Automation app").click());
  expect(h.push).toHaveBeenLastCalledWith("/apps/new/n8n");
  await act(async () => button("Mail setup").click());
  expect(h.push).toHaveBeenLastCalledWith("/emails/setup");
  expect(container.querySelector("input")?.placeholder).toBe(
    baseDictionary.dashboard.pages.apps.catalogSearchPlaceholder,
  );
  expect(button("Add custom")).toBeDefined();
});

it("retains coming-soon and minimum-version locks in the shared catalog", async () => {
  await act(async () => root.render(<AppCatalog />));
  for (const name of ["Future app", "Newer app"]) {
    expect(button(name).disabled).toBe(true);
    await act(async () => button(name).click());
  }
  expect(h.push).not.toHaveBeenCalled();
});

it("filters by provider and opens the selected deployment recipe", async () => {
  h.catalog.mockResolvedValue({
    data: [
      {
        id: "web-app",
        name: "Web starter",
        category: "development",
        kind: "template",
        description: "A site",
        nativeSupport: false,
        deploymentRecipes: [
          {
            id: "vercel-recipe",
            provider: "vercel",
            label: "Vercel project",
            workloadKind: "service",
          },
        ],
      },
      {
        id: "browser",
        name: "Browser",
        category: "browser",
        kind: "template",
        description: "Remote browser",
        deploymentRecipes: [
          {
            id: "railway-recipe",
            provider: "railway",
            label: "Railway service",
            workloadKind: "service",
          },
        ],
      },
    ],
  });
  await act(async () => root.render(<AppCatalog />));
  expect(button("Browsers")).toBeDefined();
  expect(button("Development")).toBeDefined();
  await act(async () => button("Vercel").click());
  expect(container.textContent).not.toContain("Remote browser");
  await act(async () => button("Web starter").click());
  expect(h.push).toHaveBeenCalledWith("/apps/new/web-app?recipe=vercel-recipe");
});

it("shows catalog load errors and retries without an empty success state", async () => {
  h.catalog.mockRejectedValueOnce(new Error("Catalog offline"));
  await act(async () => root.render(<AppCatalog />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Catalog offline");
  await act(async () => button("Retry").click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

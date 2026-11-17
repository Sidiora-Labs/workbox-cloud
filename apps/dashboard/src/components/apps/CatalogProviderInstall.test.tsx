// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CatalogProviderInstall } from "./CatalogProviderInstall";

const h = vi.hoisted(() => ({
  template: vi.fn(),
  list: vi.fn(),
  discover: vi.fn(),
  plan: vi.fn(),
  apply: vi.fn(),
  push: vi.fn(),
  scope: "one",
}));
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => h.scope }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock("@repo/ui/icons", () => ({ Icon: () => null }));
vi.mock("@/components/AppLogo", () => ({ AppLogo: () => null }));
vi.mock("@/components/ui/PageContainer", () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/CustomSelect", () => ({
  CustomSelect: ({ value, options, onChange, "aria-label": label, disabled }: any) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="" />
      {options.map((row: any) => (
        <option key={row.value} value={row.value}>
          {row.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/lib/api/apps", () => ({ appsApi: { template: h.template } }));
vi.mock("@/lib/api/credentials", () => ({ credentialsApi: { list: h.list } }));
vi.mock("@/lib/api/external-deployments", () => ({
  externalDeploymentsApi: { discover: h.discover, plan: h.plan, apply: h.apply },
}));
let root: Root;
let host: HTMLDivElement;
const app = {
  id: "demo",
  name: "Demo",
  description: "A native template",
  nativeSupport: false,
  deploymentRecipes: [
    {
      id: "vercel",
      provider: "vercel",
      workloadKind: "service",
      label: "Vercel app",
      source: { repo: "https://github.com/example/demo" },
      inputs: [
        {
          key: "apiKey",
          label: "API key",
          target: "environment",
          type: "password",
          required: true,
        },
      ],
    },
  ],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.scope = "one";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  h.template.mockResolvedValue({ data: app });
  h.list.mockResolvedValue({
    data: [
      {
        id: "a",
        provider: "vercel",
        name: "Team A",
        status: "active",
        publicFields: { teamId: "team-a" },
      },
      {
        id: "b",
        provider: "vercel",
        name: "Team B",
        status: "active",
        publicFields: { teamId: "team-b" },
      },
    ],
  });
  h.discover.mockResolvedValue({
    data: { projects: [{ id: "project", name: "Project", environments: [] }] },
  });
  h.plan.mockResolvedValue({
    data: {
      planId: "plan",
      accepted: true,
      blockers: [],
      warnings: [],
      expiresAt: "2099-01-01T00:00:00Z",
    },
  });
  h.apply.mockResolvedValue({ data: { targetId: "target" } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const click = async (name: string) => {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === name);
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
const select = async (label: string, value: string) => {
  const input = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const fill = async (label: string, value: string) => {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
it("uses an explicit connection and trusted catalog intent, then requires separate confirmation", async () => {
  await act(async () => root.render(<CatalogProviderInstall appId="demo" recipeId="vercel" />));
  expect(h.discover).not.toHaveBeenCalled();
  await select("Provider connection", "b");
  await select("Project", "project");
  await fill("API key", "private-key");
  await click("Review installation");
  expect(h.plan).toHaveBeenCalledWith(
    expect.objectContaining({
      target: {
        provider: "vercel",
        workloadKind: "service",
        connectionId: "b",
        providerIdentity: { teamId: "team-b" },
        resource: { name: "demo", projectId: "project" },
      },
      catalog: { templateId: "demo", recipeId: "vercel", config: { apiKey: "private-key" } },
    }),
  );
  expect(h.plan.mock.calls[0][0]).not.toHaveProperty("source");
  expect(h.plan.mock.calls[0][0]).not.toHaveProperty("image");
  expect(h.apply).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("private-key");
  await click("Install app");
  expect(h.apply).toHaveBeenCalledWith("plan", expect.stringMatching(/^catalog-apply:/));
  expect(h.push).toHaveBeenCalledWith("/apps#workload-target");
});
it("blocks missing required fields and never lets an unavailable recipe become a generic workload", async () => {
  await act(async () => root.render(<CatalogProviderInstall appId="demo" recipeId="vercel" />));
  await select("Provider connection", "a");
  await select("Project", "project");
  await click("Review installation");
  expect(host.textContent).toContain("Enter api key.");
  expect(h.plan).not.toHaveBeenCalled();
  await act(async () => root.render(<CatalogProviderInstall appId="demo" recipeId="unknown" />));
  expect(host.textContent).toContain("Installation unavailable");
  expect(
    [...host.querySelectorAll("button")].some((item) => item.textContent === "Review installation"),
  ).toBe(false);
});
it("invalidates reviewed plans when the account changes", async () => {
  await act(async () => root.render(<CatalogProviderInstall appId="demo" recipeId="vercel" />));
  await select("Provider connection", "a");
  await select("Project", "project");
  await fill("API key", "secret");
  await click("Review installation");
  await select("Provider connection", "b");
  expect(host.textContent).not.toContain("Ready for your review");
  expect(h.apply).not.toHaveBeenCalled();
});

it("does not navigate when an old workspace installation finishes after the workspace changed", async () => {
  let complete: ((value: unknown) => void) | undefined;
  h.apply.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => root.render(<CatalogProviderInstall appId="demo" recipeId="vercel" />));
  await select("Provider connection", "a");
  await select("Project", "project");
  await fill("API key", "secret");
  await click("Review installation");
  const button = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "Install app",
  )!;
  await act(async () => {
    button.click();
  });
  h.scope = "two";
  await act(async () => root.render(<CatalogProviderInstall appId="demo" recipeId="vercel" />));
  await act(async () => complete!({ data: { targetId: "old-workspace" } }));
  expect(h.push).not.toHaveBeenCalled();
});

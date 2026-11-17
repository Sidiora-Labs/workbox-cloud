// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { InstalledProviderApps } from "./InstalledProviderApps";
const h = vi.hoisted(() => ({
  operations: vi.fn(),
  credentials: vi.fn(),
  observe: vi.fn(),
  count: vi.fn(),
  scope: "one",
}));
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => h.scope }));
vi.mock("@/lib/api/external-deployments", () => ({
  externalDeploymentsApi: { operations: h.operations, observe: h.observe },
}));
vi.mock("@/lib/api/credentials", () => ({ credentialsApi: { list: h.credentials } }));
vi.mock("@/components/workloads/WorkloadsPage", () => ({
  ExternalWorkload: ({ operation }: any) => (
    <article>
      {operation.target.catalog.name} {operation.target.resource.name}
    </article>
  ),
}));
vi.mock("@repo/ui/icons", () => ({ Icon: () => null }));
let root: Root;
let host: HTMLDivElement;
const operation = (id: string, catalog?: object, extra = {}) => ({
  id,
  targetId: id,
  providerResourceId: id,
  kind: "apply",
  status: "ready",
  updatedAt: "2026-11-17T00:00:00Z",
  target: { provider: "railway", connectionId: "account", catalog, resource: { name: id } },
  ...extra,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.scope = "one";
  h.credentials.mockResolvedValue({ data: [] });
  h.operations.mockResolvedValue({ data: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("shows active catalog installations and excludes generic/deleted provider workloads", async () => {
  h.operations.mockResolvedValue({
    data: [
      operation("native-recipe", { name: "Catalog app", templateId: "demo" }),
      operation("generic"),
      operation(
        "deleted",
        { name: "Removed", templateId: "demo" },
        { kind: "destroy", status: "stopped" },
      ),
    ],
  });
  await act(async () => root.render(<InstalledProviderApps onCountChange={h.count} />));
  expect(host.textContent).toContain("Catalog app");
  expect(host.textContent).not.toContain("generic");
  expect(host.textContent).not.toContain("Removed");
  expect(h.count).toHaveBeenLastCalledWith(1);
});
it("keeps a failed provider listing visible and offers retry", async () => {
  h.operations.mockRejectedValueOnce(new Error("Provider list unavailable"));
  await act(async () => root.render(<InstalledProviderApps />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Provider list unavailable");
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click(),
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkloadsPage } from "./WorkloadsPage";
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => "scope-a" }));
const state = vi.hoisted(() => ({
  operations: vi.fn(),
  credentials: vi.fn(),
  observe: vi.fn(),
  destroy: vi.fn(),
  exec: vi.fn(),
  logs: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock("@repo/ui/icons", () => ({ Icon: () => <span /> }));
vi.mock("@/components/ui/PageContainer", () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/hooks/useDashboardHome", () => ({
  useDashboardHome: () => ({ projects: [], loading: false }),
}));
vi.mock("@/lib/api/credentials", () => ({ credentialsApi: { list: state.credentials } }));
vi.mock("@/lib/api/external-deployments", () => ({
  externalDeploymentsApi: {
    operations: state.operations,
    observe: state.observe,
    destroy: state.destroy,
    exec: state.exec,
    logs: state.logs,
  },
}));
let root: Root;
let host: HTMLDivElement;
const operation = {
  id: "op-one",
  targetId: "target-one",
  kind: "apply",
  status: "ready",
  workloadKind: "blaxel-sandbox",
  providerResourceId: "sandbox-one",
  updatedAt: "2026-01-01T00:00:00Z",
  target: {
    provider: "blaxel",
    connectionId: "connection-one",
    resource: { name: "sandbox-one", url: "https://example.com" },
    capability: { supported: ["exec", "destroy"] },
  },
};
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  state.credentials.mockResolvedValue({
    data: [{ id: "connection-one", name: "My Blaxel account" }],
  });
  state.operations.mockResolvedValue({ data: [operation] });
  state.observe.mockResolvedValue({ data: operation });
  state.destroy.mockResolvedValue({ data: { ...operation, kind: "destroy", status: "stopped" } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (row) => row.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("refresh observes provider resources and exposes the provider endpoint", async () => {
  await act(async () => root.render(<WorkloadsPage />));
  expect(host.textContent).toContain("My Blaxel account");
  expect(host.querySelector('a[href="https://example.com"]')?.textContent).toBe("Open workload");
  await click("Refresh");
  expect(state.observe).toHaveBeenCalledWith(operation);
});
it("requires the resource name before destruction", async () => {
  await act(async () => root.render(<WorkloadsPage />));
  await click("Delete");
  await click("Delete workload");
  expect(state.destroy).not.toHaveBeenCalled();
  const field = host.querySelector('input[aria-label="Confirm deletion of sandbox-one"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "sandbox-one",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Delete workload");
  expect(state.destroy).toHaveBeenCalledWith("op-one");
});
it("does not expose exec or delete when the capability is absent", async () => {
  state.operations.mockResolvedValue({
    data: [{ ...operation, target: { ...operation.target, capability: { supported: [] } } }],
  });
  await act(async () => root.render(<WorkloadsPage />));
  expect(host.textContent).not.toContain("Run command");
  expect([...host.querySelectorAll("button")].some((row) => row.textContent === "Delete")).toBe(
    false,
  );
});

it("loads bounded provider logs only on request and reports empty output", async () => {
  state.operations.mockResolvedValue({
    data: [{ ...operation, target: { ...operation.target, capability: { supported: ["logs"] } } }],
  });
  state.logs.mockResolvedValue({
    data: {
      entries: [
        {
          timestamp: "2026-01-01T00:00:00Z",
          stream: "stdout",
          message: "service started",
          cursor: "one",
        },
      ],
      truncated: true,
    },
  });
  await act(async () => root.render(<WorkloadsPage />));
  expect(state.logs).not.toHaveBeenCalled();
  await click("Logs");
  expect(state.logs).toHaveBeenCalledWith("op-one");
  expect(host.textContent).toContain("[stdout] service started");
  expect(host.textContent).toContain("bounded recent excerpt");
  state.logs.mockResolvedValue({ data: { entries: [], truncated: false } });
  await click("Refresh logs");
  expect(host.textContent).toContain("No logs returned yet.");
});

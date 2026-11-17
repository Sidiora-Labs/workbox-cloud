// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkboxHostInstall } from "./WorkboxHostInstall";

const state = vi.hoisted(() => ({
  scope: "owner-a",
  hostId: null as string | null,
  list: vi.fn(),
  get: vi.fn(),
  preflight: vi.fn(),
  install: vi.fn(),
  action: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace }),
  useSearchParams: () => new URLSearchParams(state.hostId ? { hostId: state.hostId } : {}),
}));
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => state.scope }));
vi.mock("@repo/ui/icons", () => ({ Icon: () => <span /> }));
vi.mock("@/components/ui/PageContainer", () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/shared/ServerSelector", () => ({
  default: ({ onSelect, onReadyChange, disabled }: any) => (
    <button
      disabled={disabled}
      onClick={() => {
        onSelect({ id: "server-a", name: "Development server" });
        onReadyChange(true);
      }}
    >
      Select server
    </button>
  ),
}));
vi.mock("@/components/ui/CustomSelect", () => ({
  CustomSelect: ({ value, onChange, options, "aria-label": label }: any) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option: any) => (
        <option value={option.value} key={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/lib/api/workbox-hosts", () => ({
  workboxHostsApi: {
    list: state.list,
    get: state.get,
    preflight: state.preflight,
    install: state.install,
    action: state.action,
  },
}));

const readyHost = {
  id: "host-a",
  serverId: "server-a",
  name: "Agent host",
  status: "ready",
  rootfs: "agents",
  version: "1.0.0",
  connectionId: "connection-a",
  progress: [{ id: "verify", label: "Verify connection", status: "completed" }],
  error: null,
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-17T00:00:00Z",
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.scope = "owner-a";
  state.hostId = null;
  state.list.mockResolvedValue({ data: [] });
  state.preflight.mockResolvedValue({
    data: {
      accepted: true,
      blockers: [],
      checks: [{ id: "os", label: "Linux host", ok: true, detail: "Supported" }],
    },
  });
  state.install.mockResolvedValue({
    data: { ...readyHost, status: "queued", connectionId: null, progress: [] },
  });
  state.get.mockResolvedValue({ data: readyHost });
  state.action.mockResolvedValue({ data: { ...readyHost, status: "queued", connectionId: null } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
async function render() {
  await act(async () => root.render(<WorkboxHostInstall />));
}
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("checks compatibility without installing and requires explicit consent before preparation", async () => {
  await render();
  await click("Select server");
  await click("Check compatibility");
  expect(state.preflight).toHaveBeenCalledWith("server-a");
  expect(state.install).not.toHaveBeenCalled();
  expect(button("Prepare Workbox host").disabled).toBe(true);
  await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await click("Prepare Workbox host");
  expect(state.install).toHaveBeenCalledTimes(1);
  expect(state.install).toHaveBeenCalledWith({
    serverId: "server-a",
    name: "Workbox host",
    rootfs: "agents",
  });
  expect(state.replace).toHaveBeenCalledWith("/workbox-hosts/new?hostId=host-a", { scroll: false });
  expect(host.textContent).toContain("queued");
});

it("keeps incompatible servers blocked and presents the actual compatibility error", async () => {
  state.preflight.mockResolvedValue({
    data: {
      accepted: false,
      checks: [
        { id: "cgroup", label: "Control groups", ok: false, detail: "cgroup v2 is unavailable" },
      ],
      blockers: ["Select a cgroup v2 Linux server."],
    },
  });
  await render();
  await click("Select server");
  await click("Check compatibility");
  expect(host.textContent).toContain("cgroup v2 is unavailable");
  expect(host.textContent).toContain("Select a cgroup v2 Linux server.");
  expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
  expect(state.install).not.toHaveBeenCalled();
});

it("discards a compatibility response after the workspace changes", async () => {
  let finish!: (value: any) => void;
  state.preflight.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click("Select server");
  await click("Check compatibility");
  state.scope = "owner-b";
  await render();
  await act(async () => finish({ data: { accepted: true, checks: [], blockers: [] } }));
  expect(host.textContent).not.toContain("Ready to prepare this server");
  expect(button("Prepare Workbox host").disabled).toBe(true);
});

it("resumes installation and polls until the verified sandbox action is available", async () => {
  vi.useFakeTimers();
  state.hostId = "host-a";
  state.get
    .mockResolvedValueOnce({
      data: {
        ...readyHost,
        status: "installing",
        connectionId: null,
        progress: [
          {
            id: "runtime",
            label: "Prepare runtime",
            status: "running",
            message: "Downloading runtime",
          },
        ],
      },
    })
    .mockResolvedValue({ data: readyHost });
  await render();
  expect(host.textContent).toContain("Downloading runtime");
  expect(host.querySelector('a[href*="connection-a"]')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(host.textContent).toContain("Host verified and connected");
  expect(
    host.querySelector('a[href="/workloads/new?provider=workbox&connectionId=connection-a"]'),
  ).not.toBeNull();
});

it("retries the saved failed installation instead of creating another host", async () => {
  state.hostId = "host-a";
  state.get.mockResolvedValue({
    data: { ...readyHost, status: "failed", error: "Runtime download failed", connectionId: null },
  });
  await render();
  await click("Retry installation");
  expect(state.action).toHaveBeenCalledWith("host-a", "retry");
  expect(state.install).not.toHaveBeenCalled();
});

it("requires the exact host name to remove the service and explains data retention", async () => {
  state.hostId = "host-a";
  await render();
  await click("Remove host");
  expect(host.textContent).toContain("Existing sandbox data remains on the server");
  expect(button("Confirm removal").disabled).toBe(true);
  const confirmation = host.querySelector(
    'input[aria-label="Confirm removal of Agent host"]',
  ) as HTMLInputElement;
  await input(confirmation, "Agent host");
  await click("Confirm removal");
  expect(state.action).toHaveBeenCalledWith("host-a", "remove");
});

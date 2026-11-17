// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkloadLaunch } from "./WorkloadLaunch";
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => state.scope }));
const state = vi.hoisted(() => ({
  scope: "scope-a",
  push: vi.fn(),
  preflight: vi.fn(),
  plan: vi.fn(),
  apply: vi.fn(),
  discover: vi.fn(),
  list: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@repo/ui/icons", () => ({ Icon: () => <span /> }));
vi.mock("@/components/ui/PageContainer", () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/shared/ServerSelector", () => ({ default: () => <div>Server picker</div> }));
vi.mock("@/components/shared/OptionCard", () => ({
  OptionCard: ({ onSelect, label, disabled, description }: any) => (
    <button onClick={onSelect} disabled={disabled}>
      {label} {description}
    </button>
  ),
}));
vi.mock("@/components/ui/CustomSelect", () => ({
  CustomSelect: ({ value, options, onChange, "aria-label": label }: any) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="" />
      {options.map((row: any) => (
        <option key={row.value} value={row.value}>
          {row.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/lib/api/credentials", () => ({ credentialsApi: { list: state.list } }));
vi.mock("@/lib/api/external-deployments", () => ({
  externalDeploymentsApi: {
    discover: state.discover,
    preflight: state.preflight,
    plan: state.plan,
    apply: state.apply,
  },
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.scope = "scope-a";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  state.list.mockResolvedValue({
    data: [
      {
        id: "connection-a",
        provider: "vercel",
        name: "Vercel account A",
        publicFields: { teamId: "team-a" },
        status: "active",
      },
      {
        id: "connection-b",
        provider: "vercel",
        name: "Vercel account B",
        publicFields: { teamId: "team-b" },
        status: "active",
      },
    ],
  });
  state.discover.mockResolvedValue({
    data: {
      projects: [{ id: "proj-a", name: "Project A", environments: [] }],
      apps: [],
      environments: [],
      images: [],
      warnings: [],
    },
  });
  const plan = {
    planId: "plan-a",
    accepted: true,
    blockers: [],
    warnings: [],
    expiresAt: "2099-01-01T00:00:00Z",
  };
  state.preflight.mockResolvedValue({ data: plan });
  state.plan.mockResolvedValue({ data: plan });
  state.apply.mockResolvedValue({ data: { id: "op-a" } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((row) =>
    row.textContent?.startsWith(text),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function select(label: string, value: string) {
  const element = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  expect(element).not.toBeNull();
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function input(label: string, value: string) {
  const element = [...host.querySelectorAll("label")]
    .find((row) => row.textContent?.startsWith(label))
    ?.querySelector("input")!;
  expect(element).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("requires an explicit account, reviews the plan, then applies only on the separate deploy action", async () => {
  await act(async () => root.render(<WorkloadLaunch />));
  await click("Vercel");
  expect(state.discover).not.toHaveBeenCalled();
  await select("Provider connection", "connection-b");
  await select("Project", "proj-a");
  await input("Workload name", "test-app");
  await click("Review deployment");
  expect(state.plan).toHaveBeenCalledWith(
    expect.objectContaining({
      target: expect.objectContaining({
        connectionId: "connection-b",
        providerIdentity: { teamId: "team-b" },
        resource: expect.objectContaining({ projectId: "proj-a", name: "test-app" }),
      }),
    }),
  );
  expect(state.apply).not.toHaveBeenCalled();
  await click("Deploy workload");
  expect(state.apply).toHaveBeenCalledWith("plan-a", expect.stringMatching(/^launch:/));
  expect(state.push).toHaveBeenCalledWith("/workloads");
});
it("shows a blocked preflight and never requests an applyable plan", async () => {
  state.preflight.mockResolvedValue({
    data: {
      planId: "blocked",
      accepted: false,
      blockers: ["Project access denied"],
      warnings: [],
      expiresAt: "2099-01-01T00:00:00Z",
    },
  });
  await act(async () => root.render(<WorkloadLaunch />));
  await click("Vercel");
  await select("Provider connection", "connection-a");
  await select("Project", "proj-a");
  await input("Workload name", "test-app");
  await click("Review deployment");
  expect(host.textContent).toContain("Project access denied");
  expect(state.plan).not.toHaveBeenCalled();
  expect(state.apply).not.toHaveBeenCalled();
});

it("discards a completed review after the workspace changes", async () => {
  let resolve: (value: any) => void = () => {};
  state.preflight.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<WorkloadLaunch />));
  await click("Vercel");
  await select("Provider connection", "connection-a");
  await select("Project", "proj-a");
  await input("Workload name", "test-app");
  await click("Review deployment");
  await act(async () => {
    state.scope = "scope-b";
    root.render(<WorkloadLaunch />);
  });
  await act(async () =>
    resolve({
      data: {
        planId: "stale",
        accepted: true,
        blockers: [],
        warnings: [],
        expiresAt: "2099-01-01T00:00:00Z",
      },
    }),
  );
  expect(state.plan).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Ready for your review");
});

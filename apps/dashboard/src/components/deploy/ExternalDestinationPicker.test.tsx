import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExternalDestinationPicker, type ExternalDestinationOption } from "./ExternalDestinationPicker";

const options: ExternalDestinationOption[] = [
  {
    id: "railway-sandbox-a",
    provider: "railway",
    workloadKind: "railway-sandbox",
    name: "Agent sandbox",
    scope: "Acme / Production",
  },
  {
    id: "vercel-service-a",
    provider: "vercel",
    workloadKind: "service",
    name: "Web service",
    scope: "Acme / team-web",
  },
  {
    id: "workbox-a",
    provider: "workbox",
    workloadKind: "workbox-sandbox",
    name: "Workbox sandbox",
    scope: "sandbox.example.com",
    disabledReason: "Host preflight is required",
  },
];

describe("ExternalDestinationPicker", () => {
  it("labels service containers and sandboxes as separate workload kinds", () => {
    const html = renderToStaticMarkup(
      <ExternalDestinationPicker options={options} onChange={vi.fn()} />,
    );
    expect(html).toContain("Railway Sandbox");
    expect(html).toContain("Service container");
    expect(html).toContain("Host preflight is required");
  });

  it("renders an empty state without inventing a provider target", () => {
    const html = renderToStaticMarkup(
      <ExternalDestinationPicker options={[]} onChange={vi.fn()} />,
    );
    expect(html).toContain("No external destinations are connected.");
    expect(html).not.toContain("Railway");
  });
});

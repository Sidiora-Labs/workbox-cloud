import { afterEach, describe, expect, it, vi } from "vitest";

// Match the production bundle's circular order: the agents singleton is created
// before the assistant runtime export receives its value.
const deferred = vi.hoisted(() => ({ runtime: undefined as any }));
vi.mock("../../../src/modules/assistant/assistant.service", () => ({
  get assistant() { return deferred.runtime; },
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("../../../src/modules/assistant/assistant-access", () => ({
  assistantCredential: vi.fn(async () => ({})),
  assistantError: (message: string) => new Error(message),
  digest: vi.fn(),
  isAssistantUserSession: vi.fn(),
  ownerKey: vi.fn(),
  withAssistantLock: vi.fn(),
}));
vi.mock("../../../src/modules/assistant/agent-access", () => ({
  ownedAgent: vi.fn(), validateAgentGrants: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/execution-authority", () => ({
  captureExecutionAuthority: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/assistant/native-agents", () => ({
  nativeAgents: vi.fn(),
}));

import { assistantAgents, createAssistantAgents } from "../../../src/modules/assistant/agents.service";

function runtime() {
  return { provider: vi.fn(async (_ctx, id) => ({
    id, name: id, available: true, authStatus: { configured: true },
    models: [{ id: "test-model", label: "Test", default: true }],
  })) };
}

afterEach(() => { deferred.runtime = undefined; });

describe("assistant agent runtime initialization", () => {
  it("uses the initialized runtime when the singleton was imported before it", async () => {
    deferred.runtime = runtime();
    const result = await assistantAgents.models({} as never);
    expect(deferred.runtime.provider).toHaveBeenCalledTimes(2);
    expect(result.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex", available: true, ready: true }),
      expect.objectContaining({ id: "claude", available: true, ready: true }),
    ]));
  });

  it("preserves an explicitly supplied runtime", async () => {
    const supplied = runtime();
    deferred.runtime = runtime();
    const agents = createAssistantAgents(supplied as never);
    await agents.models({} as never);
    expect(supplied.provider).toHaveBeenCalledTimes(2);
    expect(deferred.runtime.provider).not.toHaveBeenCalled();
  });
});

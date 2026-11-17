import { describe, expect, it, vi } from "vitest";
import { createAuthorization } from "../src/authorization";
import { createExternalDeploymentOperations } from "../src/external-deployments";
import { alice, authorizationFixture } from "./fixtures";

const target = {
  provider: "railway",
  workloadKind: "railway-sandbox",
  connectionId: "cred-test",
  providerIdentity: {},
  resource: {},
} as const;

// These probes persist targets or operations. A read-only native/SDK token must
// not invoke their services, even though they do not provision a provider resource.
describe("external deployment mutation authorization", () => {
  it.each([
    ["capabilities", target],
    ["preflight", target],
    ["plan", { target, idempotencyKey: "plan:test-0001" }],
    ["observe", { target }],
  ] as const)("denies a read-only credential before %s can persist state", async (name, input) => {
    const state = authorizationFixture();
    state.members.set("org-a:alice", { id: "member-a", role: "owner" });
    const auth = createAuthorization(state);
    const context = await auth.resolveScope({
      ...alice,
      credential: { organizationId: "org-a", readOnly: true },
    }, "org-a");
    const service = vi.fn();
    const ops = createExternalDeploymentOperations(auth, {
      collection: { [name]: service } as never,
    });
    await expect(ops[name](context, input as never)).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    expect(service).not.toHaveBeenCalled();
  });
});

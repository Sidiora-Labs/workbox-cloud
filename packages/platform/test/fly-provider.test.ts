import { describe, expect, it } from "vitest";
import {
  buildMachineCreatePayload,
  buildSpriteCreatePayload,
  FLY_MACHINE_CAPABILITIES,
  FLY_SPRITE_CAPABILITIES,
  machinePath,
  normalizeMachineStatus,
  normalizeSpriteStatus,
  spritePath,
} from "../src/engine/modules/external-deployments/providers/fly";

describe("Fly provider adapters", () => {
  it("keeps Machines and Sprites on distinct origins and paths", () => {
    expect(machinePath("my-app")).toBe("/v1/apps/my-app/machines");
    expect(machinePath("my-app", "machine-1", "stop")).toBe("/v1/apps/my-app/machines/machine-1/stop");
    expect(spritePath("agent-1", "exec")).toBe("/v1/sprites/agent-1/exec");
    expect(spritePath()).toBe("/v1/sprites");
    expect(() => machinePath("my/app")).toThrow(/Invalid Fly app/);
  });

  it("builds provider payloads without transport-only fields", () => {
    expect(buildMachineCreatePayload({ appName: "app", region: "ams", skipLaunch: true, config: { image: "app:v1" } })).toEqual({
      region: "ams",
      skip_launch: true,
      config: { image: "app:v1" },
    });
    expect(buildSpriteCreatePayload({ name: "sprite", organizationId: "org", idempotencyKey: "k", image: "ubuntu" })).toEqual({ name: "sprite" });
  });

  it("normalizes lifecycle states separately", () => {
    expect(normalizeMachineStatus("started")).toBe("running");
    expect(normalizeMachineStatus("stopped")).toBe("stopped");
    expect(normalizeMachineStatus("destroying")).toBe("deleting");
    expect(normalizeSpriteStatus("warm")).toBe("running");
    expect(normalizeSpriteStatus("cold")).toBe("stopped");
    expect(normalizeSpriteStatus("error")).toBe("failed");
    expect(normalizeMachineStatus("unseen")).toBe("unknown");
  });

  it("advertises distinct capabilities", () => {
    expect(FLY_MACHINE_CAPABILITIES.checkpoints).toBe(false);
    expect(FLY_MACHINE_CAPABILITIES.volumes).toBe(true);
    expect(FLY_SPRITE_CAPABILITIES.checkpoints).toBe(true);
    expect(FLY_SPRITE_CAPABILITIES.sleepWake).toBe(true);
  });
});

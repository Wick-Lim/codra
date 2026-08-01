import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  RemoteHostStateSchema,
  RemoteHostStatusSchema,
} from "../src/desktop-api";

describe("desktop remote IPC contract", () => {
  it("accepts the bounded remote host states and status payload", () => {
    expect(RemoteHostStateSchema.parse("idle")).toBe("idle");
    expect(RemoteHostStateSchema.parse("signing_in")).toBe("signing_in");
    expect(RemoteHostStateSchema.parse("online")).toBe("online");
    expect(RemoteHostStateSchema.parse("error")).toBe("error");
    expect(RemoteHostStatusSchema.parse({ state: "idle" })).toEqual({
      state: "idle",
    });
    expect(
      RemoteHostStatusSchema.parse({ state: "error", message: "LOGIN_FAILED" }),
    ).toEqual({ state: "error", message: "LOGIN_FAILED" });
    expect(() => RemoteHostStatusSchema.parse({ state: "error", secret: "no" })).toThrow();
  });

  it("freezes remote action and event channel names", () => {
    expect(IPC_CHANNELS.remoteGetState).toBe("codra:remote:get-state");
    expect(IPC_CHANNELS.remoteLogin).toBe("codra:remote:login");
    expect(IPC_CHANNELS.remoteState).toBe("codra:remote:state");
  });
});

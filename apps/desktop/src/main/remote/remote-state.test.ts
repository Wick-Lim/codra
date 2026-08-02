import { describe, expect, it } from "vitest";
import { remoteErrorStatus } from "./remote-state";

describe("remote host state", () => {
  it("exposes bounded error codes without leaking arbitrary error text", () => {
    expect(remoteErrorStatus(new Error("DESKTOP_LOGIN_TIMEOUT"))).toEqual({
      state: "error",
      message: "DESKTOP_LOGIN_TIMEOUT",
    });
    expect(remoteErrorStatus(new Error("private token abc"))).toEqual({
      state: "error",
      message: "REMOTE_ACTIVATION_FAILED",
    });
  });
});

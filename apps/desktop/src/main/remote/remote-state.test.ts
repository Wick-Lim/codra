import { describe, expect, it } from "vitest";
import {
  isRemoteStartRequested,
  remoteErrorStatus,
} from "./remote-state";

describe("remote host state", () => {
  it("allows an explicit login action without the legacy environment flag", () => {
    expect(isRemoteStartRequested({ force: true, envValue: undefined })).toBe(true);
    expect(isRemoteStartRequested({ force: true, envValue: "0" })).toBe(true);
    expect(isRemoteStartRequested({ force: false, envValue: "1" })).toBe(true);
    expect(isRemoteStartRequested({ force: false, envValue: undefined })).toBe(false);
  });

  it("exposes bounded error codes without leaking arbitrary error text", () => {
    expect(remoteErrorStatus(new Error("DESKTOP_LOGIN_TIMEOUT"))).toEqual({
      state: "error",
      message: "DESKTOP_LOGIN_TIMEOUT",
    });
    expect(remoteErrorStatus(new Error("private token abc"))).toEqual({
      state: "error",
      message: "REMOTE_LOGIN_FAILED",
    });
  });
});

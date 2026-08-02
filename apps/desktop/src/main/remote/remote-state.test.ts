import { describe, expect, it } from "vitest";
import { remoteErrorStatus, remoteSignedInStatus } from "./remote-state";

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

  it("publishes only the bounded Firebase profile needed by account UI", () => {
    expect(
      remoteSignedInStatus({
        displayName: "Jun Hyeog Im",
        email: "jun@example.com",
        photoURL: "https://lh3.googleusercontent.com/a/avatar",
      }),
    ).toEqual({
      state: "signed_in",
      profile: {
        displayName: "Jun Hyeog Im",
        email: "jun@example.com",
        photoUrl: "https://lh3.googleusercontent.com/a/avatar",
      },
    });

    expect(
      remoteSignedInStatus({
        displayName: null,
        email: null,
        photoURL: "https://example.com/untrusted-avatar.png",
      }),
    ).toEqual({
      state: "signed_in",
      profile: { displayName: null, email: null, photoUrl: null },
    });
  });
});

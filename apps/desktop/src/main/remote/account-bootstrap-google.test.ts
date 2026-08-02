import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapProductionDesktopAuth: vi.fn(),
  openDesktopAuthWindow: vi.fn(async () => undefined),
  shellOpenExternal: vi.fn(async () => undefined),
}));

vi.mock("./desktop-login", () => ({
  bootstrapProductionDesktopAuth: mocks.bootstrapProductionDesktopAuth,
  bootstrapProductionDesktopLogin: vi.fn(),
}));

vi.mock("./auth-window", () => ({
  openDesktopAuthWindow: mocks.openDesktopAuthWindow,
}));

vi.mock("electron", () => ({
  shell: { openExternal: mocks.shellOpenExternal },
}));

import { bootstrapRemoteAuth } from "./account-bootstrap-google";

describe("Google account bootstrap window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens OAuth in CODRA's modal child and forwards the loopback URL and deadline", async () => {
    const signal = new AbortController().signal;
    const controllerSignal = new AbortController().signal;
    const parentWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    const runtime = {
      deployment: {
        mode: "production",
        firebaseAuthHandlerUrl:
          "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
      },
    };
    mocks.bootstrapProductionDesktopAuth.mockImplementationOnce(
      async (_runtime, overrides) => {
        await overrides.openExternal(
          "https://accounts.google.com/o/oauth2/v2/auth",
          "http://127.0.0.1:45831/auth/callback",
          signal,
        );
      },
    );

    await bootstrapRemoteAuth(
      runtime as never,
      "google",
      controllerSignal,
      parentWindow,
    );

    expect(mocks.openDesktopAuthWindow).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth",
      "http://127.0.0.1:45831/auth/callback",
      {
        signal,
        parent: parentWindow,
        authHandlerUrl: "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
      },
    );
    expect(mocks.bootstrapProductionDesktopAuth).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ openExternal: expect.any(Function) }),
      controllerSignal,
    );
    expect(mocks.shellOpenExternal).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapProductionDesktopAuth: vi.fn(),
  bootstrapProductionDesktopLogin: vi.fn(),
  openDesktopAuthWindow: vi.fn(async () => undefined),
  shellOpenExternal: vi.fn(async () => undefined),
  appFocus: vi.fn(),
}));

vi.mock("./desktop-login", () => ({
  bootstrapProductionDesktopAuth: mocks.bootstrapProductionDesktopAuth,
  bootstrapProductionDesktopLogin: mocks.bootstrapProductionDesktopLogin,
}));

vi.mock("./auth-window", () => ({
  openDesktopAuthWindow: mocks.openDesktopAuthWindow,
}));

vi.mock("electron", () => ({
  shell: { openExternal: mocks.shellOpenExternal },
  app: { focus: mocks.appFocus },
}));

import {
  bootstrapRemoteAccount,
  bootstrapRemoteAuth,
} from "./account-bootstrap-google";

describe("Google account bootstrap window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens Google OAuth in the system browser and restores CODRA focus", async () => {
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

    expect(mocks.shellOpenExternal).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(mocks.bootstrapProductionDesktopAuth).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ openExternal: expect.any(Function) }),
      controllerSignal,
    );
    expect(mocks.openDesktopAuthWindow).not.toHaveBeenCalled();
    expect(parentWindow.focus).toHaveBeenCalledOnce();
  });

  it("keeps device bootstrap OAuth in the system browser", async () => {
    const signal = new AbortController().signal;
    const runtime = { deployment: { mode: "production" } };
    const result = { token: "device-token" };
    mocks.bootstrapProductionDesktopLogin.mockImplementationOnce(
      async (_runtime, _options, overrides) => {
        await overrides.openExternal(
          "https://accounts.google.com/o/oauth2/v2/auth",
          "http://127.0.0.1:45831/auth/callback",
          signal,
        );
        return result;
      },
    );

    await expect(
      bootstrapRemoteAccount(runtime as never, {} as never),
    ).resolves.toBe(result);
    expect(mocks.shellOpenExternal).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(mocks.openDesktopAuthWindow).not.toHaveBeenCalled();
  });

  it("restores CODRA focus when browser sign-in is cancelled", async () => {
    const parentWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    mocks.bootstrapProductionDesktopAuth.mockRejectedValueOnce(
      new Error("DESKTOP_LOGIN_CANCELLED"),
    );

    await expect(
      bootstrapRemoteAuth(
        { deployment: { mode: "production" } } as never,
        "google",
        undefined,
        parentWindow,
      ),
    ).rejects.toThrow("DESKTOP_LOGIN_CANCELLED");
    expect(parentWindow.focus).toHaveBeenCalledOnce();
  });

  it("raises the application, not only the window, after sign-in", async () => {
    const parentWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      isVisible: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    await bootstrapRemoteAuth(
      { deployment: { mode: "production" } } as never,
      "google",
      undefined,
      parentWindow,
    );

    expect(parentWindow.restore).toHaveBeenCalledOnce();
    expect(parentWindow.show).toHaveBeenCalledOnce();
    expect(parentWindow.focus).toHaveBeenCalledOnce();
    expect(mocks.appFocus).toHaveBeenCalledWith({ steal: true });
  });

  it("restores CODRA focus after device registration", async () => {
    const parentWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    mocks.bootstrapProductionDesktopLogin.mockResolvedValueOnce({
      token: "device-token",
    });

    await bootstrapRemoteAccount(
      { deployment: { mode: "production" } } as never,
      {} as never,
      parentWindow,
    );

    expect(parentWindow.focus).toHaveBeenCalledOnce();
    expect(mocks.appFocus).toHaveBeenCalledWith({ steal: true });
  });
});

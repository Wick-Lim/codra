import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapRemoteAuth: vi.fn(),
  createRemoteFirebaseRuntime: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signOut: vi.fn(async () => undefined),
}));

vi.mock("@codra/remote-account-bootstrap", () => ({
  bootstrapRemoteAccount: vi.fn(),
  bootstrapRemoteAuth: mocks.bootstrapRemoteAuth,
}));

vi.mock("@codra/remote-firebase-config", () => ({
  createRemoteFirebaseRuntime: mocks.createRemoteFirebaseRuntime,
}));

vi.mock("firebase/auth", () => ({
  signInWithCustomToken: mocks.signInWithCustomToken,
  signOut: mocks.signOut,
}));

import { RemoteHostController } from "./host-controller";

function parentWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe("RemoteHostController account lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps logout authoritative when an in-flight login finishes late", async () => {
    const auth = {
      currentUser: null as null | {
        displayName: string;
        email: string;
        photoURL: null;
      },
    };
    const runtime = { auth };
    let finishAuth: (() => void) | undefined;
    let loginSignal: AbortSignal | undefined;
    mocks.createRemoteFirebaseRuntime.mockReturnValue(runtime);
    mocks.bootstrapRemoteAuth.mockImplementation(
      async (_runtime, _provider, signal?: AbortSignal) => {
        loginSignal = signal;
        await new Promise<void>((resolve) => {
          finishAuth = resolve;
        });
        auth.currentUser = {
          displayName: "CODRA Operator",
          email: "operator@example.com",
          photoURL: null,
        };
      },
    );
    const controller = new RemoteHostController({
      userDataPath: "/tmp/codra-host-controller-test",
      reportError: vi.fn(),
    });

    const login = controller.login("google", parentWindow());
    await vi.waitFor(() => expect(finishAuth).toBeTypeOf("function"));
    await expect(controller.logout()).resolves.toEqual({
      state: "signed_out",
    });
    expect(loginSignal?.aborted).toBe(true);
    finishAuth?.();

    await expect(login).rejects.toThrow("REMOTE_LOGIN_CANCELLED");
    expect(controller.getAccountStatus()).toEqual({ state: "signed_out" });
  });

  it("carries the invoking CODRA window into the OAuth bootstrap", async () => {
    const auth = {
      currentUser: null as null | {
        displayName: string;
        email: string;
        photoURL: null;
      },
    };
    const runtime = { auth };
    const loginParent = parentWindow();
    mocks.createRemoteFirebaseRuntime.mockReturnValue(runtime);
    mocks.bootstrapRemoteAuth.mockImplementation(async () => {
      auth.currentUser = {
        displayName: "CODRA Operator",
        email: "operator@example.com",
        photoURL: null,
      };
    });
    const controller = new RemoteHostController({
      userDataPath: "/tmp/codra-host-controller-test",
      reportError: vi.fn(),
    });

    await controller.login("google", loginParent);

    expect(mocks.bootstrapRemoteAuth).toHaveBeenCalledWith(
      runtime,
      "google",
      expect.any(AbortSignal),
      loginParent,
    );
  });
});

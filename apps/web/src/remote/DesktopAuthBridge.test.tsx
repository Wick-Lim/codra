// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPkceVerifier } from "@codra/protocol";
import DesktopAuthBridgeGoogle from "./DesktopAuthBridgeGoogle";
import {
  createDesktopCallbackNavigation,
  parseDesktopAuthQuery,
} from "./desktop-auth-contract";

const authMocks = vi.hoisted(() => ({
  getRedirectResult: vi.fn(),
  signInWithRedirect: vi.fn(),
  signOut: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class GoogleAuthProvider {},
  getRedirectResult: authMocks.getRedirectResult,
  signInWithRedirect: authMocks.signInWithRedirect,
  signOut: authMocks.signOut,
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: () => authMocks.authorize,
}));

vi.mock("./firebase-bridge", () => ({
  bridgeAuth: {},
  bridgeFunctions: {},
}));

const attempt = "f013c9d1-2f7e-4a52-8b0b-8f1d17d4d7f1";
const state = createPkceVerifier(new Uint8Array(32).fill(1));
const code = createPkceVerifier(new Uint8Array(32).fill(2));
const redirectCredential = {
  user: { providerData: [{ providerId: "google.com" }] },
};

beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    `/desktop-auth?attempt=${attempt}&state=${state}`,
  );
  sessionStorage.clear();
  authMocks.getRedirectResult.mockReset();
  authMocks.signInWithRedirect.mockReset().mockResolvedValue(undefined);
  authMocks.signOut.mockReset().mockResolvedValue(undefined);
  authMocks.authorize.mockReset();
});

describe("DesktopAuthBridge", () => {
  it("requires exactly one attempt and state query parameter", () => {
    expect(parseDesktopAuthQuery(`?attempt=${attempt}&state=${state}`)).toEqual(
      {
        attempt,
        state,
      },
    );
    expect(parseDesktopAuthQuery("")).toBeUndefined();
    expect(
      parseDesktopAuthQuery(`?attempt=${attempt}&state=${state}&extra=1`),
    ).toBeUndefined();
    expect(
      parseDesktopAuthQuery(
        `?attempt=${attempt}&attempt=${attempt}&state=${state}`,
      ),
    ).toBeUndefined();
  });

  it("creates one exact loopback callback navigation", () => {
    expect(
      createDesktopCallbackNavigation("http://127.0.0.1:43123/auth/callback", {
        attempt,
        code,
        state,
      }),
    ).toBe(
      `http://127.0.0.1:43123/auth/callback?attempt=${attempt}&code=${code}&state=${state}`,
    );
    expect(() =>
      createDesktopCallbackNavigation("https://127.0.0.1:43123/auth/callback", {
        attempt,
        code,
        state,
      }),
    ).toThrow("DESKTOP_AUTH_CALLBACK_INVALID");
    expect(() =>
      createDesktopCallbackNavigation(
        "http://user:pass@127.0.0.1:43123/auth/callback",
        { attempt, code, state },
      ),
    ).toThrow("DESKTOP_AUTH_CALLBACK_INVALID");
  });

  it("signs in, inspects, requires Allow, signs out, and navigates once", async () => {
    authMocks.getRedirectResult
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(redirectCredential);
    authMocks.authorize
      .mockResolvedValueOnce({
        data: {
          attemptId: attempt,
          action: "register",
          displayName: "CODRA host",
          fingerprintSuffix: "a1b2c3d4",
        },
      })
      .mockResolvedValueOnce({
        data: {
          attemptId: attempt,
          callbackUrl: "http://127.0.0.1:43123/auth/callback",
          state,
          code,
        },
      });
    const replace = vi.fn();

    const first = render(<DesktopAuthBridgeGoogle onNavigate={replace} />);
    await waitFor(() =>
      expect(authMocks.signInWithRedirect).toHaveBeenCalledTimes(1),
    );
    expect(authMocks.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("codra.desktop-auth.redirect.v1")).toContain(
      attempt,
    );
    first.unmount();

    render(<DesktopAuthBridgeGoogle onNavigate={replace} />);
    // Selected by test id, not by accessible name: the button's label is
    // translated copy that `src/i18n/messages.ts` owns.
    await screen.findByTestId("desktop-auth-allow");
    expect(authMocks.authorize).toHaveBeenNthCalledWith(1, {
      action: "inspect",
      attemptId: attempt,
      state,
    });
    await userEvent.click(screen.getByTestId("desktop-auth-allow"));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith(
      `http://127.0.0.1:43123/auth/callback?attempt=${attempt}&code=${code}&state=${state}`,
    );
    expect(authMocks.authorize).toHaveBeenNthCalledWith(2, {
      action: "allow",
      attemptId: attempt,
      state,
    });
    expect(authMocks.signOut).toHaveBeenCalledTimes(1);
  });
});

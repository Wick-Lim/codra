import { describe, expect, it } from "vitest";
import { createPkceVerifier } from "@codra/protocol";
import {
  createDesktopCallbackNavigation,
  parseDesktopAuthQuery,
} from "./desktop-auth-contract";

const attempt = "f013c9d1-2f7e-4a52-8b0b-8f1d17d4d7f1";
const state = createPkceVerifier(new Uint8Array(32).fill(1));
const code = createPkceVerifier(new Uint8Array(32).fill(2));

describe("DesktopAuthBridge", () => {
  it("requires exactly one attempt and state query parameter", () => {
    expect(parseDesktopAuthQuery(`?attempt=${attempt}&state=${state}`)).toEqual({
      attempt,
      state,
    });
    expect(parseDesktopAuthQuery("")).toBeUndefined();
    expect(parseDesktopAuthQuery(`?attempt=${attempt}&state=${state}&extra=1`)).toBeUndefined();
    expect(parseDesktopAuthQuery(`?attempt=${attempt}&attempt=${attempt}&state=${state}`)).toBeUndefined();
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
  });
});

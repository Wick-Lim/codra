import { describe, expect, it } from "vitest";
import {
  DESKTOP_LOGIN_PUBLIC_EXPORTS,
  authorizeDesktopLogin,
  desktopLoginCancel,
  desktopLoginRedeem,
  desktopLoginStart,
  validateRawDesktopLoginRequest,
} from "../src/desktop-login";
import * as publicFunctions from "../src/index";
import { FUNCTION_REGION } from "@codra/protocol";

describe("desktop login Function boundary", () => {
  it("rejects a raw request unless it is a same-origin-free JSON POST", () => {
    expect(
      validateRawDesktopLoginRequest({
        method: "GET",
        headers: { "content-type": "application/json" },
        rawBody: Buffer.from("{}"),
      }),
    ).toBe("METHOD_NOT_ALLOWED");
    expect(
      validateRawDesktopLoginRequest({
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://codra-1b3bb.web.app",
        },
        rawBody: Buffer.from("{}"),
      }),
    ).toBe("ORIGIN_NOT_ALLOWED");
    expect(
      validateRawDesktopLoginRequest({
        method: "POST",
        headers: { "content-type": "text/plain" },
        rawBody: Buffer.from("{}"),
      }),
    ).toBe("CONTENT_TYPE_REQUIRED");
  });

  it("rejects a request body larger than 32 KiB before parsing it", () => {
    expect(
      validateRawDesktopLoginRequest({
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        rawBody: Buffer.alloc(32 * 1024 + 1),
      }),
    ).toBe("REQUEST_TOO_LARGE");
  });

  it("freezes the four desktop login public exports", () => {
    expect(DESKTOP_LOGIN_PUBLIC_EXPORTS).toEqual([
      "desktopLoginStart",
      "authorizeDesktopLogin",
      "desktopLoginRedeem",
      "desktopLoginCancel",
    ]);
    expect(Object.keys(publicFunctions)).toEqual(
      expect.arrayContaining(DESKTOP_LOGIN_PUBLIC_EXPORTS),
    );
  });

  it("uses the configured regional endpoint metadata without callable App Check options on raw handlers", () => {
    for (const handler of [
      desktopLoginStart,
      desktopLoginRedeem,
      desktopLoginCancel,
    ]) {
      expect(handler.__endpoint.region).toEqual([FUNCTION_REGION]);
      expect(handler.__endpoint.callableTrigger).toBeUndefined();
    }
    expect(authorizeDesktopLogin.__endpoint.region).toEqual([FUNCTION_REGION]);
  });
});

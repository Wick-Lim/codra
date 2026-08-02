import { generateKeyPairSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { FirebaseRuntime } from "@codra/firebase";
import {
  createPkceChallenge,
  createPkceVerifier,
  createRfc7638Thumbprint,
  type PublicEcJwk,
} from "@codra/protocol";
import {
  bootstrapProductionDesktopLogin,
  createDesktopLoginCallbackListener,
  createDesktopLoginDeviceSignaturePayload,
  createDesktopLoginGoogleAuthExchangeRequest,
  createDesktopLoginGoogleAuthUriRequest,
  DESKTOP_LOGIN_CALLBACK_PORT,
  desktopLoginFunctionUrl,
  parseDesktopLoginCallback,
} from "./desktop-login";
import type { HostIdentity } from "./host-identity";

const attemptId = "d9c3a142-3f0e-4ab2-867d-8112f0e5c162";
const state = createPkceVerifier(new Uint8Array(32).fill(1));
const code = createPkceVerifier(new Uint8Array(32).fill(2));

function callbackTarget(port: number, query = ""): string {
  return `http://127.0.0.1:${port}/auth/callback${query}`;
}

function request(url: string, method = "GET", host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const call = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: host ? { Host: host } : undefined,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    call.once("error", reject);
    call.end();
  });
}

function hostIdentity(): HostIdentity {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyJwk = pair.publicKey.export({ format: "jwk" }) as PublicEcJwk;
  return {
    deviceId: attemptId,
    publicKeyJwk,
    privateKey: pair.privateKey.export({ format: "jwk" }),
    keyThumbprint: createRfc7638Thumbprint(publicKeyJwk),
    created: true,
  };
}

function productionRuntime(): FirebaseRuntime {
  return {
    deployment: {
      mode: "production",
      projectId: "codra-1b3bb",
      publicConfig: {
        apiKey: "key",
        authDomain: "codra-1b3bb.firebaseapp.com",
        projectId: "codra-1b3bb",
        storageBucket: "codra-1b3bb.firebasestorage.app",
        messagingSenderId: "92715578857",
        appId: "1:92715578857:web:6c07f26a4866a1d4d3c778",
        measurementId: "G-YVR71LBSVB",
      },
      bridgeFirebaseAppId: "1:92715578857:web:6c07f26a4866a1d4d3c778",
      desktopAppCheckFirebaseAppId: "1:92715578857:web:f955949d45ca300ed3c778",
      accountBootstrapProvider: "google.com",
      browserOrigins: [
        "https://codra-1b3bb.web.app",
        "https://codra-1b3bb.firebaseapp.com",
      ],
      desktopAuthBridgeUrl: "https://codra-1b3bb.firebaseapp.com/desktop-auth",
      firebaseAuthHandlerUrl:
        "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
      authAppCheckEnforcement: false,
      functionsRegion: "asia-northeast3",
    },
  } as FirebaseRuntime;
}

describe("desktop login loopback", () => {
  it("creates exact 43-character PKCE verifier and challenge values", () => {
    const verifier = createPkceVerifier(new Uint8Array(32).fill(7));

    expect(verifier).toHaveLength(43);
    expect(createPkceChallenge(verifier)).toHaveLength(43);
  });

  it("creates a direct Firebase Google auth URI request for the loopback callback", () => {
    expect(
      createDesktopLoginGoogleAuthUriRequest(
        productionRuntime(),
        "http://127.0.0.1:43123/auth/callback",
        state,
      ),
    ).toEqual({
      url: "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=key",
      body: {
        providerId: "google.com",
        continueUri: "http://127.0.0.1:43123/auth/callback",
        authFlowType: "CODE_FLOW",
        sessionId: state,
        context: state,
      },
    });
  });

  it("builds a redeem signature payload without transport-only fields", () => {
    const nonce = createPkceVerifier(new Uint8Array(32).fill(3));
    expect(
      createDesktopLoginDeviceSignaturePayload({
        attemptId,
        code,
        state,
        nonce,
        deviceId: attemptId,
        keyThumbprint: state,
      }),
    ).toEqual({
      domain: "codra.desktop-login.redeem.v1",
      attemptId,
      code,
      state,
      nonce,
      deviceId: attemptId,
      keyThumbprint: state,
    });
  });

  it("exchanges the Google callback as the Identity Toolkit POST body", () => {
    expect(
      createDesktopLoginGoogleAuthExchangeRequest(
        "http://127.0.0.1:45831/auth/callback",
        state,
        code,
        "opaque-google-state",
      ),
    ).toEqual({
      requestUri: "http://127.0.0.1:45831/auth/callback",
      postBody:
        "code=" + encodeURIComponent(code) + "&state=opaque-google-state",
      sessionId: state,
      returnSecureToken: true,
      returnIdpCredential: true,
    });
  });

  it("preserves the complete Google callback body for Identity Toolkit", () => {
    expect(
      createDesktopLoginGoogleAuthExchangeRequest(
        "http://127.0.0.1:45831/auth/callback",
        state,
        code,
        "opaque-google-state",
        "code=google-code&state=opaque-google-state&iss=https%3A%2F%2Faccounts.google.com",
      ),
    ).toMatchObject({
      postBody:
        "code=google-code&state=opaque-google-state&iss=https%3A%2F%2Faccounts.google.com",
    });
  });

  it("constructs fixed production and deployment-derived emulator Function URLs", () => {
    expect(
      desktopLoginFunctionUrl(productionRuntime(), "desktopLoginStart"),
    ).toBe(
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginStart",
    );
    expect(
      desktopLoginFunctionUrl(
        {
          deployment: {
            mode: "emulator",
            projectId: "demo-codra",
            functionsRegion: "asia-northeast3",
            functionsOrigin: "http://127.0.0.1:5001",
          },
        } as FirebaseRuntime,
        "desktopLoginRedeem",
      ),
    ).toBe(
      "http://127.0.0.1:5001/demo-codra/asia-northeast3/desktopLoginRedeem",
    );
  });

  it("accepts Google OAuth callback metadata while requiring code and state", () => {
    const expected = { port: 43123, attemptId, state };
    const valid = {
      method: "GET",
      headers: { host: "127.0.0.1:43123" },
      url: `/auth/callback?code=${code}&state=${state}&iss=https%3A%2F%2Faccounts.google.com&scope=openid%20email&authuser=0&prompt=consent`,
    };

    expect(parseDesktopLoginCallback(valid, expected)).toEqual({
      attemptId,
      code,
      state,
      postBody: valid.url.slice(valid.url.indexOf("?") + 1),
    });
    expect(
      parseDesktopLoginCallback(
        { ...valid, headers: { host: "localhost:43123" } },
        expected,
      ),
    ).toBeUndefined();
    expect(
      parseDesktopLoginCallback({ ...valid, method: "POST" }, expected),
    ).toBeUndefined();
    expect(
      parseDesktopLoginCallback(
        { ...valid, url: valid.url.replace("callback", "other") },
        expected,
      ),
    ).toBeUndefined();
    expect(
      parseDesktopLoginCallback(
        { ...valid, url: `${valid.url}&extra=1` },
        expected,
      ),
    ).toBeUndefined();
    expect(
      parseDesktopLoginCallback(
        {
          ...valid,
          url: `/auth/callback?code=${code}&code=${code}&state=${state}`,
        },
        expected,
      ),
    ).toBeUndefined();
    expect(
      parseDesktopLoginCallback(
        {
          ...valid,
          url: `/auth/callback?code=${code}&state=${"x".repeat(4_097)}`,
        },
        expected,
      ),
    ).toBeUndefined();
    expect(
      parseDesktopLoginCallback(
        { ...valid, url: `/auth/callback?code=${code}&state=` },
        expected,
      ),
    ).toBeUndefined();
  });

  it("binds the stable loopback callback to the pending attempt without a redirect query", () => {
    expect(
      parseDesktopLoginCallback(
        {
          method: "GET",
          headers: { host: "127.0.0.1:45831" },
          url: `/auth/callback?code=${code}&state=${state}`,
        },
        { port: 45831, attemptId, state },
      ),
    ).toEqual({
      attemptId,
      code,
      state,
      postBody: `code=${code}&state=${state}`,
    });
  });

  it("keeps invalid traffic from consuming the attempt and accepts the first valid callback", async () => {
    const listener = await createDesktopLoginCallbackListener({
      attemptId,
      state,
      port: 0,
    });
    const invalid = await request(
      callbackTarget(listener.port, `?code=${code}&state=${state}&extra=1`),
    );
    expect(invalid).toBe(400);

    const valid = request(
      callbackTarget(listener.port, `?code=${code}&state=${state}`),
    );
    await expect(listener.waitForCallback()).resolves.toEqual({
      attemptId,
      code,
      state,
      postBody: `code=${code}&state=${state}`,
    });
    expect(await valid).toBe(200);
    await listener.close();
  });

  it("uses the registered production loopback port by default", async () => {
    const listener = await createDesktopLoginCallbackListener({
      attemptId,
      state,
    });
    expect(listener.port).toBe(DESKTOP_LOGIN_CALLBACK_PORT);
    await listener.close();
  });

  it("times out, closes its listener, and signed-cancels a started attempt", async () => {
    const runtime = productionRuntime();
    const calls: Array<{ url: string; body: unknown }> = [];
    const identity = hostIdentity();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith("desktopLoginStart"))
        return new Response(JSON.stringify({ serverNonce: body.nonce }), {
          status: 200,
        });
      if (url.includes("/v1/accounts:createAuthUri"))
        return new Response(
          JSON.stringify({
            authUri: "https://accounts.google.com/o/oauth2/auth",
            sessionId: body.sessionId,
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
    });

    await expect(
      bootstrapProductionDesktopLogin(
        runtime,
        { identity, action: "register" },
        {
          fetch,
          openExternal: async () => undefined,
          timeoutMs: 25,
        },
      ),
    ).rejects.toThrow("DESKTOP_LOGIN_TIMEOUT");
    expect(calls.map((call) => call.url)).toEqual([
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginStart",
      "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=key",
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginCancel",
    ]);
  });

  it("cancels when a start response is malformed after a transaction may exist", async () => {
    const runtime = productionRuntime();
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("desktopLoginStart"))
        return new Response(JSON.stringify({ serverNonce: "wrong" }), {
          status: 200,
        });
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
    });

    await expect(
      bootstrapProductionDesktopLogin(
        runtime,
        { identity: hostIdentity(), action: "register" },
        {
          fetch,
          openExternal: async () => undefined,
          timeoutMs: 500,
        },
      ),
    ).rejects.toThrow("DESKTOP_LOGIN_START_INVALID");
    expect(calls).toEqual([
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginStart",
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginCancel",
    ]);
  });

  it("bounds a hanging system-browser launch and cancels the attempt", async () => {
    const runtime = productionRuntime();
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith("desktopLoginStart")) {
        const body = JSON.parse(String(init.body)) as { nonce: string };
        return new Response(JSON.stringify({ serverNonce: body.nonce }), {
          status: 200,
        });
      }
      if (url.includes("/v1/accounts:createAuthUri")) {
        const body = JSON.parse(String(init.body)) as { sessionId: string };
        return new Response(
          JSON.stringify({
            authUri: "https://accounts.google.com/o/oauth2/auth",
            sessionId: body.sessionId,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
    });

    await expect(
      bootstrapProductionDesktopLogin(
        runtime,
        { identity: hostIdentity(), action: "register" },
        {
          fetch,
          openExternal: () => new Promise<void>(() => undefined),
          timeoutMs: 25,
        },
      ),
    ).rejects.toThrow("DESKTOP_LOGIN_TIMEOUT");
    expect(calls).toEqual([
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginStart",
      "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=key",
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginCancel",
    ]);
  });

  it("bounds a hanging start request and still cancels the attempt", async () => {
    const runtime = productionRuntime();
    const calls: string[] = [];
    const fetch = vi.fn((url: string) => {
      calls.push(url);
      if (url.endsWith("desktopLoginStart"))
        return new Promise<Response>(() => undefined);
      return Promise.resolve(
        new Response(JSON.stringify({ cancelled: true }), { status: 200 }),
      );
    });

    await expect(
      bootstrapProductionDesktopLogin(
        runtime,
        { identity: hostIdentity(), action: "register" },
        {
          fetch,
          openExternal: async () => undefined,
          timeoutMs: 25,
        },
      ),
    ).rejects.toThrow("DESKTOP_LOGIN_TIMEOUT");
    expect(calls).toEqual([
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginStart",
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net/desktopLoginCancel",
    ]);
  });

  it("has no embedded browser or Firebase web redirect implementation", async () => {
    const source = await readFile(
      new URL("./desktop-login.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /BrowserWindow|BrowserView|webview|signInWithPopup|signInWithRedirect/u,
    );
  });
});

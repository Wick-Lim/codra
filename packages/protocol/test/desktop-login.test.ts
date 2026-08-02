import { describe, expect, it } from "vitest";
import {
  DesktopLoginAllowResponseSchema,
  DesktopLoginAuthorizeRequestSchema,
  DesktopLoginCancelRequestSchema,
  DesktopLoginCancelResponseSchema,
  DesktopLoginInspectResponseSchema,
  DesktopLoginRedeemRequestSchema,
  DesktopLoginRedeemResponseSchema,
  DesktopLoginStartRequestSchema,
  buildDesktopLoginRedeemSigningPayload,
  buildDesktopLoginStartSigningPayload,
} from "../src";
import {
  createPkceChallenge,
  createPkceVerifier,
  createRfc7638Thumbprint,
  sha256Base64Url,
} from "../src/remote-signing";

const publicKey = {
  kty: "EC",
  crv: "P-256",
  x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
  y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
} as const;

const deviceId = "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d";
const attemptId = "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f";
const verifier = createPkceVerifier(new Uint8Array(32).fill(7));
const state = createPkceVerifier(new Uint8Array(32).fill(8));
const nonce = createPkceVerifier(new Uint8Array(32).fill(9));
const thumbprint = createRfc7638Thumbprint(publicKey);
const signature = "A".repeat(86);

const startRequest = {
  attemptId,
  action: "register" as const,
  deviceId,
  displayName: "Jun's MacBook Pro",
  publicKeyJwk: publicKey,
  keyThumbprint: thumbprint,
  pkceChallenge: createPkceChallenge(verifier),
  stateHash: sha256Base64Url(state),
  nonce,
  callbackPort: 43123,
  callbackPath: "/auth/callback" as const,
  startSignature: signature,
};

const remoteDevice = {
  deviceId,
  ownerUid: "owner-uid",
  kind: "host" as const,
  displayName: "Jun's MacBook Pro",
  publicKeyJwk: publicKey,
  keyThumbprint: thumbprint,
  active: true,
  generation: 1,
  remoteAccessEnabled: true,
  capabilities: ["terminal"],
  createdAt: 1,
  lastSeenAt: 1,
  expiresAt: 2,
};

describe("desktop login protocol", () => {
  it("accepts canonical start, authorize, redeem, and cancel requests", () => {
    expect(DesktopLoginStartRequestSchema.parse(startRequest)).toEqual(
      startRequest,
    );
    expect(
      DesktopLoginAuthorizeRequestSchema.parse({
        action: "inspect",
        attemptId,
        state,
      }),
    ).toEqual({ action: "inspect", attemptId, state });
    expect(
      DesktopLoginRedeemRequestSchema.parse({
        attemptId,
        code: createPkceVerifier(new Uint8Array(32).fill(10)),
        state,
        nonce,
        pkceVerifier: verifier,
        deviceSignature: signature,
      }),
    ).toEqual({
      attemptId,
      code: createPkceVerifier(new Uint8Array(32).fill(10)),
      state,
      nonce,
      pkceVerifier: verifier,
      deviceSignature: signature,
    });
    expect(DesktopLoginCancelRequestSchema.parse({ attemptId, state })).toEqual(
      {
        attemptId,
        state,
      },
    );
  });

  it("rejects malformed UUIDs in desktop login requests", () => {
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        attemptId: "no",
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginStartRequestSchema.parse({ ...startRequest, deviceId: "no" }),
    ).toThrow();
    expect(() =>
      DesktopLoginAuthorizeRequestSchema.parse({
        action: "allow",
        attemptId: "no",
        state,
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginRedeemRequestSchema.parse({
        attemptId,
        code: createPkceVerifier(new Uint8Array(32).fill(10)),
        state,
        nonce: `${nonce}=`,
        pkceVerifier: verifier,
        deviceSignature: signature,
      }),
    ).toThrow();
  });

  it("enforces the loopback callback port range", () => {
    expect(
      DesktopLoginStartRequestSchema.parse({ ...startRequest, callbackPort: 1 })
        .callbackPort,
    ).toBe(1);
    expect(
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        callbackPort: 65_535,
      }).callbackPort,
    ).toBe(65_535);
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        callbackPort: 0,
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        callbackPort: 65_536,
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        keyThumbprint: sha256Base64Url("different-public-key"),
      }),
    ).toThrow();
  });

  it("rejects noncanonical PKCE, state, and nonce values", () => {
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        pkceChallenge: `${startRequest.pkceChallenge}=`,
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        stateHash: `${startRequest.stateHash}=`,
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        nonce: `${nonce}=`,
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginAuthorizeRequestSchema.parse({
        action: "allow",
        attemptId,
        state: `${state}=`,
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginRedeemRequestSchema.parse({
        attemptId,
        code: createPkceVerifier(new Uint8Array(32).fill(10)),
        state,
        nonce,
        pkceVerifier: `${verifier}=`,
        deviceSignature: signature,
      }),
    ).toThrow();
  });

  it("rejects extra fields and malformed key proof material", () => {
    expect(() =>
      DesktopLoginStartRequestSchema.parse({ ...startRequest, unknown: true }),
    ).toThrow();
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        publicKeyJwk: { ...publicKey, x: "AAAA" },
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        keyThumbprint: "A".repeat(42),
      }),
    ).toThrow();
    expect(() =>
      DesktopLoginStartRequestSchema.parse({
        ...startRequest,
        startSignature: "A".repeat(85),
      }),
    ).toThrow();
  });

  it("strictly validates browser-facing desktop login responses", () => {
    expect(
      DesktopLoginInspectResponseSchema.parse({
        attemptId,
        action: "resume",
        displayName: "Jun's MacBook Pro",
        fingerprintSuffix: thumbprint.slice(-8),
      }),
    ).toEqual({
      attemptId,
      action: "resume",
      displayName: "Jun's MacBook Pro",
      fingerprintSuffix: thumbprint.slice(-8),
    });
    expect(
      DesktopLoginAllowResponseSchema.parse({
        attemptId,
        callbackUrl: "http://127.0.0.1:43123/auth/callback",
        state,
        code: createPkceVerifier(new Uint8Array(32).fill(10)),
      }).callbackUrl,
    ).toBe("http://127.0.0.1:43123/auth/callback");
    expect(
      DesktopLoginRedeemResponseSchema.parse({
        token: "custom-token",
        serverTimeMillis: 1,
        device: remoteDevice,
      }).device,
    ).toEqual(remoteDevice);
    expect(DesktopLoginCancelResponseSchema.parse({ cancelled: true })).toEqual(
      {
        cancelled: true,
      },
    );
    expect(() =>
      DesktopLoginCancelResponseSchema.parse({
        cancelled: true,
        unknown: true,
      }),
    ).toThrow();
  });

  it("builds the exact device signatures' canonical payloads", () => {
    expect(buildDesktopLoginStartSigningPayload(startRequest)).toEqual({
      attemptId,
      action: "register",
      deviceId,
      displayName: "Jun's MacBook Pro",
      publicKeyJwk: publicKey,
      keyThumbprint: thumbprint,
      pkceChallenge: createPkceChallenge(verifier),
      stateHash: sha256Base64Url(state),
      nonce,
      callbackPort: 43123,
      callbackPath: "/auth/callback",
    });
    expect(
      buildDesktopLoginRedeemSigningPayload({
        attemptId,
        code: createPkceVerifier(new Uint8Array(32).fill(10)),
        state,
        nonce,
        deviceId,
        keyThumbprint: thumbprint,
      }),
    ).toEqual({
      domain: "codra.desktop-login.redeem.v1",
      attemptId,
      code: createPkceVerifier(new Uint8Array(32).fill(10)),
      state,
      nonce,
      deviceId,
      keyThumbprint: thumbprint,
    });
  });
});

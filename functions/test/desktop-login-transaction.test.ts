import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDesktopLoginRedeemSigningPayload,
  buildDesktopLoginStartSigningPayload,
  createPkceChallenge,
  createPkceVerifier,
  createRfc7638Thumbprint,
  sha256Base64Url,
  signCanonicalPayload,
  type DesktopLoginAction,
  type DesktopLoginStartRequest,
  type PublicEcJwk,
} from "@codra/protocol";

const fake = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
  const doc = (path: string) => ({
    path,
    get: async () => snapshot(path),
  });
  const snapshot = (path: string) => {
    const value = documents.get(path);
    return {
      exists: value !== undefined,
      data: () => value,
    };
  };
  const transaction = {
    get: async (reference: { path: string }) => snapshot(reference.path),
    create: (reference: { path: string }, value: Record<string, unknown>) => {
      if (documents.has(reference.path)) throw new Error("already exists");
      documents.set(reference.path, { ...value });
    },
    update: (reference: { path: string }, value: Record<string, unknown>) => {
      const existing = documents.get(reference.path);
      if (!existing) throw new Error("missing document");
      documents.set(reference.path, { ...existing, ...value });
    },
    set: (reference: { path: string }, value: Record<string, unknown>) => {
      documents.set(reference.path, { ...value });
    },
  };
  return {
    documents,
    adminDb: {
      doc,
      runTransaction: async <T>(
        callback: (value: typeof transaction) => Promise<T>,
      ) => callback(transaction),
    },
    adminAuth: { createCustomToken: vi.fn(async () => "device-custom-token") },
  };
});

vi.mock("../src/runtime", () => ({
  adminDb: fake.adminDb,
  adminAuth: fake.adminAuth,
}));

import {
  authorizeDesktopLogin,
  desktopLoginCancel,
  desktopLoginRedeem,
  desktopLoginStart,
} from "../src/desktop-login";

const deviceId = "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d";
const attemptId = "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f";
const ownerUid = "google-owner";

type JsonResponse = {
  headers: Record<string, string>;
  statusCode?: number;
  body?: unknown;
  on(event: string, listener: (...args: unknown[]) => void): JsonResponse;
  set(name: string, value: string): JsonResponse;
  status(code: number): JsonResponse;
  json(body: unknown): void;
};

function response(): JsonResponse {
  return {
    headers: {},
    on() {
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
  };
}

function rawRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify(body), "utf8"),
    body,
  };
}

function googleRequest(data: unknown) {
  return {
    data,
    auth: {
      uid: ownerUid,
      token: {
        firebase: { sign_in_provider: "google.com" },
        auth_time: Math.floor(Date.now() / 1000),
      },
    },
  };
}

async function p256Identity(): Promise<{
  publicKey: PublicEcJwk;
  privateKey: JsonWebKey;
}> {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const exportedPublic = await webcrypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  );
  return {
    publicKey: {
      kty: "EC",
      crv: "P-256",
      x: exportedPublic.x!,
      y: exportedPublic.y!,
    },
    privateKey: await webcrypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

async function startInput(input: {
  action?: DesktopLoginAction;
  attempt?: string;
  identity: Awaited<ReturnType<typeof p256Identity>>;
  verifier?: string;
  state?: string;
  nonce?: string;
}): Promise<{
  request: DesktopLoginStartRequest;
  verifier: string;
  state: string;
  nonce: string;
}> {
  const verifier =
    input.verifier ?? createPkceVerifier(new Uint8Array(32).fill(7));
  const state = input.state ?? createPkceVerifier(new Uint8Array(32).fill(8));
  const nonce = input.nonce ?? createPkceVerifier(new Uint8Array(32).fill(9));
  const unsigned = {
    attemptId: input.attempt ?? attemptId,
    action: input.action ?? "register",
    deviceId,
    displayName: "Jun's MacBook Pro",
    publicKeyJwk: input.identity.publicKey,
    keyThumbprint: createRfc7638Thumbprint(input.identity.publicKey),
    pkceChallenge: createPkceChallenge(verifier),
    stateHash: sha256Base64Url(state),
    nonce,
    callbackPort: 43123,
    callbackPath: "/auth/callback" as const,
    startSignature: "A".repeat(86),
  };
  return {
    request: {
      ...unsigned,
      startSignature: await signCanonicalPayload(
        input.identity.privateKey,
        buildDesktopLoginStartSigningPayload(unsigned),
      ),
    },
    verifier,
    state,
    nonce,
  };
}

async function startAttempt(input: Parameters<typeof startInput>[0]) {
  const prepared = await startInput(input);
  const res = response();
  await desktopLoginStart(rawRequest(prepared.request) as never, res as never);
  expect(res.statusCode).toBe(200);
  return { ...prepared, startResponse: res.body as Record<string, unknown> };
}

async function authorize(attempt: string, state: string): Promise<string> {
  const allowed = await authorizeDesktopLogin.run(
    googleRequest({ action: "allow", attemptId: attempt, state }) as never,
  );
  return (allowed as { code: string }).code;
}

async function redeem(input: {
  attempt: string;
  code: string;
  state: string;
  nonce: string;
  verifier: string;
  identity: Awaited<ReturnType<typeof p256Identity>>;
}) {
  const stored = fake.documents.get(
    `serverDesktopLoginTransactions/${input.attempt}`,
  )!;
  const request = {
    attemptId: input.attempt,
    code: input.code,
    state: input.state,
    nonce: input.nonce,
    pkceVerifier: input.verifier,
    deviceSignature: "A".repeat(86),
  };
  request.deviceSignature = await signCanonicalPayload(
    input.identity.privateKey,
    buildDesktopLoginRedeemSigningPayload({
      attemptId: input.attempt,
      code: input.code,
      state: input.state,
      nonce: input.nonce,
      deviceId: stored.deviceId as string,
      keyThumbprint: stored.keyThumbprint as string,
    }),
  );
  const res = response();
  await desktopLoginRedeem(rawRequest(request) as never, res as never);
  return res;
}

beforeEach(() => {
  fake.documents.clear();
  fake.adminAuth.createCustomToken.mockClear();
});

describe("desktop login transaction Functions", () => {
  it("stores a bounded signed start transaction and rejects a duplicate attempt", async () => {
    const identity = await p256Identity();
    const started = await startAttempt({ identity });
    const stored = fake.documents.get(
      `serverDesktopLoginTransactions/${attemptId}`,
    )!;
    expect(started.startResponse).toMatchObject({
      attemptId,
      serverNonce: started.nonce,
      callbackUrl: "http://127.0.0.1:43123/auth/callback",
    });
    expect(stored).toMatchObject({
      attemptId,
      deviceId,
      stateHash: sha256Base64Url(started.state),
      pkceChallenge: createPkceChallenge(started.verifier),
      nonce: started.nonce,
      callbackPort: 43123,
      callbackPath: "/auth/callback",
      status: "pending",
    });
    expect(stored).not.toHaveProperty("code");
    expect(stored).not.toHaveProperty("ownerUid");

    const duplicate = response();
    await desktopLoginStart(
      rawRequest(started.request) as never,
      duplicate as never,
    );
    expect(duplicate.body).toEqual({ error: "LOGIN_ATTEMPT_EXISTS" });
  });

  it("rejects absent and non-Google authorization before inspecting a transaction", async () => {
    await expect(
      authorizeDesktopLogin.run({ data: {} } as never),
    ).rejects.toThrow("AUTH_REQUIRED");
    await expect(
      authorizeDesktopLogin.run({
        data: {},
        auth: {
          uid: ownerUid,
          token: { firebase: { sign_in_provider: "password" } },
        },
      } as never),
    ).rejects.toThrow("GOOGLE_ACCOUNT_REQUIRED");
  });

  it("requires a recent Google authentication timestamp", async () => {
    await expect(
      authorizeDesktopLogin.run({
        data: {},
        auth: {
          uid: ownerUid,
          token: { firebase: { sign_in_provider: "google.com" } },
        },
      } as never),
    ).rejects.toThrow("RECENT_GOOGLE_AUTH_REQUIRED");
    await expect(
      authorizeDesktopLogin.run({
        data: {},
        auth: {
          uid: ownerUid,
          token: {
            firebase: { sign_in_provider: "google.com" },
            auth_time: "not-a-number",
          },
        },
      } as never),
    ).rejects.toThrow("RECENT_GOOGLE_AUTH_REQUIRED");
    await expect(
      authorizeDesktopLogin.run({
        data: {},
        auth: {
          uid: ownerUid,
          token: {
            firebase: { sign_in_provider: "google.com" },
            auth_time: Math.floor((Date.now() - 6 * 60 * 1000) / 1000),
          },
        },
      } as never),
    ).rejects.toThrow("RECENT_GOOGLE_AUTH_REQUIRED");
    await expect(
      authorizeDesktopLogin.run({
        data: {},
        auth: {
          uid: ownerUid,
          token: {
            firebase: { sign_in_provider: "google.com" },
            auth_time: Math.ceil((Date.now() + 31_000) / 1000),
          },
        },
      } as never),
    ).rejects.toThrow("RECENT_GOOGLE_AUTH_REQUIRED");
  });

  it("rejects malformed start payloads before creating a transaction", async () => {
    const res = response();
    await desktopLoginStart(rawRequest({}) as never, res as never);
    expect(res.body).toEqual({ error: "INVALID_REQUEST" });
    expect(fake.documents.size).toBe(0);
  });

  it("rejects a start binding signed by the wrong device key", async () => {
    const identity = await p256Identity();
    const otherIdentity = await p256Identity();
    const prepared = await startInput({ identity });
    prepared.request.startSignature = await signCanonicalPayload(
      otherIdentity.privateKey,
      buildDesktopLoginStartSigningPayload(prepared.request),
    );
    const res = response();
    await desktopLoginStart(
      rawRequest(prepared.request) as never,
      res as never,
    );
    expect(res.body).toEqual({ error: "START_SIGNATURE_INVALID" });
  });

  it("inspects and authorizes one matching Google transaction exactly once", async () => {
    const identity = await p256Identity();
    const started = await startAttempt({ identity });
    await expect(
      authorizeDesktopLogin.run(
        googleRequest({
          action: "inspect",
          attemptId,
          state: createPkceVerifier(new Uint8Array(32).fill(2)),
        }) as never,
      ),
    ).rejects.toThrow("LOGIN_STATE_INVALID");
    await expect(
      authorizeDesktopLogin.run(
        googleRequest({
          action: "inspect",
          attemptId,
          state: started.state,
        }) as never,
      ),
    ).resolves.toMatchObject({ attemptId, displayName: "Jun's MacBook Pro" });

    const code = await authorize(attemptId, started.state);
    const stored = fake.documents.get(
      `serverDesktopLoginTransactions/${attemptId}`,
    )!;
    expect(stored).toMatchObject({
      status: "authorized",
      ownerUid,
      codeHash: sha256Base64Url(code),
    });
    expect(stored).not.toHaveProperty("code");
    await expect(authorize(attemptId, started.state)).rejects.toThrow(
      "LOGIN_ALREADY_AUTHORIZED",
    );
  });

  it("validates redeem code, nonce, PKCE, signature, and consumes a register attempt once", async () => {
    const identity = await p256Identity();
    const started = await startAttempt({ identity });
    const code = await authorize(attemptId, started.state);
    const wrongCode = await redeem({
      attempt: attemptId,
      code: createPkceVerifier(new Uint8Array(32).fill(6)),
      state: started.state,
      nonce: started.nonce,
      verifier: started.verifier,
      identity,
    });
    expect(wrongCode.body).toEqual({ error: "LOGIN_CODE_INVALID" });
    const wrongState = await redeem({
      attempt: attemptId,
      code,
      state: createPkceVerifier(new Uint8Array(32).fill(10)),
      nonce: started.nonce,
      verifier: started.verifier,
      identity,
    });
    expect(wrongState.body).toEqual({ error: "LOGIN_STATE_INVALID" });
    const wrongNonce = await redeem({
      attempt: attemptId,
      code,
      state: started.state,
      nonce: createPkceVerifier(new Uint8Array(32).fill(3)),
      verifier: started.verifier,
      identity,
    });
    expect(wrongNonce.body).toEqual({ error: "LOGIN_NONCE_INVALID" });
    const wrongPkce = await redeem({
      attempt: attemptId,
      code,
      state: started.state,
      nonce: started.nonce,
      verifier: createPkceVerifier(new Uint8Array(32).fill(4)),
      identity,
    });
    expect(wrongPkce.body).toEqual({ error: "PKCE_VERIFIER_INVALID" });

    const valid = await redeem({
      attempt: attemptId,
      code,
      state: started.state,
      nonce: started.nonce,
      verifier: started.verifier,
      identity,
    });
    expect(valid.body).toMatchObject({ token: "device-custom-token" });
    expect(fake.adminAuth.createCustomToken).toHaveBeenCalledWith(ownerUid, {
      codraDeviceId: deviceId,
      codraKeyThumbprint: createRfc7638Thumbprint(identity.publicKey),
      codraDeviceKind: "host",
      codraDeviceGeneration: 1,
    });
    expect(
      fake.documents.get(`serverDesktopLoginTransactions/${attemptId}`),
    ).toMatchObject({
      status: "consumed",
    });
    const replay = await redeem({
      attempt: attemptId,
      code,
      state: started.state,
      nonce: started.nonce,
      verifier: started.verifier,
      identity,
    });
    expect(replay.body).toEqual({ error: "LOGIN_CONSUMED" });
  });

  it("rejects a redeem signed by the wrong device key", async () => {
    const identity = await p256Identity();
    const otherIdentity = await p256Identity();
    const started = await startAttempt({ identity });
    const code = await authorize(attemptId, started.state);
    const stored = fake.documents.get(
      `serverDesktopLoginTransactions/${attemptId}`,
    )!;
    const request = {
      attemptId,
      code,
      state: started.state,
      nonce: started.nonce,
      pkceVerifier: started.verifier,
      deviceSignature: await signCanonicalPayload(
        otherIdentity.privateKey,
        buildDesktopLoginRedeemSigningPayload({
          attemptId,
          code,
          state: started.state,
          nonce: started.nonce,
          deviceId: stored.deviceId as string,
          keyThumbprint: stored.keyThumbprint as string,
        }),
      ),
    };
    const res = response();
    await desktopLoginRedeem(rawRequest(request) as never, res as never);
    expect(res.body).toEqual({ error: "REDEEM_SIGNATURE_INVALID" });
  });

  it("resumes only the matching active host key", async () => {
    const identity = await p256Identity();
    const first = await startAttempt({ identity });
    const firstCode = await authorize(attemptId, first.state);
    await redeem({
      attempt: attemptId,
      code: firstCode,
      state: first.state,
      nonce: first.nonce,
      verifier: first.verifier,
      identity,
    });
    const resumeAttempt = "8f30e86f-4cee-4d8b-b0ca-9718207d30de";
    const resumed = await startAttempt({
      identity,
      action: "resume",
      attempt: resumeAttempt,
    });
    const resumeCode = await authorize(resumeAttempt, resumed.state);
    const result = await redeem({
      attempt: resumeAttempt,
      code: resumeCode,
      state: resumed.state,
      nonce: resumed.nonce,
      verifier: resumed.verifier,
      identity,
    });
    expect(result.body).toMatchObject({
      token: "device-custom-token",
      device: { generation: 1 },
    });

    const otherIdentity = await p256Identity();
    const mismatchAttempt = "c7b59b0a-e61e-4d7e-b0c8-eac755a2e252";
    const mismatched = await startAttempt({
      identity: otherIdentity,
      action: "resume",
      attempt: mismatchAttempt,
    });
    const mismatchCode = await authorize(mismatchAttempt, mismatched.state);
    const mismatch = await redeem({
      attempt: mismatchAttempt,
      code: mismatchCode,
      state: mismatched.state,
      nonce: mismatched.nonce,
      verifier: mismatched.verifier,
      identity: otherIdentity,
    });
    expect(mismatch.body).toEqual({ error: "DEVICE_KEY_MISMATCH" });

    const devicePath = `users/${ownerUid}/devices/${deviceId}`;
    const existing = fake.documents.get(devicePath)!;
    fake.documents.set(devicePath, { ...existing, active: false });
    const disabledAttempt = "eab679d5-d301-4706-92b8-67c0a935b70b";
    const disabled = await startAttempt({
      identity,
      action: "resume",
      attempt: disabledAttempt,
    });
    const disabledCode = await authorize(disabledAttempt, disabled.state);
    const disabledResult = await redeem({
      attempt: disabledAttempt,
      code: disabledCode,
      state: disabled.state,
      nonce: disabled.nonce,
      verifier: disabled.verifier,
      identity,
    });
    expect(disabledResult.body).toEqual({ error: "DEVICE_DISABLED" });
  });

  it("cancels only the matching transaction and makes the matching retry idempotent", async () => {
    const identity = await p256Identity();
    const started = await startAttempt({ identity });
    const cancel = response();
    await desktopLoginCancel(
      rawRequest({ attemptId, state: started.state }) as never,
      cancel as never,
    );
    expect(cancel.body).toEqual({ cancelled: true });
    const retry = response();
    await desktopLoginCancel(
      rawRequest({ attemptId, state: started.state }) as never,
      retry as never,
    );
    expect(retry.body).toEqual({ cancelled: true });
    const wrongState = response();
    await desktopLoginCancel(
      rawRequest({
        attemptId,
        state: createPkceVerifier(new Uint8Array(32).fill(1)),
      }) as never,
      wrongState as never,
    );
    expect(wrongState.body).toEqual({ error: "LOGIN_STATE_INVALID" });

    const secondIdentity = await p256Identity();
    const consumed = await startAttempt({
      identity: secondIdentity,
      attempt: "f93c0b57-f71d-4bdb-9764-9477fe12a0e4",
    });
    const consumedCode = await authorize(
      consumed.request.attemptId,
      consumed.state,
    );
    await redeem({
      attempt: consumed.request.attemptId,
      code: consumedCode,
      state: consumed.state,
      nonce: consumed.nonce,
      verifier: consumed.verifier,
      identity: secondIdentity,
    });
    const consumedCancel = response();
    await desktopLoginCancel(
      rawRequest({
        attemptId: consumed.request.attemptId,
        state: consumed.state,
      }) as never,
      consumedCancel as never,
    );
    expect(consumedCancel.body).toEqual({ error: "LOGIN_NOT_CANCELLABLE" });
  });
});

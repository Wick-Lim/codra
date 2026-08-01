import { randomBytes, timingSafeEqual } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest, type CallableRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  ACCOUNT_AUTH_FUTURE_SKEW_MS,
  ACCOUNT_AUTH_MAX_AGE_MS,
  DesktopLoginAuthorizeRequestSchema,
  DesktopLoginCancelRequestSchema,
  DesktopLoginRedeemRequestSchema,
  DesktopLoginStartRequestSchema,
  FUNCTION_REGION,
  RemoteDeviceSchema,
  buildDesktopLoginRedeemSigningPayload,
  buildDesktopLoginStartSigningPayload,
  createPkceChallenge,
  createRfc7638Thumbprint,
  encodeBase64Url,
  sha256Base64Url,
  verifyCanonicalPayload,
  type DesktopLoginAction,
  type PublicEcJwk,
  type RemoteDevice,
} from "@codra/protocol";
import { adminAuth, adminDb } from "./runtime";

const LOGIN_TTL_MS = 5 * 60 * 1000;
const CODE_TTL_MS = 90 * 1000;
const MAX_REQUEST_BODY_BYTES = 32 * 1024;
const TRANSACTION_COLLECTION = "serverDesktopLoginTransactions";

export const DESKTOP_LOGIN_PUBLIC_EXPORTS = [
  "desktopLoginStart",
  "authorizeDesktopLogin",
  "desktopLoginRedeem",
  "desktopLoginCancel",
] as const;

type TransactionStatus = "pending" | "authorized" | "consumed" | "cancelled";

interface DesktopLoginTransaction {
  attemptId: string;
  action: DesktopLoginAction;
  deviceId: string;
  displayName: string;
  publicKeyJwk: PublicEcJwk;
  keyThumbprint: string;
  pkceChallenge: string;
  stateHash: string;
  nonce: string;
  callbackPort: number;
  callbackPath: "/auth/callback";
  callbackUrl: string;
  status: TransactionStatus;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  ownerUid?: string;
  codeHash?: string;
  codeExpiresAt?: Timestamp;
  authorizedAt?: Timestamp;
  consumedAt?: Timestamp;
  cancelledAt?: Timestamp;
}

export type RawDesktopLoginRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
};

export type RawDesktopLoginError =
  | "METHOD_NOT_ALLOWED"
  | "ORIGIN_NOT_ALLOWED"
  | "CONTENT_TYPE_REQUIRED"
  | "REQUEST_TOO_LARGE";

/**
 * This intentionally does not parse JSON: raw handlers must reject the HTTP
 * envelope before application data can affect a transaction.
 */
export function validateRawDesktopLoginRequest(
  request: RawDesktopLoginRequest,
): RawDesktopLoginError | undefined {
  if (request.method !== "POST") return "METHOD_NOT_ALLOWED";
  const headers = request.headers ?? {};
  const origin = headers.origin ?? headers.Origin;
  if (origin !== undefined) return "ORIGIN_NOT_ALLOWED";
  const contentType = headers["content-type"] ?? headers["Content-Type"];
  const firstContentType = Array.isArray(contentType)
    ? contentType[0]
    : contentType;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(firstContentType ?? ""))
    return "CONTENT_TYPE_REQUIRED";
  if ((request.rawBody?.byteLength ?? 0) > MAX_REQUEST_BODY_BYTES)
    return "REQUEST_TOO_LARGE";
  return undefined;
}

function safeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function toMillis(value: Timestamp | number | undefined): number {
  if (value instanceof Timestamp) return value.toMillis();
  return value ?? 0;
}

function callbackUrl(port: number, path: "/auth/callback"): string {
  return `http://127.0.0.1:${port}${path}`;
}

function rawBody(request: {
  rawBody?: unknown;
  body?: unknown;
}): Buffer | undefined {
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody;
  if (typeof request.body === "string") return Buffer.from(request.body, "utf8");
  if (request.body === undefined) return undefined;
  try {
    return Buffer.from(JSON.stringify(request.body), "utf8");
  } catch {
    return undefined;
  }
}

function parseRawJson<T>(
  schema: z.ZodType<T>,
  request: { body?: unknown; rawBody?: unknown },
): T {
  const body = rawBody(request);
  if (!body || body.byteLength > MAX_REQUEST_BODY_BYTES)
    throw new HttpsError("invalid-argument", "INVALID_REQUEST");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpsError("invalid-argument", "INVALID_REQUEST");
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) throw new HttpsError("invalid-argument", "INVALID_REQUEST");
  return parsed.data;
}

function rawErrorStatus(error: RawDesktopLoginError): number {
  return error === "METHOD_NOT_ALLOWED" ? 405 : 400;
}

function sendRawError(
  response: { status(code: number): { json(body: unknown): void } },
  error: string,
  status = 400,
): void {
  response.status(status).json({ error });
}

async function withRawDesktopLoginRequest(
  request: {
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    rawBody?: unknown;
    body?: unknown;
  },
  response: {
    set(name: string, value: string): unknown;
    status(code: number): { json(body: unknown): void };
  },
  handler: () => Promise<unknown>,
): Promise<void> {
  response.set("Cache-Control", "no-store");
  const body = rawBody(request);
  const error = validateRawDesktopLoginRequest({
    method: request.method,
    headers: request.headers,
    rawBody: body,
  });
  if (error) {
    sendRawError(response, error, rawErrorStatus(error));
    return;
  }
  try {
    const result = await handler();
    response.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpsError) {
      sendRawError(response, error.message, error.code === "not-found" ? 404 : 400);
      return;
    }
    sendRawError(response, "INTERNAL_ERROR", 500);
  }
}

function parseTransaction(snapshot: { data(): Record<string, unknown> | undefined }): DesktopLoginTransaction {
  const data = snapshot.data();
  if (!data) throw new HttpsError("not-found", "LOGIN_NOT_FOUND");
  return data as unknown as DesktopLoginTransaction;
}

function assertLiveTransaction(
  transaction: DesktopLoginTransaction,
  now: Timestamp,
): void {
  if (toMillis(transaction.expiresAt) <= now.toMillis())
    throw new HttpsError("failed-precondition", "LOGIN_EXPIRED");
  if (transaction.status === "cancelled")
    throw new HttpsError("failed-precondition", "LOGIN_CANCELLED");
  if (transaction.status === "consumed")
    throw new HttpsError("failed-precondition", "LOGIN_CONSUMED");
}

function requireGoogleAccount(request: CallableRequest<unknown>): { uid: string } {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  if (request.auth.token.firebase?.sign_in_provider !== "google.com")
    throw new HttpsError("permission-denied", "GOOGLE_ACCOUNT_REQUIRED");
  const authTime = request.auth.token.auth_time;
  const now = Date.now();
  if (
    typeof authTime !== "number" ||
    !Number.isFinite(authTime) ||
    authTime * 1000 < now - ACCOUNT_AUTH_MAX_AGE_MS ||
    authTime * 1000 > now + ACCOUNT_AUTH_FUTURE_SKEW_MS
  ) {
    throw new HttpsError("unauthenticated", "RECENT_GOOGLE_AUTH_REQUIRED");
  }
  return { uid: request.auth.uid };
}

function parseCallableInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "INVALID_REQUEST");
  return parsed.data;
}

function inspectResponse(transaction: DesktopLoginTransaction): {
  attemptId: string;
  action: DesktopLoginAction;
  displayName: string;
  fingerprintSuffix: string;
} {
  return {
    attemptId: transaction.attemptId,
    action: transaction.action,
    displayName: transaction.displayName,
    fingerprintSuffix: transaction.keyThumbprint.slice(-8),
  };
}

function remoteDeviceForResponse(device: {
  deviceId: string;
  ownerUid: string;
  displayName: string;
  publicKeyJwk: PublicEcJwk;
  keyThumbprint: string;
  generation: number;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  expiresAt: Timestamp;
}): RemoteDevice {
  return RemoteDeviceSchema.parse({
    deviceId: device.deviceId,
    ownerUid: device.ownerUid,
    kind: "host",
    displayName: device.displayName,
    publicKeyJwk: device.publicKeyJwk,
    keyThumbprint: device.keyThumbprint,
    active: true,
    generation: device.generation,
    remoteAccessEnabled: true,
    capabilities: ["terminal"],
    createdAt: toMillis(device.createdAt),
    lastSeenAt: toMillis(device.lastSeenAt),
    expiresAt: toMillis(device.expiresAt),
  });
}

export const desktopLoginStart = onRequest(
  { region: FUNCTION_REGION, cors: false },
  async (request, response) =>
    withRawDesktopLoginRequest(request, response, async () => {
      const input = parseRawJson(DesktopLoginStartRequestSchema, request);
      if (createRfc7638Thumbprint(input.publicKeyJwk) !== input.keyThumbprint)
        throw new HttpsError("invalid-argument", "KEY_THUMBPRINT_MISMATCH");
      if (
        !(await verifyCanonicalPayload(
          input.publicKeyJwk,
          input.startSignature,
          buildDesktopLoginStartSigningPayload(input),
        ))
      ) {
        throw new HttpsError("permission-denied", "START_SIGNATURE_INVALID");
      }
      const now = Timestamp.now();
      const expiresAt = Timestamp.fromMillis(now.toMillis() + LOGIN_TTL_MS);
      const transaction: DesktopLoginTransaction = {
        attemptId: input.attemptId,
        action: input.action,
        deviceId: input.deviceId,
        displayName: input.displayName,
        publicKeyJwk: input.publicKeyJwk,
        keyThumbprint: input.keyThumbprint,
        pkceChallenge: input.pkceChallenge,
        stateHash: input.stateHash,
        nonce: input.nonce,
        callbackPort: input.callbackPort,
        callbackPath: input.callbackPath,
        callbackUrl: callbackUrl(input.callbackPort, input.callbackPath),
        status: "pending",
        createdAt: now,
        expiresAt,
      };
      const ref = adminDb.doc(`${TRANSACTION_COLLECTION}/${input.attemptId}`);
      await adminDb.runTransaction(async (firestoreTransaction) => {
        const existing = await firestoreTransaction.get(ref);
        if (existing.exists)
          throw new HttpsError("already-exists", "LOGIN_ATTEMPT_EXISTS");
        firestoreTransaction.create(ref, transaction);
      });
      return {
        attemptId: input.attemptId,
        serverNonce: input.nonce,
        expiresAt: expiresAt.toMillis(),
        callbackUrl: transaction.callbackUrl,
      };
    }),
);

export const authorizeDesktopLogin = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const account = requireGoogleAccount(request);
    const input = parseCallableInput(DesktopLoginAuthorizeRequestSchema, request.data);
    const ref = adminDb.doc(`${TRANSACTION_COLLECTION}/${input.attemptId}`);
    const now = Timestamp.now();

    if (input.action === "inspect") {
      const snapshot = await ref.get();
      const transaction = parseTransaction(snapshot);
      assertLiveTransaction(transaction, now);
      if (!safeEquals(transaction.stateHash, sha256Base64Url(input.state)))
        throw new HttpsError("permission-denied", "LOGIN_STATE_INVALID");
      return inspectResponse(transaction);
    }

    const code = encodeBase64Url(randomBytes(32));
    await adminDb.runTransaction(async (firestoreTransaction) => {
      const snapshot = await firestoreTransaction.get(ref);
      const transaction = parseTransaction(snapshot);
      assertLiveTransaction(transaction, now);
      if (!safeEquals(transaction.stateHash, sha256Base64Url(input.state)))
        throw new HttpsError("permission-denied", "LOGIN_STATE_INVALID");
      if (transaction.status !== "pending")
        throw new HttpsError("failed-precondition", "LOGIN_ALREADY_AUTHORIZED");
      firestoreTransaction.update(ref, {
        status: "authorized",
        ownerUid: account.uid,
        codeHash: sha256Base64Url(code),
        codeExpiresAt: Timestamp.fromMillis(now.toMillis() + CODE_TTL_MS),
        authorizedAt: now,
      });
    });
    return {
      attemptId: input.attemptId,
      callbackUrl: callbackUrlFromSnapshot(await ref.get()),
      state: input.state,
      code,
    };
  },
);

function callbackUrlFromSnapshot(snapshot: {
  data(): Record<string, unknown> | undefined;
}): string {
  return parseTransaction(snapshot).callbackUrl;
}

export const desktopLoginRedeem = onRequest(
  { region: FUNCTION_REGION, cors: false },
  async (request, response) =>
    withRawDesktopLoginRequest(request, response, async () => {
      const input = parseRawJson(DesktopLoginRedeemRequestSchema, request);
      const ref = adminDb.doc(`${TRANSACTION_COLLECTION}/${input.attemptId}`);
      const now = Timestamp.now();
      const device = await adminDb.runTransaction(async (firestoreTransaction) => {
        const loginSnapshot = await firestoreTransaction.get(ref);
        const login = parseTransaction(loginSnapshot);
        assertLiveTransaction(login, now);
        if (login.status !== "authorized")
          throw new HttpsError("failed-precondition", "LOGIN_NOT_AUTHORIZED");
        if (
          !login.ownerUid ||
          !login.codeHash ||
          !login.codeExpiresAt ||
          toMillis(login.codeExpiresAt) <= now.toMillis()
        ) {
          throw new HttpsError("failed-precondition", "LOGIN_CODE_EXPIRED");
        }
        if (!safeEquals(login.codeHash, sha256Base64Url(input.code)))
          throw new HttpsError("permission-denied", "LOGIN_CODE_INVALID");
        if (!safeEquals(login.stateHash, sha256Base64Url(input.state)))
          throw new HttpsError("permission-denied", "LOGIN_STATE_INVALID");
        if (!safeEquals(login.nonce, input.nonce))
          throw new HttpsError("permission-denied", "LOGIN_NONCE_INVALID");
        if (!safeEquals(login.pkceChallenge, createPkceChallenge(input.pkceVerifier)))
          throw new HttpsError("permission-denied", "PKCE_VERIFIER_INVALID");
        if (
          !(await verifyCanonicalPayload(
            login.publicKeyJwk,
            input.deviceSignature,
            buildDesktopLoginRedeemSigningPayload({
              attemptId: input.attemptId,
              code: input.code,
              state: input.state,
              nonce: input.nonce,
              deviceId: login.deviceId,
              keyThumbprint: login.keyThumbprint,
            }),
          ))
        ) {
          throw new HttpsError("permission-denied", "REDEEM_SIGNATURE_INVALID");
        }
        const deviceRef = adminDb.doc(`users/${login.ownerUid}/devices/${login.deviceId}`);
        const deviceSnapshot = await firestoreTransaction.get(deviceRef);
        const current = deviceSnapshot.exists ? deviceSnapshot.data() : undefined;
        let generation = 1;
        let createdAt = now;
        if (current) {
          if (
            current.ownerUid !== login.ownerUid ||
            current.kind !== "host" ||
            current.keyThumbprint !== login.keyThumbprint
          ) {
            throw new HttpsError("already-exists", "DEVICE_KEY_MISMATCH");
          }
          if (login.action === "register")
            throw new HttpsError("already-exists", "DEVICE_ALREADY_REGISTERED");
          if (login.action === "resume" && current.active !== true)
            throw new HttpsError("failed-precondition", "DEVICE_DISABLED");
          if (login.action === "reenable" && current.active === true)
            throw new HttpsError("failed-precondition", "DEVICE_ALREADY_ACTIVE");
          generation =
            login.action === "reenable" ? Number(current.generation) + 1 : Number(current.generation);
          createdAt = (current.createdAt as Timestamp | undefined) ?? now;
        } else if (login.action === "resume") {
          throw new HttpsError("not-found", "DEVICE_NOT_FOUND");
        } else if (login.action === "reenable") {
          throw new HttpsError("not-found", "DEVICE_NOT_FOUND");
        }
        const expiresAt = Timestamp.fromMillis(now.toMillis() + 120_000);
        const stored = {
          deviceId: login.deviceId,
          ownerUid: login.ownerUid,
          kind: "host" as const,
          displayName: login.displayName,
          publicKeyJwk: login.publicKeyJwk,
          keyThumbprint: login.keyThumbprint,
          active: true,
          generation,
          remoteAccessEnabled: true,
          capabilities: ["terminal"],
          createdAt,
          lastSeenAt: now,
          expiresAt,
        };
        firestoreTransaction.set(deviceRef, stored);
        firestoreTransaction.update(ref, {
          status: "consumed",
          consumedAt: now,
        });
        return stored;
      });
      const token = await adminAuth.createCustomToken(device.ownerUid, {
        codraDeviceId: device.deviceId,
        codraKeyThumbprint: device.keyThumbprint,
        codraDeviceKind: "host",
        codraDeviceGeneration: device.generation,
      });
      return {
        token,
        serverTimeMillis: now.toMillis(),
        device: remoteDeviceForResponse(device),
      };
    }),
);

export const desktopLoginCancel = onRequest(
  { region: FUNCTION_REGION, cors: false },
  async (request, response) =>
    withRawDesktopLoginRequest(request, response, async () => {
      const input = parseRawJson(DesktopLoginCancelRequestSchema, request);
      const ref = adminDb.doc(`${TRANSACTION_COLLECTION}/${input.attemptId}`);
      const now = Timestamp.now();
      const cancelled = await adminDb.runTransaction(async (firestoreTransaction) => {
        const snapshot = await firestoreTransaction.get(ref);
        const transaction = parseTransaction(snapshot);
        if (!safeEquals(transaction.stateHash, sha256Base64Url(input.state)))
          throw new HttpsError("permission-denied", "LOGIN_STATE_INVALID");
        if (transaction.status === "cancelled") return true;
        if (
          transaction.status !== "pending" &&
          transaction.status !== "authorized"
        ) {
          throw new HttpsError("failed-precondition", "LOGIN_NOT_CANCELLABLE");
        }
        firestoreTransaction.update(ref, { status: "cancelled", cancelledAt: now });
        return true;
      });
      return { cancelled };
    }),
);

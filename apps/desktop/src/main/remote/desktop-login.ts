import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { FirebaseRuntime } from "@codra/firebase";
import { GoogleAuthProvider, signInWithCredential } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import {
  CODRA_PROJECT_ID,
  DesktopLoginAllowResponseSchema,
  FUNCTION_REGION,
  DesktopLoginRedeemResponseSchema,
  buildDesktopLoginRedeemSigningPayload,
  buildDesktopLoginStartSigningPayload,
  createPkceChallenge,
  createPkceVerifier,
  encodeBase64Url,
  sha256Base64Url,
  signCanonicalPayload,
  type DesktopLoginAction,
  type RemoteDevice,
} from "@codra/protocol";
import type { HostIdentity } from "./host-identity";

const CALLBACK_PATH = "/auth/callback" as const;
export const DESKTOP_LOGIN_CALLBACK_PORT = 45831 as const;
const IDENTITY_TOOLKIT_ORIGIN = "https://identitytoolkit.googleapis.com";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CANCEL_TIMEOUT_MS = 1_000;
const MAX_CALLBACK_TARGET_BYTES = 4 * 1024;
const PLACEHOLDER_SIGNATURE = encodeBase64Url(new Uint8Array(64));

const CALLBACK_SUCCESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>CODRA sign-in complete</title></head><body><p>You can return to CODRA.</p></body></html>`;

export interface DesktopLoginBootstrapResult {
  token: string;
  serverTimeMillis: number;
  device: RemoteDevice;
}

export interface DesktopLoginBootstrapOptions {
  identity: HostIdentity;
  action: DesktopLoginAction;
  useExistingAuth?: boolean;
}

export function shouldRetryDesktopLoginAsRegister(
  action: DesktopLoginAction,
  error: unknown,
): boolean {
  return (
    action === "resume" &&
    error instanceof Error &&
    error.message === "DEVICE_NOT_FOUND"
  );
}

export interface DesktopLoginCallback {
  attemptId: string;
  code: string;
  state: string;
  postBody: string;
}

export interface DesktopLoginGoogleAuthUriRequest {
  url: string;
  body: {
    providerId: "google.com";
    continueUri: string;
    authFlowType: "CODE_FLOW";
    sessionId: string;
    context: string;
  };
}

export interface DesktopLoginGoogleAuthExchangeRequest {
  requestUri: string;
  postBody: string;
  sessionId: string;
  returnSecureToken: true;
  returnIdpCredential: true;
}

export function createDesktopLoginDeviceSignaturePayload(input: {
  attemptId: string;
  code: string;
  state: string;
  nonce: string;
  deviceId: string;
  keyThumbprint: string;
}) {
  return buildDesktopLoginRedeemSigningPayload(input);
}

export interface DesktopLoginCallbackListener {
  port: number;
  waitForCallback(): Promise<DesktopLoginCallback>;
  close(): Promise<void>;
}

export interface DesktopLoginDependencies {
  fetch(input: string, init: RequestInit): Promise<Response>;
  openExternal(
    url: string,
    callbackUrl?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  randomBytes(size: number): Uint8Array;
  randomUUID(): string;
  timeoutMs: number;
}

export const desktopLoginDefaults: DesktopLoginDependencies = {
  fetch: (input, init) => fetch(input, init),
  openExternal: async () => undefined,
  randomBytes,
  randomUUID,
  timeoutMs: LOGIN_TIMEOUT_MS,
};

type CallbackRequest = Pick<IncomingMessage, "method" | "url" | "headers">;

function requestTargetByteLength(request: CallbackRequest): number {
  return Buffer.byteLength(request.url ?? "", "utf8");
}

function hasUnexpectedRequestBody(request: CallbackRequest): boolean {
  const value = request.headers["content-length"];
  const contentLength = Array.isArray(value) ? value[0] : value;
  if (contentLength === undefined) return false;
  return !/^0+$/u.test(contentLength.trim());
}

/**
 * This is deliberately strict: only the exact top-level redirect emitted by
 * Google OAuth is allowed to complete a local sign-in attempt.
 */
export function parseDesktopLoginCallback(
  request: CallbackRequest,
  expected: { port: number; attemptId: string; state: string },
): DesktopLoginCallback | undefined {
  if (request.method !== "GET") return undefined;
  if (request.headers.host !== `127.0.0.1:${expected.port}`) return undefined;
  if (requestTargetByteLength(request) > MAX_CALLBACK_TARGET_BYTES)
    return undefined;
  if (hasUnexpectedRequestBody(request)) return undefined;

  let url: URL;
  try {
    url = new URL(request.url ?? "", `http://127.0.0.1:${expected.port}`);
  } catch {
    return undefined;
  }
  if (url.pathname !== CALLBACK_PATH) return undefined;
  // Identity Toolkit creates the OAuth state used by Google. It is different
  // from the CODRA transaction state, which is checked when authorizing the
  // Firestore transaction and again during token redemption.
  const requiredKeys = ["code", "state"];
  const allowedKeys = [
    "code",
    "state",
    "iss",
    "scope",
    "authuser",
    "hd",
    "prompt",
  ];
  const keys = [...url.searchParams.keys()];
  if (
    keys.length < requiredKeys.length ||
    keys.some((key) => !allowedKeys.includes(key)) ||
    allowedKeys.some((key) => url.searchParams.getAll(key).length > 1) ||
    requiredKeys.some((key) => url.searchParams.getAll(key).length !== 1)
  ) {
    return undefined;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (
    typeof code !== "string" ||
    code.length < 1 ||
    code.length > 4_096 ||
    typeof state !== "string" ||
    state.length < 1 ||
    state.length > 4_096
  ) {
    return undefined;
  }
  return {
    attemptId: expected.attemptId,
    code,
    state,
    postBody: url.search.slice(1),
  };
}

function sendLoopbackError(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end("Invalid CODRA sign-in callback.");
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

export async function createDesktopLoginCallbackListener(options: {
  attemptId: string;
  state: string;
  timeoutMs?: number;
  port?: number;
}): Promise<DesktopLoginCallbackListener> {
  const sockets = new Set<Socket>();
  let port = 0;
  let settled = false;
  let closePromise: Promise<void> | undefined;
  const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};
  let resolveCallback!: (value: DesktopLoginCallback) => void;
  let rejectCallback!: (reason: Error) => void;
  const callback = new Promise<DesktopLoginCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // A bind failure can reject before the caller receives the listener. Keep a
  // handler attached while preserving the original promise for the caller.
  void callback.catch(() => undefined);
  const close = async (): Promise<void> => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (!closePromise) closePromise = closeServer(server, sockets);
    await closePromise;
  };
  const rejectAndClose = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    void close();
    rejectCallback(error);
  };
  const server = createServer((request, response) => {
    request.resume();
    if (settled) {
      sendLoopbackError(response, 409);
      return;
    }
    const accepted = parseDesktopLoginCallback(request, {
      port,
      attemptId: options.attemptId,
      state: options.state,
    });
    if (!accepted) {
      sendLoopbackError(response, request.method === "GET" ? 400 : 405);
      return;
    }
    settled = true;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.once("finish", () => {
      resolveCallback(accepted);
      void close();
    });
    response.end(CALLBACK_SUCCESS_HTML);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("error", (error) => rejectAndClose(error));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("DESKTOP_LOGIN_CALLBACK_ADDRESS_INVALID"));
        return;
      }
      port = address.port;
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? DESKTOP_LOGIN_CALLBACK_PORT, "127.0.0.1");
  });
  timeoutRef.current = setTimeout(() => {
    rejectAndClose(new Error("DESKTOP_LOGIN_TIMEOUT"));
  }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  return { port, waitForCallback: () => callback, close };
}

export function desktopLoginFunctionUrl(
  runtime: FirebaseRuntime,
  name: "desktopLoginStart" | "desktopLoginRedeem" | "desktopLoginCancel",
): string {
  if (runtime.deployment.mode === "production")
    return `https://${FUNCTION_REGION}-${CODRA_PROJECT_ID}.cloudfunctions.net/${name}`;
  return new URL(
    `/${runtime.deployment.projectId}/${runtime.deployment.functionsRegion}/${name}`,
    runtime.deployment.functionsOrigin,
  ).toString();
}

export function createDesktopLoginGoogleAuthUriRequest(
  runtime: FirebaseRuntime,
  callbackUrl: string,
  state: string,
): DesktopLoginGoogleAuthUriRequest {
  if (runtime.deployment.mode !== "production")
    throw new Error("DESKTOP_GOOGLE_LOGIN_REQUIRES_PRODUCTION");
  const url = new URL("/v1/accounts:createAuthUri", IDENTITY_TOOLKIT_ORIGIN);
  url.searchParams.set("key", runtime.deployment.publicConfig.apiKey);
  return {
    url: url.toString(),
    body: {
      providerId: "google.com",
      continueUri: callbackUrl,
      authFlowType: "CODE_FLOW",
      sessionId: state,
      context: state,
    },
  };
}

export function createDesktopLoginGoogleAuthExchangeRequest(
  requestUri: string,
  sessionId: string,
  code: string,
  state: string,
  callbackPostBody?: string,
): DesktopLoginGoogleAuthExchangeRequest {
  const postBody =
    callbackPostBody ?? new URLSearchParams({ code, state }).toString();
  return {
    requestUri,
    postBody,
    sessionId,
    returnSecureToken: true,
    returnIdpCredential: true,
  };
}

function parseGoogleAuthUriResponse(payload: unknown, state: string): string {
  if (!payload || typeof payload !== "object")
    throw new Error("DESKTOP_GOOGLE_AUTH_URI_INVALID");
  const authUri = (payload as { authUri?: unknown }).authUri;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  if (typeof authUri !== "string" || typeof sessionId !== "string")
    throw new Error("DESKTOP_GOOGLE_AUTH_URI_INVALID");
  if (sessionId !== state)
    throw new Error("DESKTOP_GOOGLE_AUTH_SESSION_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(authUri);
  } catch {
    throw new Error("DESKTOP_GOOGLE_AUTH_URI_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com")
    throw new Error("DESKTOP_GOOGLE_AUTH_URI_INVALID");
  return parsed.toString();
}

async function createDesktopLoginGoogleAuthUri(
  runtime: FirebaseRuntime,
  dependencies: DesktopLoginDependencies,
  callbackUrl: string,
  state: string,
  signal?: AbortSignal,
): Promise<string> {
  const request = createDesktopLoginGoogleAuthUriRequest(
    runtime,
    callbackUrl,
    state,
  );
  const response = await postDesktopLoginJson(
    dependencies,
    request.url,
    request.body,
    signal,
  );
  return parseGoogleAuthUriResponse(response, state);
}

async function completeDesktopLoginGoogleAuth(
  runtime: FirebaseRuntime,
  dependencies: DesktopLoginDependencies,
  callbackUrl: string,
  sessionId: string,
  code: string,
  state: string,
  callbackPostBody: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL("/v1/accounts:signInWithIdp", IDENTITY_TOOLKIT_ORIGIN);
  if (runtime.deployment.mode !== "production")
    throw new Error("DESKTOP_GOOGLE_LOGIN_REQUIRES_PRODUCTION");
  url.searchParams.set("key", runtime.deployment.publicConfig.apiKey);
  const response = await postDesktopLoginJson(
    dependencies,
    url.toString(),
    createDesktopLoginGoogleAuthExchangeRequest(
      callbackUrl,
      sessionId,
      code,
      state,
      callbackPostBody,
    ),
    signal,
  );
  if (!response || typeof response !== "object")
    throw new Error("DESKTOP_GOOGLE_AUTH_EXCHANGE_INVALID");
  const oauthIdToken = (response as { oauthIdToken?: unknown }).oauthIdToken;
  if (typeof oauthIdToken !== "string" || oauthIdToken.length === 0)
    throw new Error("DESKTOP_GOOGLE_ID_TOKEN_MISSING");
  await signInWithCredential(
    runtime.auth,
    GoogleAuthProvider.credential(oauthIdToken),
  );
}

async function postDesktopLoginJson(
  dependencies: DesktopLoginDependencies,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await dependencies.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = desktopLoginResponseErrorMessage(payload);
    if (
      typeof message === "string" &&
      message.toLowerCase().includes("api key not valid")
    ) {
      throw new Error("FIREBASE_API_KEY_INVALID");
    }
    throw new Error(
      desktopLoginResponseErrorCode(payload) ??
        "DESKTOP_LOGIN_FUNCTION_REQUEST_FAILED",
    );
  }
  return payload;
}

function desktopLoginResponseErrorMessage(
  payload: unknown,
): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

const DESKTOP_LOGIN_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/u;

export function desktopLoginResponseErrorCode(
  payload: unknown,
): string | undefined {
  const message = desktopLoginResponseErrorMessage(payload)?.trim();
  return message && DESKTOP_LOGIN_ERROR_CODE_PATTERN.test(message)
    ? message
    : undefined;
}

async function cancelDesktopLogin(
  runtime: FirebaseRuntime,
  dependencies: DesktopLoginDependencies,
  attemptId: string,
  state: string,
): Promise<void> {
  const abort = new AbortController();
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      postDesktopLoginJson(
        dependencies,
        desktopLoginFunctionUrl(runtime, "desktopLoginCancel"),
        { attemptId, state },
        abort.signal,
      ),
      new Promise<void>((resolve) => {
        cancelTimer = setTimeout(() => {
          abort.abort();
          resolve();
        }, CANCEL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // The original bounded error is more useful than a best-effort cancel
    // failure, and transactions still have a server-enforced expiry.
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
  }
}

export async function bootstrapProductionDesktopAuth(
  runtime: FirebaseRuntime,
  overrides: Partial<DesktopLoginDependencies> = {},
  externalSignal?: AbortSignal,
): Promise<void> {
  if (runtime.deployment.mode !== "production")
    throw new Error("DESKTOP_GOOGLE_LOGIN_REQUIRES_PRODUCTION");
  const dependencies = { ...desktopLoginDefaults, ...overrides };
  const attemptId = dependencies.randomUUID();
  const state = createPkceVerifier(dependencies.randomBytes(32));
  let listener: DesktopLoginCallbackListener | undefined;
  const abort = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  void deadline.catch(() => undefined);
  const deadlineTimer = setTimeout(() => {
    abort.abort();
    rejectDeadline(new Error("DESKTOP_LOGIN_TIMEOUT"));
  }, dependencies.timeoutMs);
  const cancelLogin = (): void => {
    abort.abort();
    rejectDeadline(new Error("DESKTOP_LOGIN_CANCELLED"));
  };
  if (externalSignal?.aborted) cancelLogin();
  else externalSignal?.addEventListener("abort", cancelLogin, { once: true });
  const bounded = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([work, deadline]);
  try {
    listener = await bounded(
      createDesktopLoginCallbackListener({
        attemptId,
        state,
        timeoutMs: dependencies.timeoutMs,
      }),
    );
    const callbackUrl = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
    const googleAuthUri = await bounded(
      createDesktopLoginGoogleAuthUri(
        runtime,
        dependencies,
        callbackUrl,
        state,
        abort.signal,
      ),
    );
    await bounded(
      dependencies.openExternal(googleAuthUri, callbackUrl, abort.signal),
    );
    const callback = await bounded(listener.waitForCallback());
    await bounded(
      completeDesktopLoginGoogleAuth(
        runtime,
        dependencies,
        callbackUrl,
        state,
        callback.code,
        callback.state,
        callback.postBody,
        abort.signal,
      ),
    );
  } finally {
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener("abort", cancelLogin);
    await listener?.close();
  }
}

export async function bootstrapProductionDesktopLogin(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
  overrides: Partial<DesktopLoginDependencies> = {},
): Promise<DesktopLoginBootstrapResult> {
  const dependencies = { ...desktopLoginDefaults, ...overrides };
  const useExistingAuth = options.useExistingAuth === true;
  if (useExistingAuth && !runtime.auth.currentUser)
    throw new Error("REMOTE_AUTH_REQUIRED");
  const attemptId = dependencies.randomUUID();
  const state = createPkceVerifier(dependencies.randomBytes(32));
  const verifier = createPkceVerifier(dependencies.randomBytes(32));
  const nonce = createPkceVerifier(dependencies.randomBytes(32));
  let listener: DesktopLoginCallbackListener | undefined;
  let callbackResult:
    Promise<{ value: DesktopLoginCallback } | { error: unknown }> | undefined;
  let cancelEligible = false;
  let completed = false;
  const abort = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  // The deadline remains rejected after it wins one race; attach a handler so
  // a timeout between sequential boundary calls is never an unhandled promise.
  void deadline.catch(() => undefined);
  const deadlineTimer = setTimeout(() => {
    abort.abort();
    rejectDeadline(new Error("DESKTOP_LOGIN_TIMEOUT"));
  }, dependencies.timeoutMs);
  const bounded = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([work, deadline]);
  try {
    if (!useExistingAuth) {
      listener = await bounded(
        createDesktopLoginCallbackListener({
          attemptId,
          state,
          timeoutMs: dependencies.timeoutMs,
        }),
      );
      callbackResult = listener.waitForCallback().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    }
    const callbackPort = listener?.port ?? DESKTOP_LOGIN_CALLBACK_PORT;
    const unsignedStart = {
      attemptId,
      action: options.action,
      deviceId: options.identity.deviceId,
      displayName: "CODRA host",
      publicKeyJwk: options.identity.publicKeyJwk,
      keyThumbprint: options.identity.keyThumbprint,
      pkceChallenge: createPkceChallenge(verifier),
      stateHash: sha256Base64Url(state),
      nonce,
      callbackPort,
      callbackPath: CALLBACK_PATH,
      startSignature: PLACEHOLDER_SIGNATURE,
    };
    const startSignature = await signCanonicalPayload(
      options.identity.privateKey,
      buildDesktopLoginStartSigningPayload(unsignedStart),
    );
    const start = { ...unsignedStart, startSignature };
    // A lost or malformed start response may still have created the server
    // transaction, so cancellation must be attempted from this point onward.
    cancelEligible = true;
    const startResponse = await bounded(
      postDesktopLoginJson(
        dependencies,
        desktopLoginFunctionUrl(runtime, "desktopLoginStart"),
        start,
        abort.signal,
      ),
    );
    const serverNonce =
      startResponse && typeof startResponse === "object"
        ? (startResponse as { serverNonce?: unknown }).serverNonce
        : undefined;
    if (serverNonce !== nonce) throw new Error("DESKTOP_LOGIN_START_INVALID");
    let callback: DesktopLoginCallback | undefined;
    if (!useExistingAuth) {
      const callbackUrl = new URL(
        `http://127.0.0.1:${listener!.port}${CALLBACK_PATH}`,
      );
      const googleAuthUri = await bounded(
        createDesktopLoginGoogleAuthUri(
          runtime,
          dependencies,
          callbackUrl.toString(),
          state,
          abort.signal,
        ),
      );
      await bounded(
        dependencies.openExternal(
          googleAuthUri,
          callbackUrl.toString(),
          abort.signal,
        ),
      );
      const callbackOutcome = await bounded(callbackResult!);
      if ("error" in callbackOutcome) throw callbackOutcome.error;
      callback = callbackOutcome.value;
      await bounded(
        completeDesktopLoginGoogleAuth(
          runtime,
          dependencies,
          callbackUrl.toString(),
          state,
          callback.code,
          callback.state,
          callback.postBody,
          abort.signal,
        ),
      );
    }
    const authorize = httpsCallable(runtime.functions, "authorizeDesktopLogin");
    const authorization = DesktopLoginAllowResponseSchema.parse(
      (
        await bounded(
          authorize({
            action: "allow",
            attemptId: callback?.attemptId ?? attemptId,
            state,
          }),
        )
      ).data,
    );
    const authorizedAttemptId = callback?.attemptId ?? attemptId;
    const unsignedRedeem = {
      attemptId: authorizedAttemptId,
      code: authorization.code,
      state: authorization.state,
      nonce,
      pkceVerifier: verifier,
      deviceSignature: PLACEHOLDER_SIGNATURE,
    };
    const deviceSignature = await signCanonicalPayload(
      options.identity.privateKey,
      createDesktopLoginDeviceSignaturePayload({
        attemptId: authorizedAttemptId,
        code: authorization.code,
        state: authorization.state,
        nonce,
        deviceId: options.identity.deviceId,
        keyThumbprint: options.identity.keyThumbprint,
      }),
    );
    const result = DesktopLoginRedeemResponseSchema.parse(
      await bounded(
        postDesktopLoginJson(
          dependencies,
          desktopLoginFunctionUrl(runtime, "desktopLoginRedeem"),
          { ...unsignedRedeem, deviceSignature },
          abort.signal,
        ),
      ),
    );
    completed = true;
    return result;
  } finally {
    clearTimeout(deadlineTimer);
    await listener?.close();
    if (cancelEligible && !completed)
      await cancelDesktopLogin(runtime, dependencies, attemptId, state);
  }
}

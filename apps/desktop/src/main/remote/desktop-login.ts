import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { FirebaseRuntime } from "@codra/firebase";
import {
  CODRA_PROJECT_ID,
  FUNCTION_REGION,
  DesktopLoginRedeemResponseSchema,
  PkceVerifierSchema,
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
const BRIDGE_URL = "https://codra-1b3bb.firebaseapp.com/desktop-auth";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
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
}

export interface DesktopLoginCallback {
  attemptId: string;
  code: string;
  state: string;
}

export interface DesktopLoginCallbackListener {
  port: number;
  waitForCallback(): Promise<DesktopLoginCallback>;
  close(): Promise<void>;
}

export interface DesktopLoginDependencies {
  fetch(input: string, init: RequestInit): Promise<Response>;
  openExternal(url: string): Promise<void>;
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
 * the Hosting bridge is allowed to complete a local sign-in attempt.
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
  const expectedKeys = ["attempt", "code", "state"];
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => url.searchParams.getAll(key).length !== 1)
  ) {
    return undefined;
  }
  const attemptId = url.searchParams.get("attempt");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (
    attemptId !== expected.attemptId ||
    state !== expected.state ||
    typeof code !== "string" ||
    !PkceVerifierSchema.safeParse(code).success
  ) {
    return undefined;
  }
  return { attemptId, code, state };
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
}): Promise<DesktopLoginCallbackListener> {
  const sockets = new Set<Socket>();
  let port = 0;
  let settled = false;
  let closePromise: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
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
    if (timeout) clearTimeout(timeout);
    if (!closePromise) closePromise = closeServer(server, sockets);
    await closePromise;
  };
  const rejectAndClose = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
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
    if (timeout) clearTimeout(timeout);
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
    server.listen(0, "127.0.0.1");
  });
  timeout = setTimeout(() => {
    rejectAndClose(new Error("DESKTOP_LOGIN_TIMEOUT"));
  }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  return { port, waitForCallback: () => callback, close };
}

export function createDesktopLoginBridgeUrl(
  attemptId: string,
  state: string,
): string {
  const url = new URL(BRIDGE_URL);
  url.searchParams.set("attempt", attemptId);
  url.searchParams.set("state", state);
  return url.toString();
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

async function postDesktopLoginJson(
  dependencies: DesktopLoginDependencies,
  url: string,
  body: unknown,
): Promise<unknown> {
  const response = await dependencies.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error("DESKTOP_LOGIN_FUNCTION_REQUEST_FAILED");
  return payload;
}

async function cancelDesktopLogin(
  runtime: FirebaseRuntime,
  dependencies: DesktopLoginDependencies,
  attemptId: string,
  state: string,
): Promise<void> {
  try {
    await postDesktopLoginJson(
      dependencies,
      desktopLoginFunctionUrl(runtime, "desktopLoginCancel"),
      { attemptId, state },
    );
  } catch {
    // The original bounded error is more useful than a best-effort cancel
    // failure, and transactions still have a server-enforced expiry.
  }
}

export async function bootstrapProductionDesktopLogin(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
  overrides: Partial<DesktopLoginDependencies> = {},
): Promise<DesktopLoginBootstrapResult> {
  const dependencies = { ...desktopLoginDefaults, ...overrides };
  const attemptId = dependencies.randomUUID();
  const state = createPkceVerifier(dependencies.randomBytes(32));
  const verifier = createPkceVerifier(dependencies.randomBytes(32));
  const nonce = createPkceVerifier(dependencies.randomBytes(32));
  let listener: DesktopLoginCallbackListener | undefined;
  let callbackResult:
    | Promise<{ value: DesktopLoginCallback } | { error: unknown }>
    | undefined;
  let started = false;
  let completed = false;
  try {
    listener = await createDesktopLoginCallbackListener({
      attemptId,
      state,
      timeoutMs: dependencies.timeoutMs,
    });
    callbackResult = listener.waitForCallback().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
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
      callbackPort: listener.port,
      callbackPath: CALLBACK_PATH,
      startSignature: PLACEHOLDER_SIGNATURE,
    };
    const startSignature = await signCanonicalPayload(
      options.identity.privateKey,
      buildDesktopLoginStartSigningPayload(unsignedStart),
    );
    const start = { ...unsignedStart, startSignature };
    const startResponse = await postDesktopLoginJson(
      dependencies,
      desktopLoginFunctionUrl(runtime, "desktopLoginStart"),
      start,
    );
    const serverNonce =
      startResponse && typeof startResponse === "object"
        ? (startResponse as { serverNonce?: unknown }).serverNonce
        : undefined;
    if (serverNonce !== nonce) throw new Error("DESKTOP_LOGIN_START_INVALID");
    started = true;
    await dependencies.openExternal(createDesktopLoginBridgeUrl(attemptId, state));
    const callbackOutcome = await callbackResult;
    if ("error" in callbackOutcome) throw callbackOutcome.error;
    const callback = callbackOutcome.value;
    const unsignedRedeem = {
      attemptId: callback.attemptId,
      code: callback.code,
      state: callback.state,
      nonce,
      pkceVerifier: verifier,
      deviceSignature: PLACEHOLDER_SIGNATURE,
    };
    const deviceSignature = await signCanonicalPayload(
      options.identity.privateKey,
      buildDesktopLoginRedeemSigningPayload({
        ...unsignedRedeem,
        deviceId: options.identity.deviceId,
        keyThumbprint: options.identity.keyThumbprint,
      }),
    );
    const result = DesktopLoginRedeemResponseSchema.parse(
      await postDesktopLoginJson(
        dependencies,
        desktopLoginFunctionUrl(runtime, "desktopLoginRedeem"),
        { ...unsignedRedeem, deviceSignature },
      ),
    );
    completed = true;
    return result;
  } finally {
    await listener?.close();
    if (started && !completed)
      await cancelDesktopLogin(runtime, dependencies, attemptId, state);
  }
}

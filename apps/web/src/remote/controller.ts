import {
  createRemoteSession,
  listHostDevices,
  registerDevice,
} from "@codra/firebase";
import type { FirebaseRuntime } from "@codra/firebase";
import {
  P256SignatureSchema,
  REMOTE_SESSION_MAX_LEASE_MS,
  RemoteDeviceSchema,
  RemoteSessionSchema,
  buildSessionRequestSigningPayload,
  encodeBase64Url,
  type RemoteDevice,
  type RemoteSession,
  type SessionRequest,
} from "@codra/protocol";
import {
  getIdTokenResult,
  signInWithCustomToken,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { bootstrapRemoteAccount } from "@codra/web-account-bootstrap";
import { createRemoteFirebaseRuntime } from "@codra/web-firebase-config";
import {
  bindBrowserDeviceOwner,
  loadOrCreateBrowserDeviceIdentity,
  type BrowserDeviceIdentity,
} from "./device-identity";
import { signCanonical } from "@codra/webrtc";

/**
 * The scope set a browser console session actually needs, identical to the one
 * the desktop client requests (`REMOTE_AGENT_SCOPES`,
 * `apps/desktop/src/main/remote/host-control-gateway.ts:35-43`).
 *
 * `terminal.attach` on its own can never produce a working terminal: the host
 * only permits an attach to a terminal in that client's `owned` set, and
 * ownership is granted exclusively by `agent.launch` or `terminal.create`
 * (`host-control-gateway.ts:439`, `:469`). The console launches its own agent,
 * so `agent.launch` — together with the `workspace.read` and `agent.runtimes`
 * needed to choose a directory and a runtime first — is what makes the attach
 * legal.
 *
 * `terminal.list` and `terminal.create` are deliberately absent. Neither has an
 * entry in `SCOPE_LABELS`
 * (`apps/desktop/src/renderer/src/remote/SessionApprovalDialog.tsx:7-15`), so
 * requesting either would show the host user a raw scope string in the modal
 * where they consent. `terminal.list` would also expose terminals this client
 * may never attach to (`host-control-gateway.ts:449-462`).
 */
const DEFAULT_SCOPES = [
  "workspace.read",
  "agent.runtimes",
  "agent.launch",
  "terminal.write",
  "terminal.resize",
  "terminal.detach",
  "terminal.attach",
] as const;

const MIN_SESSION_LEASE_MS = 1_000;
const DEFAULT_SESSION_LEASE_MS = 30 * 60 * 1000;

/**
 * Far below `REMOTE_SESSION_MAX_LEASE_MS` (8 h), and deliberately so.
 *
 * `publishSignal` clamps every signal's `expiresAt` to
 * `min(input, now + 3_600_000)` and only *then* verifies a signature that
 * covers `expiresAtMillis` (`functions/src/index.ts:489-504`), so a lease at or
 * beyond one hour is rewritten out from under its own signature and comes back
 * as `SIGNAL_SIGNATURE_INVALID`. `SignedSignalTransport` bounds each signal to
 * `min(session.expiresAt, createdAt + SIGNAL_LEASE_MS)`, which means the
 * session lease is what decides whether the clamp ever bites.
 *
 * The boundary is sharper than "beyond one hour": the clamp uses the *server's*
 * `now` while the transport signs against the *client's* `createdAt`, so at
 * exactly one hour a single millisecond of client-ahead clock skew breaks every
 * signal. 45 minutes leaves a margin no plausible skew crosses. Raising this
 * without first signing a skew-adjusted lease breaks signalling outright.
 */
const MAX_SESSION_LEASE_MS = Math.min(
  45 * 60 * 1000,
  REMOTE_SESSION_MAX_LEASE_MS,
);

export interface BrowserRemoteState {
  runtime: FirebaseRuntime;
  identity: BrowserDeviceIdentity;
  device: RemoteDevice;
  account: {
    uid: string;
    email: string | null;
    displayName: string | null;
  };
}

export class BrowserRemoteController {
  private state: BrowserRemoteState | undefined;
  private runtime: FirebaseRuntime | undefined;

  async connect(): Promise<BrowserRemoteState> {
    if (this.state) return this.state;
    const runtime = createRemoteFirebaseRuntime();
    this.runtime = runtime;
    const currentUser = runtime.auth.currentUser;
    let account = currentUser;
    if (currentUser) {
      const token = await getIdTokenResult(currentUser);
      const acceptedProvider =
        token.signInProvider === "google.com" ||
        (runtime.deployment.mode === "emulator" &&
          token.signInProvider === "password");
      if (!acceptedProvider) {
        await firebaseSignOut(runtime.auth);
        account = null;
      }
    }
    account ??= (await bootstrapRemoteAccount(runtime)).user;
    const identity = await bindBrowserDeviceOwner(
      await loadOrCreateBrowserDeviceIdentity(),
      account.uid,
    );
    const registered = await registerDevice(runtime.functions, {
      action: identity.created ? "register" : "resume",
      deviceId: identity.deviceId,
      kind: "browser",
      displayName: "CODRA browser",
      publicKeyJwk: identity.publicKeyJwk,
      keyThumbprint: identity.keyThumbprint,
      capabilities: ["webrtc", "turn-udp"],
      remoteAccessEnabled: true,
    });
    await signInWithCustomToken(runtime.auth, registered.token);
    const device = RemoteDeviceSchema.parse(registered.device);
    this.state = {
      runtime,
      identity,
      device,
      account: {
        uid: account.uid,
        email: account.email,
        displayName: account.displayName,
      },
    };
    return this.state;
  }

  async listHosts(): Promise<RemoteDevice[]> {
    const state = await this.connect();
    return listHostDevices(state.runtime.functions);
  }

  async requestSession(
    host: RemoteDevice,
    options: { scopes?: readonly string[]; leaseMs?: number } = {},
  ): Promise<RemoteSession> {
    const state = await this.connect();
    const scopes = [...(options.scopes ?? DEFAULT_SCOPES)];
    const leaseMs = Math.min(
      Math.max(
        options.leaseMs ?? DEFAULT_SESSION_LEASE_MS,
        MIN_SESSION_LEASE_MS,
      ),
      MAX_SESSION_LEASE_MS,
    );
    const sessionId = crypto.randomUUID();
    const clientChallenge = crypto.randomUUID();
    const expiresAt = Date.now() + leaseMs;
    const unsigned: SessionRequest = {
      sessionId,
      ownerUid:
        state.device.ownerUid ?? state.runtime.auth.currentUser?.uid ?? "",
      clientDeviceId: state.identity.deviceId,
      hostDeviceId: host.deviceId,
      clientKeyThumbprint: state.identity.keyThumbprint,
      hostKeyThumbprint: host.keyThumbprint,
      clientDeviceGeneration: state.device.generation,
      hostDeviceGeneration: host.generation,
      protocolVersion: 1,
      requestedScopes: scopes,
      clientChallenge,
      requestSignature: P256SignatureSchema.parse(
        encodeBase64Url(new Uint8Array(64)),
      ),
      createdAt: Date.now(),
      expiresAt,
    };
    const requestSignature = await signCanonical(
      state.identity.privateKey,
      buildSessionRequestSigningPayload(unsigned),
    );
    const result = await createRemoteSession(state.runtime.functions, {
      sessionId,
      hostDeviceId: host.deviceId,
      hostKeyThumbprint: host.keyThumbprint,
      hostDeviceGeneration: host.generation,
      protocolVersion: 1,
      requestedScopes: scopes,
      clientChallenge,
      requestSignature,
      expiresAt,
    });
    return RemoteSessionSchema.parse(result);
  }

  disconnect(): void {
    this.state = undefined;
  }

  async signOut(): Promise<void> {
    const auth = this.state?.runtime.auth ?? this.runtime?.auth;
    this.state = undefined;
    this.runtime = undefined;
    if (auth) await firebaseSignOut(auth);
  }
}

export { DEFAULT_SCOPES, DEFAULT_SESSION_LEASE_MS, MAX_SESSION_LEASE_MS };

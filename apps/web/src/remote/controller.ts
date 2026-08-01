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

const DEFAULT_SCOPES = [
  "terminal.list",
  "terminal.attach",
  "terminal.write",
  "terminal.resize",
];

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
      Math.max(options.leaseMs ?? 30 * 60 * 1000, 1_000),
      REMOTE_SESSION_MAX_LEASE_MS,
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

export { DEFAULT_SCOPES };

import { httpsCallable } from "firebase/functions";
import type { FirebaseRuntime } from "@codra/firebase";
import {
  approveRemoteSession,
  rejectRemoteSession,
  registerDevice,
  subscribePendingSessions,
} from "@codra/firebase";
import {
  RemoteDeviceSchema,
  signCanonicalPayload,
  type RemoteSession,
} from "@codra/protocol";
import { signInWithCustomToken } from "firebase/auth";
import { loadOrCreateHostIdentity, type HostIdentity } from "./host-identity";
import { bootstrapRemoteAccount } from "@codra/remote-account-bootstrap";
import { createRemoteFirebaseRuntime } from "@codra/remote-firebase-config";

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface RemoteHostControllerOptions {
  userDataPath: string;
  reportError(error: unknown): void;
  onPendingSession?(session: RemoteSession): void;
}

export class RemoteHostController {
  private runtime: FirebaseRuntime | undefined;
  private identity: HostIdentity | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopRequested = false;
  private unsubscribePending: (() => void) | undefined;
  private readonly promptedSessions = new Set<string>();

  constructor(private readonly options: RemoteHostControllerOptions) {}

  async start(): Promise<void> {
    if (process.env.CODRA_ENABLE_REMOTE !== "1") return;
    if (this.startPromise) return this.startPromise;
    if (this.runtime) return;
    this.stopRequested = false;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.unsubscribePending?.();
    this.unsubscribePending = undefined;
    this.promptedSessions.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.runtime = undefined;
    this.identity = undefined;
  }

  private async startInternal(): Promise<void> {
    const runtime = createRemoteFirebaseRuntime();
    try {
      await bootstrapRemoteAccount(runtime);
      const identity = await loadOrCreateHostIdentity(
        this.options.userDataPath,
      );
      const registered = await registerDevice(runtime.functions, {
        action: identity.created ? "register" : "resume",
        deviceId: identity.deviceId,
        kind: "host",
        displayName: "CODRA host",
        publicKeyJwk: identity.publicKeyJwk,
        keyThumbprint: identity.keyThumbprint,
        capabilities: ["terminal", "webrtc", "turn-udp"],
        remoteAccessEnabled: true,
      });
      await signInWithCustomToken(runtime.auth, registered.token);
      const device = RemoteDeviceSchema.parse(registered.device);
      if (this.stopRequested) return;
      this.runtime = runtime;
      this.identity = identity;
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeat().catch((error) => this.options.reportError(error));
      }, HEARTBEAT_INTERVAL_MS);
      await this.heartbeat();
      this.unsubscribePending = subscribePendingSessions({
        firestore: runtime.firestore,
        uid: runtime.auth.currentUser?.uid ?? "",
        deviceId: identity.deviceId,
        keyThumbprint: identity.keyThumbprint,
        generation: device.generation,
        onChange: (sessions) => {
          for (const session of sessions) {
            if (this.promptedSessions.has(session.sessionId)) continue;
            this.promptedSessions.add(session.sessionId);
            this.options.onPendingSession?.(session);
          }
        },
        onError: (error) => this.options.reportError(error),
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async approveSession(
    session: RemoteSession,
    approvedScopes = session.requestedScopes,
  ): Promise<RemoteSession> {
    if (!this.runtime || !this.identity)
      throw new Error("REMOTE_HOST_NOT_STARTED");
    const hostChallenge = crypto.randomUUID();
    const approval = {
      domain: "codra.session-approval.v1" as const,
      protocolVersion: session.protocolVersion,
      sessionId: session.sessionId,
      clientDeviceId: session.clientDeviceId,
      hostDeviceId: session.hostDeviceId,
      clientKeyThumbprint: session.clientKeyThumbprint,
      hostKeyThumbprint: session.hostKeyThumbprint,
      clientDeviceGeneration: session.clientDeviceGeneration,
      hostDeviceGeneration: session.hostDeviceGeneration,
      requestedScopes: session.requestedScopes,
      approvedScopes,
      clientChallenge: session.clientChallenge,
      hostChallenge,
      expiresAtMillis: session.expiresAt,
      signature: "",
    };
    const { signature: unsignedSignature, ...unsignedApproval } = approval;
    void unsignedSignature;
    const signature = await signCanonicalPayload(
      this.identity.privateKey,
      unsignedApproval,
    );
    const result = await approveRemoteSession(this.runtime.functions, {
      sessionId: session.sessionId,
      approvedScopes,
      hostChallenge,
      approvalSignature: signature,
    });
    this.promptedSessions.delete(session.sessionId);
    return result;
  }

  async rejectSession(
    session: RemoteSession,
    rejectionReason:
      "USER_REJECTED" | "HOST_BUSY" | "HOST_DISABLED" = "USER_REJECTED",
  ): Promise<RemoteSession> {
    if (!this.runtime || !this.identity)
      throw new Error("REMOTE_HOST_NOT_STARTED");
    const rejection = {
      domain: "codra.session-rejection.v1" as const,
      protocolVersion: session.protocolVersion,
      sessionId: session.sessionId,
      ownerUid: session.ownerUid,
      clientDeviceId: session.clientDeviceId,
      hostDeviceId: session.hostDeviceId,
      clientKeyThumbprint: session.clientKeyThumbprint,
      hostKeyThumbprint: session.hostKeyThumbprint,
      clientDeviceGeneration: session.clientDeviceGeneration,
      hostDeviceGeneration: session.hostDeviceGeneration,
      requestedScopes: session.requestedScopes,
      clientChallenge: session.clientChallenge,
      rejectionReason,
      expiresAtMillis: session.expiresAt,
      signature: "",
    };
    const { signature: unsignedSignature, ...unsignedRejection } = rejection;
    void unsignedSignature;
    const signature = await signCanonicalPayload(
      this.identity.privateKey,
      unsignedRejection,
    );
    const result = await rejectRemoteSession(this.runtime.functions, {
      sessionId: session.sessionId,
      rejectionReason,
      rejectionSignature: signature,
    });
    this.promptedSessions.delete(session.sessionId);
    return result;
  }

  private async heartbeat(): Promise<void> {
    if (!this.runtime || !this.identity) return;
    const call = httpsCallable(this.runtime.functions, "heartbeatDevice");
    await call({});
  }
}

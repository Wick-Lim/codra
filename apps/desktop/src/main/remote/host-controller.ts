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
  type RemoteHostStatus,
  type RemoteSession,
} from "@codra/protocol";
import { signInWithCustomToken } from "firebase/auth";
import { loadOrCreateHostIdentity, type HostIdentity } from "./host-identity";
import { bootstrapRemoteAccount } from "@codra/remote-account-bootstrap";
import { createRemoteFirebaseRuntime } from "@codra/remote-firebase-config";
import { isRemoteStartRequested, remoteErrorStatus } from "./remote-state";

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
  private status: RemoteHostStatus = { state: "idle" };
  private readonly statusListeners = new Set<
    (status: RemoteHostStatus) => void
  >();

  constructor(private readonly options: RemoteHostControllerOptions) {}

  getStatus(): RemoteHostStatus {
    return this.status;
  }

  onStatusChanged(listener: (status: RemoteHostStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async login(): Promise<RemoteHostStatus> {
    await this.start(true);
    return this.status;
  }

  async start(force = false): Promise<void> {
    if (
      !isRemoteStartRequested({
        force,
        envValue: process.env.CODRA_ENABLE_REMOTE,
      })
    )
      return;
    if (this.startPromise) return this.startPromise;
    if (this.runtime) return;
    this.stopRequested = false;
    this.publishStatus({ state: "signing_in" });
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } catch (error) {
      this.publishStatus(remoteErrorStatus(error));
      throw error;
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
    this.publishStatus({ state: "idle" });
  }

  private publishStatus(status: RemoteHostStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Status observers cannot affect the host lifecycle.
      }
    }
  }

  private async startInternal(): Promise<void> {
    const runtime = createRemoteFirebaseRuntime();
    try {
      const identity = await loadOrCreateHostIdentity(
        this.options.userDataPath,
      );
      const action = identity.created ? "register" : "resume";
      const login = await bootstrapRemoteAccount(runtime, { identity, action });
      let device;
      if (login) {
        await signInWithCustomToken(runtime.auth, login.token);
        device = RemoteDeviceSchema.parse(login.device);
      } else {
        const registered = await registerDevice(runtime.functions, {
          action,
          deviceId: identity.deviceId,
          kind: "host",
          displayName: "CODRA host",
          publicKeyJwk: identity.publicKeyJwk,
          keyThumbprint: identity.keyThumbprint,
          capabilities: ["terminal", "webrtc", "turn-udp"],
          remoteAccessEnabled: true,
        });
        await signInWithCustomToken(runtime.auth, registered.token);
        device = RemoteDeviceSchema.parse(registered.device);
      }
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
      this.publishStatus({ state: "online" });
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

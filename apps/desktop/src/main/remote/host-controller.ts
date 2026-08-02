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
  type RemoteAccountStatus,
  type RemoteAuthProvider,
  type RemoteHostStatus,
  type RemoteSession,
} from "@codra/protocol";
import { signInWithCustomToken, signOut } from "firebase/auth";
import { loadOrCreateHostIdentity, type HostIdentity } from "./host-identity";
import {
  bootstrapRemoteAccount,
  bootstrapRemoteAuth,
} from "@codra/remote-account-bootstrap";
import { createRemoteFirebaseRuntime } from "@codra/remote-firebase-config";
import { remoteAccountErrorStatus, remoteErrorStatus } from "./remote-state";
import { shouldRetryDesktopLoginAsRegister } from "./desktop-login";

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface RemoteHostControllerOptions {
  userDataPath: string;
  reportError(error: unknown): void;
  onPendingSession?(session: RemoteSession): void;
}

export class RemoteHostController {
  private runtime: FirebaseRuntime | undefined;
  private deviceRuntime: FirebaseRuntime | undefined;
  private identity: HostIdentity | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private startPromise: Promise<void> | undefined;
  private authPromise: Promise<void> | undefined;
  private stopRequested = false;
  private unsubscribePending: (() => void) | undefined;
  private readonly promptedSessions = new Set<string>();
  private status: RemoteHostStatus = { state: "idle" };
  private accountStatus: RemoteAccountStatus = { state: "signed_out" };
  private readonly statusListeners = new Set<
    (status: RemoteHostStatus) => void
  >();
  private readonly accountStatusListeners = new Set<
    (status: RemoteAccountStatus) => void
  >();

  constructor(private readonly options: RemoteHostControllerOptions) {}

  getStatus(): RemoteHostStatus {
    return this.status;
  }

  getAccountStatus(): RemoteAccountStatus {
    return this.accountStatus;
  }

  onStatusChanged(listener: (status: RemoteHostStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onAccountStatusChanged(
    listener: (status: RemoteAccountStatus) => void,
  ): () => void {
    this.accountStatusListeners.add(listener);
    return () => this.accountStatusListeners.delete(listener);
  }

  async login(provider: RemoteAuthProvider): Promise<RemoteAccountStatus> {
    if (this.accountStatus.state === "signed_in" && this.runtime?.auth.currentUser)
      return this.accountStatus;
    if (this.authPromise) {
      await this.authPromise;
      return this.accountStatus;
    }
    this.publishAccountStatus({ state: "signing_in" });
    this.stopRequested = false;
    this.authPromise = this.loginInternal(provider);
    try {
      await this.authPromise;
      this.publishAccountStatus({ state: "signed_in" });
    } catch (error) {
      this.publishAccountStatus(remoteAccountErrorStatus(error));
      throw error;
    } finally {
      this.authPromise = undefined;
    }
    return this.accountStatus;
  }

  async activate(): Promise<RemoteHostStatus> {
    if (this.status.state === "online") return this.status;
    if (!this.runtime?.auth.currentUser) throw new Error("REMOTE_AUTH_REQUIRED");
    if (this.startPromise) {
      await this.startPromise;
      return this.status;
    }
    this.stopRequested = false;
    this.publishStatus({ state: "activating" });
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } catch (error) {
      this.publishStatus(remoteErrorStatus(error));
      throw error;
    } finally {
      this.startPromise = undefined;
    }
    return this.status;
  }

  async deactivate(): Promise<RemoteHostStatus> {
    this.stopRequested = true;
    await this.stopHostResources();
    return this.status;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.stopHostResources();
    if (this.runtime?.auth.currentUser)
      await signOut(this.runtime.auth).catch(() => undefined);
    this.runtime = undefined;
    this.identity = undefined;
    this.publishAccountStatus({ state: "signed_out" });
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

  private publishAccountStatus(status: RemoteAccountStatus): void {
    this.accountStatus = status;
    for (const listener of this.accountStatusListeners) {
      try {
        listener(status);
      } catch {
        // Account observers cannot affect authentication.
      }
    }
  }

  private async loginInternal(provider: RemoteAuthProvider): Promise<void> {
    const runtime = this.runtime ?? createRemoteFirebaseRuntime();
    await bootstrapRemoteAuth(runtime, provider);
    this.runtime = runtime;
  }

  private async stopHostResources(): Promise<void> {
    this.unsubscribePending?.();
    this.unsubscribePending = undefined;
    this.promptedSessions.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.deviceRuntime?.auth.currentUser)
      await signOut(this.deviceRuntime.auth).catch(() => undefined);
    this.deviceRuntime = undefined;
    this.publishStatus({ state: "idle" });
  }

  private async startInternal(): Promise<void> {
    const accountRuntime = this.runtime;
    if (!accountRuntime?.auth.currentUser)
      throw new Error("REMOTE_AUTH_REQUIRED");
    const deviceRuntime =
      this.deviceRuntime ?? createRemoteFirebaseRuntime("codra-host-device");
    try {
      const identity = await loadOrCreateHostIdentity(
        this.options.userDataPath,
      );
      const action = identity.created ? "register" : "resume";
      let login;
      try {
        login = await bootstrapRemoteAccount(accountRuntime, {
          identity,
          action,
          useExistingAuth: true,
        });
      } catch (error) {
        // A previous OAuth attempt can persist the local key before its
        // server-side device is created. Recover that interrupted first run
        // by registering the same key instead of requiring manual cleanup.
        if (!shouldRetryDesktopLoginAsRegister(action, error)) throw error;
        login = await bootstrapRemoteAccount(accountRuntime, {
          identity,
          action: "register",
          useExistingAuth: true,
        });
      }
      let device;
      if (login) {
        await signInWithCustomToken(deviceRuntime.auth, login.token);
        device = RemoteDeviceSchema.parse(login.device);
      } else {
        const registered = await registerDevice(accountRuntime.functions, {
          action,
          deviceId: identity.deviceId,
          kind: "host",
          displayName: "CODRA host",
          publicKeyJwk: identity.publicKeyJwk,
          keyThumbprint: identity.keyThumbprint,
          capabilities: ["terminal", "webrtc", "turn-udp"],
          remoteAccessEnabled: true,
        });
        await signInWithCustomToken(deviceRuntime.auth, registered.token);
        device = RemoteDeviceSchema.parse(registered.device);
      }
      if (this.stopRequested) {
        // Activation may finish its network exchange after the user has
        // already disabled the host. Do not leave the short-lived device
        // auth session alive in that race.
        await signOut(deviceRuntime.auth).catch(() => undefined);
        return;
      }
      this.runtime = accountRuntime;
      this.deviceRuntime = deviceRuntime;
      this.identity = identity;
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeat().catch((error) => this.options.reportError(error));
      }, HEARTBEAT_INTERVAL_MS);
      await this.heartbeat();
      this.unsubscribePending = subscribePendingSessions({
        firestore: deviceRuntime.firestore,
        uid: deviceRuntime.auth.currentUser?.uid ?? "",
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
        onError: (error) => {
          this.options.reportError(error);
          this.publishStatus({
            state: "error",
            message: "REMOTE_SESSION_LISTENER_FAILED",
          });
        },
      });
      this.publishStatus({ state: "online" });
    } catch (error) {
      await this.stopHostResources();
      throw error;
    }
  }

  async approveSession(
    session: RemoteSession,
    approvedScopes = session.requestedScopes,
  ): Promise<RemoteSession> {
    if (!this.deviceRuntime || !this.identity)
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
    const result = await approveRemoteSession(this.deviceRuntime.functions, {
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
    if (!this.deviceRuntime || !this.identity)
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
    const result = await rejectRemoteSession(this.deviceRuntime.functions, {
      sessionId: session.sessionId,
      rejectionReason,
      rejectionSignature: signature,
    });
    this.promptedSessions.delete(session.sessionId);
    return result;
  }

  private async heartbeat(): Promise<void> {
    if (!this.deviceRuntime || !this.identity) return;
    const call = httpsCallable(this.deviceRuntime.functions, "heartbeatDevice");
    await call({});
  }
}

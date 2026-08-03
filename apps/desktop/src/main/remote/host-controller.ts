import { hostname } from "node:os";
import { httpsCallable } from "firebase/functions";
import type { FirebaseRuntime } from "@codra/firebase";
import {
  approveRemoteSession,
  listHostDevices as listFirebaseHostDevices,
  rejectRemoteSession,
  registerDevice,
  subscribePendingSessions,
} from "@codra/firebase";
import {
  RemoteDeviceSchema,
  signCanonicalPayload,
  type AgentExecutionTarget,
  type ApproveRemoteSessionRequest,
  type PendingRemoteSession,
  type RejectRemoteSessionRequest,
  type AgentLaunchTarget,
  type AgentRuntime,
  type RemoteAccountStatus,
  type RemoteAgentExecutionTarget,
  type RemoteAuthProvider,
  type RemoteHostStatus,
  type RemoteSession,
  type WorkspaceDirectoryPage,
  type WorkspaceRoot,
  type WorkspaceSelection,
} from "@codra/protocol";
import { signInWithCustomToken, signOut } from "firebase/auth";
import { loadOrCreateHostIdentity, type HostIdentity } from "./host-identity";
import {
  bootstrapRemoteAccount,
  bootstrapRemoteAuth,
} from "@codra/remote-account-bootstrap";
import { createRemoteFirebaseRuntime } from "@codra/remote-firebase-config";
import { installSessionAutoApprove } from "@codra/remote-session-auto-approve";
import {
  remoteAccountErrorStatus,
  remoteErrorStatus,
  remoteSignedInStatus,
} from "./remote-state";
import { shouldRetryDesktopLoginAsRegister } from "./desktop-login";
import type { DesktopAuthParentWindowLike } from "./auth-window";
import type { IceServerInput } from "@codra/webrtc";
import type { PeerConnectionPort } from "@codra/remote-client";
import {
  DesktopPeerConnector,
  type RemoteHostServices,
} from "./desktop-peer-connector";
import {
  RemoteAgentClient,
  type RemoteAgentChannelClient,
} from "@codra/remote-client";
import { resolveDeviceDisplayName } from "./device-name";
import { SessionApprovalRegistry } from "./session-approval";

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface RemoteHostControllerOptions {
  userDataPath: string;
  reportError(error: unknown): void;
  createPeer?(
    peerName: string,
    iceServers: readonly IceServerInput[],
    options: { relayOnly: boolean },
  ): PeerConnectionPort;
  ensureWindow?(): Promise<void>;
}

export class RemoteHostController {
  private runtime: FirebaseRuntime | undefined;
  private deviceRuntime: FirebaseRuntime | undefined;
  private identity: HostIdentity | undefined;
  private connector: DesktopPeerConnector | undefined;
  private hostServices: RemoteHostServices | undefined;
  private readonly remoteClient: RemoteAgentClient;
  private readonly sessionApprovals: SessionApprovalRegistry;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private startPromise: Promise<void> | undefined;
  private authPromise: Promise<void> | undefined;
  private authAbort: AbortController | undefined;
  private authGeneration = 0;
  private stopRequested = false;
  private unsubscribePending: (() => void) | undefined;
  private readonly terminalOwners = new Map<string, Set<string>>();
  private status: RemoteHostStatus = { state: "idle" };
  private accountStatus: RemoteAccountStatus = { state: "signed_out" };
  private readonly statusListeners = new Set<
    (status: RemoteHostStatus) => void
  >();
  private readonly accountStatusListeners = new Set<
    (status: RemoteAccountStatus) => void
  >();

  constructor(private readonly options: RemoteHostControllerOptions) {
    this.remoteClient = new RemoteAgentClient({
      enabled: () =>
        this.status.state === "online" &&
        this.deviceRuntime?.auth.currentUser !== null &&
        this.connector !== undefined,
      currentDeviceId: () => this.identity?.deviceId,
      listDevices: async () => {
        if (!this.deviceRuntime) return [];
        return listFirebaseHostDevices(this.deviceRuntime.functions);
      },
      connect: (device, update) => {
        if (!this.connector) throw new Error("REMOTE_HOST_NOT_STARTED");
        return this.connector.connectClient(
          RemoteDeviceSchema.parse(device),
          update,
        );
      },
    });
    this.sessionApprovals = new SessionApprovalRegistry({
      approve: async (session, approvedScopes) => {
        await this.signSessionApproval(session, [...approvedScopes]);
      },
      reject: async (session) => {
        await this.signSessionRejection(session);
      },
      resolveRequesterName: (session) => this.resolveRequesterName(session),
      ensureWindow: async () => {
        await this.options.ensureWindow?.();
      },
      now: () => Date.now(),
      reportError: (error) => this.options.reportError(error),
    });
    installSessionAutoApprove(this.sessionApprovals, (error) =>
      this.options.reportError(error),
    );
  }

  getPendingSessions(): PendingRemoteSession[] {
    return this.sessionApprovals.list();
  }

  approveSession(request: ApproveRemoteSessionRequest): Promise<void> {
    return this.sessionApprovals.approve(request);
  }

  rejectSession(request: RejectRemoteSessionRequest): Promise<void> {
    return this.sessionApprovals.reject(request);
  }

  onPendingSessionsChanged(
    listener: (sessions: PendingRemoteSession[]) => void,
  ): () => void {
    return this.sessionApprovals.onChanged(listener);
  }

  private async resolveRequesterName(
    session: RemoteSession,
  ): Promise<string | undefined> {
    if (!this.deviceRuntime) return undefined;
    const devices = await listFirebaseHostDevices(this.deviceRuntime.functions);
    return devices.find((device) => device.deviceId === session.clientDeviceId)
      ?.displayName;
  }

  configureHostServices(services: RemoteHostServices): void {
    this.hostServices = services;
  }

  listTargets(): Promise<AgentLaunchTarget[]> {
    return this.remoteClient.refreshTargets();
  }

  connectTarget(
    target: RemoteAgentExecutionTarget,
  ): Promise<AgentLaunchTarget> {
    return this.remoteClient.connectTarget(target);
  }

  onTargetsChanged(
    listener: (targets: AgentLaunchTarget[]) => void,
  ): () => void {
    return this.remoteClient.onTargetsChanged(listener);
  }

  async listRuntimesForTarget(
    target: AgentExecutionTarget,
  ): Promise<AgentRuntime[]> {
    if (target.kind === "local") {
      if (!this.hostServices) throw new Error("TERMINAL_SERVICES_UNAVAILABLE");
      return this.hostServices.listRuntimes();
    }
    return this.remoteClient.peerFor(target).runtimes();
  }

  async workspaceRoots(target: AgentExecutionTarget): Promise<WorkspaceRoot[]> {
    if (target.kind === "local") {
      if (!this.hostServices) throw new Error("TERMINAL_SERVICES_UNAVAILABLE");
      return this.hostServices.workspace.roots();
    }
    return this.remoteClient.peerFor(target).workspaceRoots();
  }

  async workspaceList(
    target: AgentExecutionTarget,
    path: string,
  ): Promise<WorkspaceDirectoryPage> {
    if (target.kind === "local") {
      if (!this.hostServices) throw new Error("TERMINAL_SERVICES_UNAVAILABLE");
      return this.hostServices.workspace.list(path);
    }
    return this.remoteClient.peerFor(target).workspaceList(path);
  }

  async workspaceValidate(
    target: AgentExecutionTarget,
    path: string,
  ): Promise<WorkspaceSelection> {
    if (target.kind === "local") {
      if (!this.hostServices) throw new Error("TERMINAL_SERVICES_UNAVAILABLE");
      return this.hostServices.workspace.validate(path);
    }
    return this.remoteClient.peerFor(target).workspaceValidate(path);
  }

  peerFor(target: RemoteAgentExecutionTarget): RemoteAgentChannelClient {
    return this.remoteClient.peerFor(target);
  }

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

  async login(
    provider: RemoteAuthProvider,
    parentWindow: DesktopAuthParentWindowLike,
  ): Promise<RemoteAccountStatus> {
    if (
      this.accountStatus.state === "signed_in" &&
      this.runtime?.auth.currentUser
    ) {
      const status = remoteSignedInStatus(this.runtime.auth.currentUser);
      this.publishAccountStatus(status);
      return status;
    }
    if (this.authPromise) {
      await this.authPromise;
      return this.accountStatus;
    }
    this.publishAccountStatus({ state: "signing_in" });
    this.stopRequested = false;
    const generation = ++this.authGeneration;
    const abort = new AbortController();
    const authPromise = this.loginInternal(
      provider,
      generation,
      abort.signal,
      parentWindow,
    );
    this.authAbort = abort;
    this.authPromise = authPromise;
    try {
      await authPromise;
      if (generation !== this.authGeneration || abort.signal.aborted)
        throw new Error("REMOTE_LOGIN_CANCELLED");
      const user = this.runtime?.auth.currentUser;
      if (!user) throw new Error("REMOTE_AUTH_FAILED");
      this.publishAccountStatus(remoteSignedInStatus(user));
    } catch (error) {
      if (generation === this.authGeneration)
        this.publishAccountStatus(remoteAccountErrorStatus(error));
      throw error;
    } finally {
      if (this.authPromise === authPromise) this.authPromise = undefined;
      if (this.authAbort === abort) this.authAbort = undefined;
    }
    return this.accountStatus;
  }

  async logout(): Promise<RemoteAccountStatus> {
    this.stopRequested = true;
    this.authGeneration += 1;
    this.authAbort?.abort();
    this.authAbort = undefined;
    this.authPromise = undefined;
    await this.stopHostResources();
    if (this.runtime?.auth.currentUser)
      await signOut(this.runtime.auth).catch(() => undefined);
    this.runtime = undefined;
    this.identity = undefined;
    this.terminalOwners.clear();
    this.publishAccountStatus({ state: "signed_out" });
    return this.accountStatus;
  }

  async activate(
    parentWindow: DesktopAuthParentWindowLike,
  ): Promise<RemoteHostStatus> {
    if (this.status.state === "online") return this.status;
    if (!this.runtime?.auth.currentUser)
      throw new Error("REMOTE_AUTH_REQUIRED");
    if (this.startPromise) {
      await this.startPromise;
      return this.status;
    }
    this.stopRequested = false;
    this.publishStatus({ state: "activating" });
    this.startPromise = this.startInternal(parentWindow);
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
    await this.logout();
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

  private async loginInternal(
    provider: RemoteAuthProvider,
    generation: number,
    signal: AbortSignal,
    parentWindow: DesktopAuthParentWindowLike,
  ): Promise<void> {
    const runtime = this.runtime ?? createRemoteFirebaseRuntime();
    await bootstrapRemoteAuth(runtime, provider, signal, parentWindow);
    if (
      signal.aborted ||
      generation !== this.authGeneration ||
      this.stopRequested
    ) {
      if (runtime.auth.currentUser)
        await signOut(runtime.auth).catch(() => undefined);
      throw new Error("REMOTE_LOGIN_CANCELLED");
    }
    this.runtime = runtime;
  }

  private async stopHostResources(): Promise<void> {
    await this.remoteClient.disconnectAll();
    this.connector?.close();
    this.connector = undefined;
    this.unsubscribePending?.();
    this.unsubscribePending = undefined;
    this.sessionApprovals.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.deviceRuntime?.auth.currentUser)
      await signOut(this.deviceRuntime.auth).catch(() => undefined);
    this.deviceRuntime = undefined;
    this.publishStatus({ state: "idle" });
  }

  private async startInternal(
    parentWindow: DesktopAuthParentWindowLike,
  ): Promise<void> {
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
        login = await bootstrapRemoteAccount(
          accountRuntime,
          { identity, action, useExistingAuth: true },
          parentWindow,
        );
      } catch (error) {
        // A previous OAuth attempt can persist the local key before its
        // server-side device is created. Recover that interrupted first run
        // by registering the same key instead of requiring manual cleanup.
        if (!shouldRetryDesktopLoginAsRegister(action, error)) throw error;
        login = await bootstrapRemoteAccount(
          accountRuntime,
          { identity, action: "register", useExistingAuth: true },
          parentWindow,
        );
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
          displayName: resolveDeviceDisplayName(hostname()),
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
      if (!this.options.createPeer) {
        throw new Error("REMOTE_NATIVE_PEER_UNAVAILABLE");
      }
      this.connector = new DesktopPeerConnector({
        runtime: deviceRuntime,
        identity,
        device,
        terminalOwners: this.terminalOwners,
        createPeer: this.options.createPeer,
        hostServices: () => this.hostServices,
        reportError: this.options.reportError,
      });
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
            this.sessionApprovals.handlePending(session);
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
      void this.remoteClient
        .refreshTargets()
        .catch((error) => this.options.reportError(error));
    } catch (error) {
      await this.stopHostResources();
      throw error;
    }
  }

  async signSessionApproval(
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
    if (!this.connector) throw new Error("REMOTE_HOST_NOT_STARTED");
    void this.connector
      .acceptHostSession(result)
      .catch((error) => this.options.reportError(error));
    return result;
  }

  async signSessionRejection(
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
    return result;
  }

  private async heartbeat(): Promise<void> {
    if (!this.deviceRuntime || !this.identity) return;
    const call = httpsCallable(this.deviceRuntime.functions, "heartbeatDevice");
    await call({});
  }
}

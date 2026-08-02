import { randomUUID } from "node:crypto";
import {
  createRemoteSession,
  getSessionPeerDevice,
  issueTurnCredentials,
  subscribeClientSessions,
  type FirebaseRuntime,
} from "@codra/firebase";
import {
  REMOTE_SESSION_MAX_LEASE_MS,
  SessionApprovalSchema,
  SessionRequestSchema,
  buildSessionApprovalSigningPayload,
  buildSessionRequestSigningPayload,
  decodeRemoteControlMessage,
  encodeRemoteControlMessageBinary,
  type AgentLaunchTargetState,
  type AgentRuntime,
  type RemoteDevice,
  type RemoteSession,
} from "@codra/protocol";
import {
  type CursorOutputStore,
  signCanonical,
  validateAndImportPublicJwk,
  verifyCanonical,
  type IceServerInput,
} from "@codra/webrtc";
import {
  HostControlGateway,
  REMOTE_AGENT_SCOPES,
  type HostControlTerminalManager,
  type HostWorkspacePort,
} from "./host-control-gateway";
import type { HostIdentity } from "./host-identity";
import type { PeerConnectionPort } from "./peer-session";
import { DesktopPeerSession } from "./peer-session";
import {
  SignedSignalTransport,
  createFirebaseSignalBackend,
} from "./signal-transport";
import { RemoteAgentChannelClient } from "./remote-agent-client";

const CLIENT_SESSION_LEASE_MS = 15 * 60 * 1000;
const APPROVAL_WAIT_MAX_MS = 2 * 60 * 1000;

export interface RemoteHostServices {
  workspace: HostWorkspacePort;
  listRuntimes(): AgentRuntime[] | Promise<AgentRuntime[]>;
  manager: HostControlTerminalManager;
  outputStore: CursorOutputStore;
}

export interface DesktopPeerConnectorOptions {
  runtime: FirebaseRuntime;
  identity: HostIdentity;
  device: RemoteDevice;
  createPeer(
    peerName: string,
    iceServers: readonly IceServerInput[],
    options: { relayOnly: boolean },
  ): PeerConnectionPort;
  hostServices(): RemoteHostServices | undefined;
  reportError(error: unknown): void;
  now?: () => number;
}

interface IceAcquisition {
  iceServers: IceServerInput[];
  relayOnly: boolean;
}

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function iceInputs(
  response: Awaited<ReturnType<typeof issueTurnCredentials>>,
): IceServerInput[] {
  return response.iceServers.map(({ urls, username, credential }) => ({
    urls,
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {}),
  }));
}

export class DesktopPeerConnector {
  private readonly now: () => number;
  private readonly peerSessions = new Set<DesktopPeerSession>();
  private readonly clients = new Set<RemoteAgentChannelClient>();
  private readonly gateways = new Set<HostControlGateway>();
  private closed = false;

  constructor(private readonly options: DesktopPeerConnectorOptions) {
    this.now = options.now ?? Date.now;
  }

  async connectClient(
    host: RemoteDevice,
    update: (state: AgentLaunchTargetState, message?: string) => void,
  ): Promise<RemoteAgentChannelClient> {
    this.assertOpen();
    if (host.deviceId === this.options.device.deviceId) {
      throw new Error("REMOTE_SELF_TARGET_DENIED");
    }
    const requested = await this.createSession(host);
    update("waiting_for_approval");
    const approved = await this.waitForApproval(requested);
    const hostPublicKey = await validateAndImportPublicJwk(host.publicKeyJwk);
    await this.verifyApproval(approved, hostPublicKey);
    update("connecting");
    return this.negotiateClient(approved, host, hostPublicKey);
  }

  async acceptHostSession(session: RemoteSession): Promise<void> {
    this.assertOpen();
    const services = this.options.hostServices();
    if (!services) throw new Error("REMOTE_HOST_SERVICES_UNAVAILABLE");
    const peer = await getSessionPeerDevice(
      this.options.runtime.functions,
      session.sessionId,
    );
    this.assertPeerBinding(session, peer, "client");
    const peerPublicKey = await validateAndImportPublicJwk(peer.publicKeyJwk);
    const hostSigner = await importPrivateKey(this.options.identity.privateKey);
    const { iceServers, relayOnly } = await this.acquireIceServers(
      session.sessionId,
    );
    const negotiationId = session.sessionId;
    const signals = new SignedSignalTransport({
      session,
      negotiationId,
      local: {
        deviceId: this.options.device.deviceId,
        keyThumbprint: this.options.identity.keyThumbprint,
        generation: this.options.device.generation,
        privateKey: hostSigner,
      },
      peer: {
        deviceId: peer.deviceId,
        keyThumbprint: peer.keyThumbprint,
        generation: peer.generation,
        publicKey: peerPublicKey,
      },
      backend: createFirebaseSignalBackend(
        this.options.runtime,
        this.options.runtime.auth.currentUser?.uid ?? "",
      ),
      now: this.now,
    });
    const nativePeer = this.options.createPeer(
      `host-${session.sessionId}`,
      iceServers,
      { relayOnly },
    );
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let gateway: HostControlGateway | undefined;
      const peerSession = new DesktopPeerSession({
        role: "host",
        peer: nativePeer,
        signals,
        onChannels: ({ control, terminal }) => {
          gateway = new HostControlGateway({
            session,
            negotiationId,
            hostSigner,
            publicKeyResolver: async (thumbprint) =>
              thumbprint === peer.keyThumbprint ? peerPublicKey : undefined,
            workspace: services.workspace,
            listRuntimes: services.listRuntimes,
            manager: services.manager,
            outputStore: services.outputStore,
            controlSender: {
              send(message) {
                control.send(encodeRemoteControlMessageBinary(message));
              },
            },
            terminalSender: terminal,
            reportError: this.options.reportError,
          });
          this.gateways.add(gateway);
          control.onMessage((rawMessage) => {
            void this.handleHostControl(gateway!, peerSession, rawMessage);
          });
          terminal.onBufferedAmountLow(() => {
            void gateway?.onBufferedAmountLow().catch(this.options.reportError);
          });
          settled = true;
          resolve();
        },
        onError: (error) => {
          gateway?.close();
          if (gateway) this.gateways.delete(gateway);
          this.peerSessions.delete(peerSession);
          if (!settled) reject(error);
          else this.options.reportError(error);
        },
      });
      this.peerSessions.add(peerSession);
      peerSession.start();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) client.close();
    for (const gateway of this.gateways) gateway.close();
    for (const peerSession of this.peerSessions) peerSession.close();
    this.clients.clear();
    this.gateways.clear();
    this.peerSessions.clear();
  }

  private async createSession(host: RemoteDevice): Promise<RemoteSession> {
    const user = this.options.runtime.auth.currentUser;
    if (!user) throw new Error("REMOTE_AUTH_REQUIRED");
    this.assertPeerDevice(host, "host");
    const createdAt = this.now();
    const expiresAt = Math.min(
      createdAt + CLIENT_SESSION_LEASE_MS,
      createdAt + REMOTE_SESSION_MAX_LEASE_MS,
    );
    const base = SessionRequestSchema.parse({
      sessionId: randomUUID(),
      ownerUid: user.uid,
      clientDeviceId: this.options.device.deviceId,
      hostDeviceId: host.deviceId,
      clientKeyThumbprint: this.options.identity.keyThumbprint,
      hostKeyThumbprint: host.keyThumbprint,
      clientDeviceGeneration: this.options.device.generation,
      hostDeviceGeneration: host.generation,
      protocolVersion: 1,
      requestedScopes: [...REMOTE_AGENT_SCOPES],
      clientChallenge: randomUUID(),
      requestSignature: "A".repeat(86),
      createdAt,
      expiresAt,
    });
    const signer = await importPrivateKey(this.options.identity.privateKey);
    const requestSignature = await signCanonical(
      signer,
      buildSessionRequestSigningPayload(base),
    );
    return createRemoteSession(this.options.runtime.functions, {
      sessionId: base.sessionId,
      hostDeviceId: base.hostDeviceId,
      hostKeyThumbprint: base.hostKeyThumbprint,
      hostDeviceGeneration: base.hostDeviceGeneration,
      protocolVersion: 1,
      requestedScopes: base.requestedScopes,
      clientChallenge: base.clientChallenge,
      requestSignature,
      expiresAt,
    });
  }

  private waitForApproval(requested: RemoteSession): Promise<RemoteSession> {
    return new Promise<RemoteSession>((resolve, reject) => {
      let finished = false;
      let unsubscribe: (() => void) | undefined = undefined;
      const finish = (
        outcome: { session: RemoteSession } | { error: Error },
      ): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe?.();
        if ("session" in outcome) resolve(outcome.session);
        else reject(outcome.error);
      };
      const waitMs = Math.max(
        1,
        Math.min(APPROVAL_WAIT_MAX_MS, requested.expiresAt - this.now()),
      );
      const timer = setTimeout(
        () => finish({ error: new Error("REMOTE_APPROVAL_TIMEOUT") }),
        waitMs,
      );
      unsubscribe = subscribeClientSessions({
        firestore: this.options.runtime.firestore,
        uid: this.options.runtime.auth.currentUser?.uid ?? "",
        deviceId: this.options.device.deviceId,
        keyThumbprint: this.options.identity.keyThumbprint,
        generation: this.options.device.generation,
        onChange: (sessions) => {
          const session = sessions.find(
            (candidate) => candidate.sessionId === requested.sessionId,
          );
          if (!session) return;
          if (
            session.status === "approved" ||
            session.status === "signaling" ||
            session.status === "connected"
          ) {
            finish({ session });
          } else if (session.status === "rejected") {
            finish({ error: new Error("REMOTE_APPROVAL_REJECTED") });
          } else if (
            session.status === "failed" ||
            session.status === "closed"
          ) {
            finish({ error: new Error("REMOTE_SESSION_FAILED") });
          }
        },
        onError: (error) => finish({ error }),
      });
    });
  }

  private async verifyApproval(
    session: RemoteSession,
    hostPublicKey: CryptoKey,
  ): Promise<void> {
    const approval = SessionApprovalSchema.parse({
      domain: "codra.session-approval.v1",
      protocolVersion: session.protocolVersion,
      sessionId: session.sessionId,
      clientDeviceId: session.clientDeviceId,
      hostDeviceId: session.hostDeviceId,
      clientKeyThumbprint: session.clientKeyThumbprint,
      hostKeyThumbprint: session.hostKeyThumbprint,
      clientDeviceGeneration: session.clientDeviceGeneration,
      hostDeviceGeneration: session.hostDeviceGeneration,
      requestedScopes: session.requestedScopes,
      approvedScopes: session.approvedScopes,
      clientChallenge: session.clientChallenge,
      hostChallenge: session.hostChallenge,
      expiresAtMillis: session.expiresAt,
      signature: session.approvalSignature,
    });
    if (
      !(await verifyCanonical(
        hostPublicKey,
        approval.signature,
        buildSessionApprovalSigningPayload(approval),
      ))
    ) {
      throw new Error("REMOTE_APPROVAL_SIGNATURE_INVALID");
    }
  }

  private async negotiateClient(
    session: RemoteSession,
    host: RemoteDevice,
    hostPublicKey: CryptoKey,
  ): Promise<RemoteAgentChannelClient> {
    const signer = await importPrivateKey(this.options.identity.privateKey);
    const { iceServers, relayOnly } = await this.acquireIceServers(
      session.sessionId,
    );
    const negotiationId = session.sessionId;
    const signals = new SignedSignalTransport({
      session,
      negotiationId,
      local: {
        deviceId: this.options.device.deviceId,
        keyThumbprint: this.options.identity.keyThumbprint,
        generation: this.options.device.generation,
        privateKey: signer,
      },
      peer: {
        deviceId: host.deviceId,
        keyThumbprint: host.keyThumbprint,
        generation: host.generation,
        publicKey: hostPublicKey,
      },
      backend: createFirebaseSignalBackend(
        this.options.runtime,
        this.options.runtime.auth.currentUser?.uid ?? "",
      ),
      now: this.now,
    });
    const nativePeer = this.options.createPeer(
      `client-${session.sessionId}`,
      iceServers,
      { relayOnly },
    );
    return new Promise<RemoteAgentChannelClient>((resolve, reject) => {
      let settled = false;
      let client: RemoteAgentChannelClient | undefined;
      const peerSession = new DesktopPeerSession({
        role: "client",
        peer: nativePeer,
        signals,
        onChannels: ({ control, terminal }) => {
          client = new RemoteAgentChannelClient({
            session,
            negotiationId,
            clientSigner: signer,
            hostPublicKey,
            control,
            terminal,
          });
          this.clients.add(client);
          void client.start().then(
            () => {
              settled = true;
              resolve(client!);
            },
            (error: unknown) => {
              peerSession.close();
              reject(error);
            },
          );
        },
        onError: (error) => {
          if (client) this.clients.delete(client);
          this.peerSessions.delete(peerSession);
          if (!settled) reject(error);
          else this.options.reportError(error);
        },
      });
      this.peerSessions.add(peerSession);
      peerSession.start();
    });
  }

  private async handleHostControl(
    gateway: HostControlGateway,
    peerSession: DesktopPeerSession,
    rawMessage: ArrayBuffer | Uint8Array | string,
  ): Promise<void> {
    try {
      if (typeof rawMessage === "string") {
        throw new Error("REMOTE_CONTROL_BINARY_REQUIRED");
      }
      await gateway.handleControl(decodeRemoteControlMessage(rawMessage));
    } catch (error) {
      gateway.close();
      this.gateways.delete(gateway);
      peerSession.close();
      this.options.reportError(error);
    }
  }

  private assertPeerBinding(
    session: RemoteSession,
    peer: RemoteDevice,
    role: "client" | "host",
  ): void {
    const matches =
      role === "client"
        ? peer.deviceId === session.clientDeviceId &&
          peer.keyThumbprint === session.clientKeyThumbprint &&
          peer.generation === session.clientDeviceGeneration
        : peer.deviceId === session.hostDeviceId &&
          peer.keyThumbprint === session.hostKeyThumbprint &&
          peer.generation === session.hostDeviceGeneration;
    if (!matches) throw new Error("REMOTE_PEER_BINDING_MISMATCH");
  }

  private assertPeerDevice(device: RemoteDevice, kind: "host"): void {
    if (
      device.kind !== kind ||
      !device.active ||
      !device.remoteAccessEnabled ||
      device.expiresAt <= this.now()
    ) {
      throw new Error("REMOTE_TARGET_OFFLINE");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("REMOTE_CONNECTOR_CLOSED");
  }

  /**
   * Gated on `runtime.deployment.mode`, not on an environment variable: the
   * emulator branch is only reachable when this connector was built with
   * the emulator's `@codra/remote-firebase-config` binding, which is itself
   * a build-time alias the release build never resolves to (it points at
   * the production binding instead). A shipped build has no `runtime` whose
   * `deployment.mode` can ever be `"emulator"`, so `issueTurnCredentials` is
   * unconditionally reachable in production.
   *
   * The TURN callable requires a provider secret that the local emulator
   * project has no way to hold, so calling it there always fails. Two
   * loopback peers negotiate fine on host candidates without any TURN
   * server, so the emulator path skips the callable entirely rather than
   * stubbing its response, and asks for ICE servers without `relayOnly` so
   * the native peer is not restricted to a relay it does not have.
   */
  private async acquireIceServers(sessionId: string): Promise<IceAcquisition> {
    if (this.options.runtime.deployment.mode === "emulator") {
      return { iceServers: [], relayOnly: false };
    }
    const credentials = await issueTurnCredentials(
      this.options.runtime.functions,
      sessionId,
    );
    return { iceServers: iceInputs(credentials), relayOnly: true };
  }
}

import {
  issueTurnCredentials,
  subscribeClientSessions,
  type FirebaseRuntime,
} from "@codra/firebase";
import {
  SessionApprovalSchema,
  buildSessionApprovalSigningPayload,
  type AgentLaunchTargetState,
  type RemoteDevice,
  type RemoteSession,
} from "@codra/protocol";
import {
  normalizeBrowserIceServers,
  validateAndImportPublicJwk,
  verifyCanonical,
  type IceServerInput,
} from "@codra/webrtc";
import {
  PeerNegotiationSession,
  RemoteAgentChannelClient,
  SignedSignalTransport,
  createFirebaseSignalBackend,
  type PeerConnectionPort,
} from "@codra/remote-client";
import { createBrowserPeerConnection } from "./browser-peer";
import type { BrowserDeviceIdentity } from "./device-identity";

/**
 * The host user has to physically approve the session in a desktop modal, so
 * the wait is generous — but it is still bounded, because nothing else ever
 * ends it. Mirrors `desktop-peer-connector.ts:45`.
 */
const APPROVAL_WAIT_MAX_MS = 2 * 60 * 1000;

export interface BrowserPeerConnectorOptions {
  runtime: FirebaseRuntime;
  identity: BrowserDeviceIdentity;
  device: RemoteDevice;
  /**
   * Injected so tests can drive the negotiation without a WebRTC stack.
   * `apps/web` has no vitest config, so its tests run in the node environment
   * where `RTCPeerConnection` does not exist — and jsdom would not help, since
   * it implements no WebRTC either.
   */
  createPeer?: (
    iceServers: RTCIceServer[],
    options: { relayOnly: boolean },
  ) => PeerConnectionPort;
  reportError?: (error: unknown) => void;
  now?: () => number;
}

interface IceAcquisition {
  iceServers: RTCIceServer[];
  relayOnly: boolean;
}

/** Mirrors `desktop-peer-connector.ts:84-92`. */
function iceInputs(
  response: Awaited<ReturnType<typeof issueTurnCredentials>>,
): IceServerInput[] {
  return response.iceServers.map(({ urls, username, credential }) => ({
    urls,
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {}),
  }));
}

/**
 * The browser half of `DesktopPeerConnector.connectClient`.
 *
 * Only the client role exists here: a browser is never a host, so there is no
 * `acceptHostSession`, no `HostControlGateway`, and no terminal ownership map.
 * Everything else — the approval wait, the approval signature check, the ICE
 * acquisition rules, and the offerer-side negotiation — is ported from
 * `apps/desktop/src/main/remote/desktop-peer-connector.ts` so that the two
 * clients cannot drift.
 *
 * Session creation is deliberately *not* here. `BrowserRemoteController`
 * already owns it (`controller.ts:106-154`), including the scope set and the
 * session lease, so this class is handed the session it should wait on.
 */
export class BrowserPeerConnector {
  private readonly now: () => number;
  private readonly createPeer: (
    iceServers: RTCIceServer[],
    options: { relayOnly: boolean },
  ) => PeerConnectionPort;
  private readonly reportError: (error: unknown) => void;
  private readonly peerSessions = new Set<PeerNegotiationSession>();
  private readonly clients = new Set<RemoteAgentChannelClient>();
  private closed = false;

  constructor(private readonly options: BrowserPeerConnectorOptions) {
    this.now = options.now ?? Date.now;
    this.createPeer = options.createPeer ?? createBrowserPeerConnection;
    this.reportError = options.reportError ?? (() => undefined);
  }

  /**
   * Takes the session `BrowserRemoteController.requestSession` just created and
   * carries it through approval, verification, and negotiation.
   */
  async connect(
    host: RemoteDevice,
    requested: RemoteSession,
    update: (state: AgentLaunchTargetState, message?: string) => void = () =>
      undefined,
  ): Promise<RemoteAgentChannelClient> {
    this.assertOpen();
    if (host.deviceId === this.options.device.deviceId) {
      throw new Error("REMOTE_SELF_TARGET_DENIED");
    }
    update("waiting_for_approval");
    const approved = await this.waitForApproval(requested);
    const hostPublicKey = await validateAndImportPublicJwk(host.publicKeyJwk);
    await this.verifyApproval(approved, hostPublicKey);
    update("connecting");
    return this.negotiateClient(approved, host, hostPublicKey);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) client.close();
    for (const peerSession of this.peerSessions) peerSession.close();
    this.clients.clear();
    this.peerSessions.clear();
  }

  /**
   * Ported from `desktop-peer-connector.ts:275-326`.
   *
   * `signaling` and `connected` are accepted for parity with the desktop, but
   * no session ever reaches them: no Cloud Function writes those statuses and
   * `firestore.rules:77` denies client updates to `remoteSessions`. `approved`
   * is the terminal success state, so it is the one that must resolve — a step
   * that waited for `signaling` would hang until the timeout.
   */
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

  /**
   * Ported from `desktop-peer-connector.ts:328-358`.
   *
   * The approval arrives through Firestore, which the host's own signature is
   * the only defence against: nothing downstream re-checks that the scopes the
   * host granted are the scopes this client is about to act on. Verified before
   * a single ICE credential is requested or a peer connection is constructed.
   */
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

  /**
   * Ported from `desktop-peer-connector.ts:360-434`.
   *
   * The browser is always the offerer. `PeerNegotiationSession` creates both
   * data channels before it calls `setLocalDescription("offer")`
   * (`peer-session.ts:140-152`), which is what puts the two `m=`-less SCTP
   * channels into the offer the host answers; creating either one afterwards
   * would need a second negotiation this protocol has no signal for.
   *
   * `negotiationId` is the session id, always. There is no ICE restart on
   * either side, so the two never diverge.
   */
  private async negotiateClient(
    session: RemoteSession,
    host: RemoteDevice,
    hostPublicKey: CryptoKey,
  ): Promise<RemoteAgentChannelClient> {
    // Unlike the desktop, whose identity is stored as a JWK and imported per
    // use, the browser identity holds a non-extractable CryptoKey from
    // IndexedDB, so there is nothing to import here.
    const signer = this.options.identity.privateKey;
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
    const peer = this.createPeer(iceServers, { relayOnly });
    return new Promise<RemoteAgentChannelClient>((resolve, reject) => {
      let settled = false;
      let client: RemoteAgentChannelClient | undefined;
      const peerSession = new PeerNegotiationSession({
        role: "client",
        peer,
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
          else this.reportError(error);
        },
      });
      this.peerSessions.add(peerSession);
      peerSession.start();
    });
  }

  /**
   * Ported from `desktop-peer-connector.ts:501-510`, including its emulator
   * branch, which is load-bearing rather than a convenience.
   *
   * The TURN callable needs a provider secret the local emulator project has no
   * way to hold, so calling it there always fails; two loopback peers negotiate
   * fine on host candidates with no TURN server at all. So the emulator path
   * skips the callable entirely and asks for an unrestricted transport policy,
   * because `iceTransportPolicy: "relay"` with no relay would leave ICE with
   * nothing to gather. The guard has to wrap the whole branch:
   * `normalizeBrowserIceServers` throws `TURN_SERVER_LIST_BOUNDED` on an empty
   * list (`packages/webrtc/src/ice.ts:69-70`), so it cannot be called and then
   * filtered.
   *
   * In production the callable is unconditionally reachable — `deployment.mode`
   * is fixed by which `@codra/web-firebase-config` binding the build resolved,
   * and the release build resolves the production one. Its response is
   * validated by `normalizeBrowserIceServers`, which is the only thing that
   * checks the urls came back pointing at Cloudflare rather than at whatever a
   * tampered response named. `native-peer.ts` calls it inside the peer factory;
   * `createBrowserPeerConnection` deliberately does not, so the call belongs
   * here.
   */
  private async acquireIceServers(sessionId: string): Promise<IceAcquisition> {
    if (this.options.runtime.deployment.mode === "emulator") {
      return { iceServers: [], relayOnly: false };
    }
    const credentials = await issueTurnCredentials(
      this.options.runtime.functions,
      sessionId,
    );
    return {
      // `transport` is dropped on the way out. It is a `BrowserIceServer`
      // field the normalizer derives so the *native* path can pick the UDP
      // entries; `RTCIceServer` has no such member, and browsers reject an
      // `RTCConfiguration` carrying unknown ICE server keys.
      iceServers: normalizeBrowserIceServers(iceInputs(credentials)).map(
        ({ urls, username, credential }) => ({ urls, username, credential }),
      ),
      relayOnly: true,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("REMOTE_CONNECTOR_CLOSED");
  }
}

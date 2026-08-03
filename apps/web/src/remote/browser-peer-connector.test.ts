import { afterEach, describe, expect, it, vi } from "vitest";

// `apps/web` has no vitest config, so Vitest inherits `vite.config.ts` and runs
// in the node environment, where `RTCPeerConnection` does not exist. jsdom would
// not help — it implements no WebRTC either — so the peer connection and its
// channels are hand-rolled, the same way `browser-peer.test.ts` and
// `browser-channel.test.ts` hand-roll theirs. The connector takes its peer
// factory by injection for exactly this reason.
//
// The controller's scope set and session lease are exercised here rather than in
// a file of their own: they are the other half of the same defect this connector
// closes. A session whose scopes cannot produce a terminal, or whose lease
// breaks signalling, negotiates exactly this far and then dies at the host.

const mocks = vi.hoisted(() => ({
  issueTurnCredentials: vi.fn(),
  subscribeClientSessions: vi.fn(),
  createRemoteSession: vi.fn(),
  registerDevice: vi.fn(),
  createFirebaseSignalBackend: vi.fn(),
  createRemoteFirebaseRuntime: vi.fn(),
  bootstrapRemoteAccount: vi.fn(),
  loadOrCreateBrowserDeviceIdentity: vi.fn(),
  bindBrowserDeviceOwner: vi.fn(),
  signInWithCustomToken: vi.fn(),
}));

vi.mock("@codra/firebase", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issueTurnCredentials: mocks.issueTurnCredentials,
  subscribeClientSessions: mocks.subscribeClientSessions,
  createRemoteSession: mocks.createRemoteSession,
  registerDevice: mocks.registerDevice,
}));

vi.mock("@codra/remote-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFirebaseSignalBackend: mocks.createFirebaseSignalBackend,
}));

vi.mock("firebase/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  signInWithCustomToken: mocks.signInWithCustomToken,
}));

vi.mock("@codra/web-firebase-config", () => ({
  webFirebaseConfigBinding: "test",
  createRemoteFirebaseRuntime: mocks.createRemoteFirebaseRuntime,
}));

vi.mock("@codra/web-account-bootstrap", () => ({
  webAccountBootstrap: "test",
  bootstrapRemoteAccount: mocks.bootstrapRemoteAccount,
}));

// `loadOrCreateBrowserDeviceIdentity` reaches for IndexedDB, which node does not
// have. The identity it would have returned is generated with real WebCrypto
// below, so every signature in this file is a real P-256 signature.
vi.mock("./device-identity", () => ({
  loadOrCreateBrowserDeviceIdentity: mocks.loadOrCreateBrowserDeviceIdentity,
  bindBrowserDeviceOwner: mocks.bindBrowserDeviceOwner,
}));

import type { FirebaseRuntime } from "@codra/firebase";
import {
  PublicEcJwkSchema,
  RemoteDeviceSchema,
  RemoteSessionSchema,
  SessionApprovalSchema,
  createRfc7638Thumbprint,
  decodeRemoteControlMessage,
  encodeRemoteControlMessageBinary,
  type PublicEcJwk,
  type RemoteDevice,
  type RemoteSession,
  type Signal,
} from "@codra/protocol";
import { HandshakeGate, signCanonical } from "@codra/webrtc";
import {
  CONTROL_CHANNEL_LABEL,
  RemoteAgentChannelClient,
  TERMINAL_CHANNEL_LABEL,
  type PeerChannelPort,
  type PeerConnectionPort,
} from "@codra/remote-client";
import { BrowserPeerConnector } from "./browser-peer-connector";
import {
  BrowserRemoteController,
  DEFAULT_SCOPES,
  DEFAULT_SESSION_LEASE_MS,
  MAX_SESSION_LEASE_MS,
} from "./controller";
import type { BrowserDeviceIdentity } from "./device-identity";

const FIXED_NOW = 1_700_000_000_000;
const SESSION_ID = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";
const OTHER_SESSION_ID = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const OWNER_UID = "owner-uid";
const HOST_DEVICE_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const BROWSER_DEVICE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const APPROVAL_WAIT_MAX_MS = 2 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * The exact scope set the host's approval modal knows how to describe —
 * `SCOPE_LABELS`,
 * `apps/desktop/src/renderer/src/remote/SessionApprovalDialog.tsx:7-15`.
 * Copied rather than imported: `apps/web` cannot reach into the desktop
 * renderer's module graph, and a scope the modal cannot label is shown to the
 * approving user as a raw protocol string.
 */
const LABELLED_SCOPES = [
  "workspace.read",
  "agent.runtimes",
  "agent.launch",
  "terminal.write",
  "terminal.resize",
  "terminal.detach",
  "terminal.attach",
];

async function ecKeyMaterial() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exportedPublic = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKeyJwk: PublicEcJwk = PublicEcJwkSchema.parse({
    kty: exportedPublic.kty,
    crv: exportedPublic.crv,
    x: exportedPublic.x,
    y: exportedPublic.y,
  });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyJwk,
    keyThumbprint: createRfc7638Thumbprint(publicKeyJwk),
  };
}

type KeyMaterial = Awaited<ReturnType<typeof ecKeyMaterial>>;

function device(
  overrides: Partial<RemoteDevice> & { deviceId: string },
  material: KeyMaterial,
): RemoteDevice {
  return RemoteDeviceSchema.parse({
    ownerUid: OWNER_UID,
    kind: "host",
    displayName: "Test Device",
    publicKeyJwk: material.publicKeyJwk,
    keyThumbprint: material.keyThumbprint,
    active: true,
    generation: 1,
    remoteAccessEnabled: true,
    capabilities: ["terminal", "webrtc", "turn-udp"],
    createdAt: FIXED_NOW - 10_000,
    lastSeenAt: FIXED_NOW - 1_000,
    expiresAt: FIXED_NOW + ONE_HOUR_MS,
    ...overrides,
  });
}

function runtimeFor(mode: "production" | "emulator"): FirebaseRuntime {
  return {
    functions: {},
    firestore: {},
    auth: { currentUser: { uid: OWNER_UID } },
    deployment: { mode },
  } as unknown as FirebaseRuntime;
}

const TURN_RESPONSE = {
  issuanceId: "issuance-1",
  iceServers: [
    {
      urls: "turn:turn.cloudflare.com:3478?transport=udp",
      username: "user",
      credential: "secret",
    },
  ],
  issuedAtMillis: FIXED_NOW,
  expiresAtMillis: FIXED_NOW + 60_000,
};

class FakeChannel implements PeerChannelPort {
  readonly ordered = true;
  readonly maxRetransmits = null;
  readonly maxPacketLifeTime = null;
  bufferedAmount = 0;
  readonly sent: (ArrayBuffer | Uint8Array | string)[] = [];
  private readonly openListeners = new Set<() => void>();
  private readonly closedListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly messageListeners = new Set<
    (message: ArrayBuffer | Uint8Array | string) => void
  >();
  private readonly lowListeners = new Set<() => void>();

  constructor(readonly label: string) {}

  send(data: ArrayBuffer | Uint8Array | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.messageListeners.clear();
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onMessage(
    listener: (message: ArrayBuffer | Uint8Array | string) => void,
  ): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onBufferedAmountLow(listener: () => void): () => void {
    this.lowListeners.add(listener);
    return () => this.lowListeners.delete(listener);
  }

  open(): void {
    for (const listener of [...this.openListeners]) listener();
  }

  deliver(message: ArrayBuffer | Uint8Array | string): void {
    for (const listener of [...this.messageListeners]) listener(message);
  }
}

class FakePeer implements PeerConnectionPort {
  /** Every port call in the order it was made, so ordering can be asserted. */
  readonly calls: string[] = [];
  readonly channels: FakeChannel[] = [];
  private readonly localDescriptionListeners = new Set<
    (sdp: string, type: "offer" | "answer") => void
  >();

  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): PeerChannelPort {
    this.calls.push(`createDataChannel:${label}:${options?.ordered !== false}`);
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  setLocalDescription(type: "offer" | "answer"): void {
    this.calls.push(`setLocalDescription:${type}`);
    for (const listener of [...this.localDescriptionListeners])
      listener(`v=0\r\na=${type}\r\n`, type);
  }

  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    this.calls.push(`setRemoteDescription:${type}:${sdp.length}`);
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    this.calls.push(`addRemoteCandidate:${mid}:${candidate.length}`);
  }

  onLocalDescription(
    listener: (sdp: string, type: "offer" | "answer") => void,
  ): void {
    this.localDescriptionListeners.add(listener);
  }

  onLocalCandidate(): void {}
  onStateChange(): void {}
  onGatheringStateChange(): void {}
  onDataChannel(): void {}

  close(): void {
    this.calls.push("close");
  }

  channelFor(label: string): FakeChannel {
    const channel = this.channels.find((entry) => entry.label === label);
    if (!channel) throw new Error(`missing channel ${label}`);
    return channel;
  }
}

async function approvedSessionFor(
  host: KeyMaterial,
  browser: KeyMaterial,
): Promise<RemoteSession> {
  const expiresAt = FIXED_NOW + DEFAULT_SESSION_LEASE_MS;
  const unsigned = SessionApprovalSchema.omit({ signature: true }).parse({
    domain: "codra.session-approval.v1",
    protocolVersion: 1,
    sessionId: SESSION_ID,
    clientDeviceId: BROWSER_DEVICE_ID,
    hostDeviceId: HOST_DEVICE_ID,
    clientKeyThumbprint: browser.keyThumbprint,
    hostKeyThumbprint: host.keyThumbprint,
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 1,
    requestedScopes: [...DEFAULT_SCOPES],
    approvedScopes: [...DEFAULT_SCOPES],
    clientChallenge: "client-challenge",
    hostChallenge: "host-challenge",
    expiresAtMillis: expiresAt,
  });
  return RemoteSessionSchema.parse({
    sessionId: SESSION_ID,
    ownerUid: OWNER_UID,
    clientDeviceId: BROWSER_DEVICE_ID,
    hostDeviceId: HOST_DEVICE_ID,
    clientKeyThumbprint: browser.keyThumbprint,
    hostKeyThumbprint: host.keyThumbprint,
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 1,
    protocolVersion: 1,
    requestedScopes: [...DEFAULT_SCOPES],
    approvedScopes: [...DEFAULT_SCOPES],
    clientChallenge: "client-challenge",
    hostChallenge: "host-challenge",
    requestSignature: "A".repeat(86),
    approvalSignature: await signCanonical(host.privateKey, unsigned),
    createdAt: FIXED_NOW - 5_000,
    decidedAt: FIXED_NOW - 1_000,
    expiresAt,
    status: "approved",
  });
}

interface PeerRequest {
  iceServers: RTCIceServer[];
  relayOnly: boolean;
}

interface Fixture {
  connector: BrowserPeerConnector;
  host: RemoteDevice;
  requested: RemoteSession;
  approved: RemoteSession;
  peer: FakePeer;
  /** One entry per `createPeer` call, in order. */
  peerRequests: PeerRequest[];
  published: Signal[];
  deliver(sessions: RemoteSession[]): void;
  unsubscribed(): number;
  completeHandshake(): Promise<void>;
}

async function fixture(
  mode: "production" | "emulator",
  options: { tamper?: boolean } = {},
): Promise<Fixture> {
  const hostKeys = await ecKeyMaterial();
  const browserKeys = await ecKeyMaterial();
  const host = device(
    { deviceId: HOST_DEVICE_ID, displayName: "Studio Mac" },
    hostKeys,
  );
  const browserDevice = device(
    { deviceId: BROWSER_DEVICE_ID, kind: "browser", displayName: "Browser" },
    browserKeys,
  );
  const requested = RemoteSessionSchema.parse({
    sessionId: SESSION_ID,
    ownerUid: OWNER_UID,
    clientDeviceId: BROWSER_DEVICE_ID,
    hostDeviceId: HOST_DEVICE_ID,
    clientKeyThumbprint: browserKeys.keyThumbprint,
    hostKeyThumbprint: hostKeys.keyThumbprint,
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 1,
    protocolVersion: 1,
    requestedScopes: [...DEFAULT_SCOPES],
    clientChallenge: "client-challenge",
    requestSignature: "A".repeat(86),
    createdAt: FIXED_NOW - 5_000,
    expiresAt: FIXED_NOW + DEFAULT_SESSION_LEASE_MS,
    status: "requested",
  });
  const signed = await approvedSessionFor(hostKeys, browserKeys);
  // Narrowing the granted scopes after the host signed them: what a
  // Firestore-level tamper looks like from this client's side. Still a subset
  // of `requestedScopes`, so the document itself stays schema-valid — only the
  // signature disagrees.
  const approved = options.tamper
    ? RemoteSessionSchema.parse({
        ...signed,
        approvedScopes: DEFAULT_SCOPES.filter(
          (scope) => scope !== "terminal.attach",
        ),
      })
    : signed;

  let onChange: ((sessions: RemoteSession[]) => void) | undefined;
  let unsubscribeCalls = 0;
  mocks.subscribeClientSessions.mockImplementation(
    (subscription: { onChange: (sessions: RemoteSession[]) => void }) => {
      onChange = subscription.onChange;
      return () => {
        unsubscribeCalls += 1;
      };
    },
  );
  const published: Signal[] = [];
  mocks.createFirebaseSignalBackend.mockReturnValue({
    publish: vi.fn(async (signal: Signal) => {
      published.push(signal);
      return signal;
    }),
    subscribe: vi.fn(() => () => undefined),
  });
  const peer = new FakePeer();
  const peerRequests: PeerRequest[] = [];
  const connector = new BrowserPeerConnector({
    runtime: runtimeFor(mode),
    identity: {
      deviceId: BROWSER_DEVICE_ID,
      privateKey: browserKeys.privateKey,
      publicKey: browserKeys.publicKey,
      publicKeyJwk: browserKeys.publicKeyJwk,
      keyThumbprint: browserKeys.keyThumbprint,
      created: false,
    },
    device: browserDevice,
    createPeer: (iceServers, createOptions) => {
      peerRequests.push({ iceServers, relayOnly: createOptions.relayOnly });
      return peer;
    },
    reportError: vi.fn(),
    now: () => FIXED_NOW,
  });

  return {
    connector,
    host,
    requested,
    approved,
    peer,
    peerRequests,
    published,
    deliver: (sessions) => onChange?.(sessions),
    unsubscribed: () => unsubscribeCalls,
    // Plays the host side of the handshake: verify the browser's hello with a
    // host-role gate, sign the ack, hand it back over the control channel.
    completeHandshake: async () => {
      const control = peer.channelFor(CONTROL_CHANNEL_LABEL);
      await vi.waitFor(() => expect(control.sent.length).toBe(1));
      const hello = decodeRemoteControlMessage(control.sent[0] as Uint8Array);
      const gate = new HandshakeGate({
        role: "host",
        sessionId: SESSION_ID,
        negotiationId: SESSION_ID,
        signer: hostKeys.privateKey,
        publicKeyResolver: async (thumbprint) =>
          thumbprint === browserKeys.keyThumbprint
            ? browserKeys.publicKey
            : undefined,
      });
      control.deliver(
        encodeRemoteControlMessageBinary(await gate.acceptClientHello(hello)),
      );
    },
  };
}

/** Drives a connection as far as the peer factory, without a handshake. */
async function connectToPeer(instance: Fixture): Promise<void> {
  void instance.connector
    .connect(instance.host, instance.requested)
    .catch(() => undefined);
  instance.deliver([instance.approved]);
  await vi.waitFor(() => expect(instance.peerRequests.length).toBe(1));
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("the scope set a browser console requests", () => {
  it("is exactly the set the host grants a client that launches its own agent", () => {
    // Identical to REMOTE_AGENT_SCOPES, host-control-gateway.ts:35-43.
    expect([...DEFAULT_SCOPES]).toEqual([
      "workspace.read",
      "agent.runtimes",
      "agent.launch",
      "terminal.write",
      "terminal.resize",
      "terminal.detach",
      "terminal.attach",
    ]);
  });

  it("never asks for terminal.list or terminal.create", () => {
    // terminal.attach is only legal against a terminal in the host's `owned`
    // set, and ownership comes from agent.launch or terminal.create alone
    // (host-control-gateway.ts:439, :469). The console launches its own agent,
    // so agent.launch is the grant that makes the attach work; terminal.create
    // is unnecessary, and terminal.list only exposes terminals it may never
    // touch (host-control-gateway.ts:449-462).
    expect(DEFAULT_SCOPES).not.toContain("terminal.list");
    expect(DEFAULT_SCOPES).not.toContain("terminal.create");
    expect(DEFAULT_SCOPES).toContain("agent.launch");
  });

  it("asks for nothing the host's approval modal would show as a raw string", () => {
    for (const scope of DEFAULT_SCOPES)
      expect(LABELLED_SCOPES).toContain(scope);
  });
});

describe("BrowserRemoteController.requestSession", () => {
  async function controllerFixture() {
    const hostKeys = await ecKeyMaterial();
    const browserKeys = await ecKeyMaterial();
    const host = device({ deviceId: HOST_DEVICE_ID }, hostKeys);
    const identity: BrowserDeviceIdentity = {
      deviceId: BROWSER_DEVICE_ID,
      ownerUid: OWNER_UID,
      privateKey: browserKeys.privateKey,
      publicKey: browserKeys.publicKey,
      publicKeyJwk: browserKeys.publicKeyJwk,
      keyThumbprint: browserKeys.keyThumbprint,
      created: false,
    };
    const browserDevice = device(
      { deviceId: BROWSER_DEVICE_ID, kind: "browser", displayName: "Browser" },
      browserKeys,
    );
    const runtime = runtimeFor("production");
    (runtime.auth as { currentUser: unknown }).currentUser = null;
    mocks.createRemoteFirebaseRuntime.mockReturnValue(runtime);
    mocks.bootstrapRemoteAccount.mockResolvedValue({
      user: { uid: OWNER_UID, email: null, displayName: null },
    });
    mocks.loadOrCreateBrowserDeviceIdentity.mockResolvedValue(identity);
    mocks.bindBrowserDeviceOwner.mockResolvedValue(identity);
    mocks.registerDevice.mockResolvedValue({
      token: "custom-token",
      serverTimeMillis: FIXED_NOW,
      device: browserDevice,
    });
    mocks.signInWithCustomToken.mockResolvedValue({ user: { uid: OWNER_UID } });
    mocks.createRemoteSession.mockResolvedValue(
      await approvedSessionFor(hostKeys, browserKeys),
    );
    return { controller: new BrowserRemoteController(), host };
  }

  function sentRequest(): { requestedScopes: string[]; expiresAt: number } {
    expect(mocks.createRemoteSession).toHaveBeenCalledTimes(1);
    return mocks.createRemoteSession.mock.calls[0][1] as {
      requestedScopes: string[];
      expiresAt: number;
    };
  }

  it("sends the corrected scope set to createRemoteSession", async () => {
    const { controller, host } = await controllerFixture();

    await controller.requestSession(host);

    expect(sentRequest().requestedScopes).toEqual([...DEFAULT_SCOPES]);
  });

  it("leases the session for thirty minutes by default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const { controller, host } = await controllerFixture();

    await controller.requestSession(host);

    expect(sentRequest().expiresAt).toBe(FIXED_NOW + 30 * 60 * 1000);
  });

  it("clamps a caller-supplied lease to forty-five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const { controller, host } = await controllerFixture();

    // REMOTE_SESSION_MAX_LEASE_MS is eight hours, but the signalling clamp
    // makes anything near an hour unusable, so a caller does not get to ask.
    await controller.requestSession(host, { leaseMs: 8 * 60 * 60 * 1000 });

    expect(sentRequest().expiresAt).toBe(FIXED_NOW + 45 * 60 * 1000);
  });

  it("floors an absurdly short lease at one second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const { controller, host } = await controllerFixture();

    await controller.requestSession(host, { leaseMs: 0 });

    expect(sentRequest().expiresAt).toBe(FIXED_NOW + 1_000);
  });

  it("keeps every reachable lease clear of publishSignal's one-hour clamp", () => {
    // functions/src/index.ts:489-504 clamps a signal's expiresAt to
    // min(input, now + 3_600_000) and only then verifies a signature that
    // covers expiresAtMillis, so a session lease at or beyond an hour has its
    // signals rewritten out from under their own signatures and rejected with
    // SIGNAL_SIGNATURE_INVALID. The clamp reads the server's clock while the
    // signature is made against the client's, so the boundary is an hour plus
    // any client-ahead skew at all — the margin below is what makes skew
    // harmless.
    expect(MAX_SESSION_LEASE_MS).toBeLessThan(ONE_HOUR_MS);
    expect(ONE_HOUR_MS - MAX_SESSION_LEASE_MS).toBeGreaterThanOrEqual(
      15 * 60 * 1000,
    );
    expect(DEFAULT_SESSION_LEASE_MS).toBeLessThanOrEqual(MAX_SESSION_LEASE_MS);
  });
});

describe("BrowserPeerConnector approval wait", () => {
  it("resolves on approved, the only status a session ever reaches", async () => {
    const instance = await fixture("emulator");

    await connectToPeer(instance);

    // `signaling` and `connected` are accepted too, but nothing ever writes
    // them: no Cloud Function does, and firestore.rules:77 denies client
    // updates. Waiting for either would hang until the timeout.
    expect(instance.peerRequests.length).toBe(1);
    expect(instance.unsubscribed()).toBe(1);
    instance.connector.close();
  });

  it("rejects a rejected session", async () => {
    const instance = await fixture("emulator");
    const connecting = instance.connector.connect(
      instance.host,
      instance.requested,
    );

    instance.deliver([
      RemoteSessionSchema.parse({
        ...instance.requested,
        status: "rejected",
        approvedScopes: [],
        decidedAt: FIXED_NOW,
        closedAt: FIXED_NOW,
        rejectionReason: "USER_REJECTED",
        rejectionSignature: "A".repeat(86),
      }),
    ]);

    await expect(connecting).rejects.toThrow("REMOTE_APPROVAL_REJECTED");
    expect(instance.peerRequests).toEqual([]);
  });

  it("rejects a failed session", async () => {
    const instance = await fixture("emulator");
    const connecting = instance.connector.connect(
      instance.host,
      instance.requested,
    );

    instance.deliver([
      RemoteSessionSchema.parse({
        ...instance.requested,
        status: "failed",
        failureCode: "HOST_OFFLINE",
        closedAt: FIXED_NOW,
      }),
    ]);

    await expect(connecting).rejects.toThrow("REMOTE_SESSION_FAILED");
  });

  it("ignores every session but the one it asked for", async () => {
    const instance = await fixture("emulator");
    void instance.connector
      .connect(instance.host, instance.requested)
      .catch(() => undefined);

    instance.deliver([
      RemoteSessionSchema.parse({
        ...instance.approved,
        sessionId: OTHER_SESSION_ID,
      }),
    ]);
    await Promise.resolve();
    expect(instance.peerRequests).toEqual([]);

    instance.deliver([instance.approved]);
    await vi.waitFor(() => expect(instance.peerRequests.length).toBe(1));
    instance.connector.close();
  });

  it("gives up two minutes after asking, not when the session lease ends", async () => {
    const instance = await fixture("emulator");
    vi.useFakeTimers();
    const settled = vi.fn();
    void instance.connector
      .connect(instance.host, instance.requested)
      .catch(settled);

    // The session leases for thirty minutes; the approval wait must not.
    await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MAX_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ message: "REMOTE_APPROVAL_TIMEOUT" }),
    );
    expect(instance.unsubscribed()).toBe(1);
  });
});

describe("BrowserPeerConnector approval verification", () => {
  it("refuses an approval whose scopes were rewritten after the host signed it", async () => {
    mocks.issueTurnCredentials.mockResolvedValue(TURN_RESPONSE);
    const instance = await fixture("production", { tamper: true });
    const connecting = instance.connector.connect(
      instance.host,
      instance.requested,
    );

    instance.deliver([instance.approved]);

    await expect(connecting).rejects.toThrow(
      "REMOTE_APPROVAL_SIGNATURE_INVALID",
    );
    // Nothing is trusted before the signature is: no TURN credential is minted
    // and no peer connection is built for a session that failed the check.
    expect(mocks.issueTurnCredentials).not.toHaveBeenCalled();
    expect(instance.peerRequests).toEqual([]);
  });

  it("accepts an approval the host really signed", async () => {
    const instance = await fixture("emulator");

    await connectToPeer(instance);

    expect(instance.peerRequests.length).toBe(1);
    instance.connector.close();
  });
});

describe("BrowserPeerConnector ICE acquisition", () => {
  it("skips issueTurnCredentials entirely under the emulator runtime", async () => {
    const instance = await fixture("emulator");

    await connectToPeer(instance);

    // Guarded, not called-and-filtered: normalizeBrowserIceServers throws
    // TURN_SERVER_LIST_BOUNDED on an empty list (packages/webrtc/src/ice.ts:69),
    // so the whole branch has to be skipped rather than its result emptied.
    expect(mocks.issueTurnCredentials).not.toHaveBeenCalled();
    expect(instance.peerRequests).toEqual([
      { iceServers: [], relayOnly: false },
    ]);
    instance.connector.close();
  });

  it("mints TURN credentials and demands relay under the production runtime", async () => {
    mocks.issueTurnCredentials.mockResolvedValue(TURN_RESPONSE);
    const instance = await fixture("production");

    await connectToPeer(instance);

    expect(mocks.issueTurnCredentials).toHaveBeenCalledWith({}, SESSION_ID);
    expect(instance.peerRequests).toEqual([
      {
        iceServers: [
          {
            urls: "turn:turn.cloudflare.com:3478?transport=udp",
            username: "user",
            credential: "secret",
          },
        ],
        relayOnly: true,
      },
    ]);
    instance.connector.close();
  });

  it("strips the transport field RTCIceServer has no member for", async () => {
    mocks.issueTurnCredentials.mockResolvedValue(TURN_RESPONSE);
    const instance = await fixture("production");

    await connectToPeer(instance);

    // normalizeBrowserIceServers derives `transport` so the *native* path can
    // pick the UDP entries; RTCIceServer has no such member.
    const [{ iceServers }] = instance.peerRequests;
    for (const server of iceServers)
      expect(server).not.toHaveProperty("transport");
    expect(Object.keys(iceServers[0])).toEqual([
      "urls",
      "username",
      "credential",
    ]);
    instance.connector.close();
  });

  it("refuses a TURN response naming a host other than Cloudflare", async () => {
    mocks.issueTurnCredentials.mockResolvedValue({
      ...TURN_RESPONSE,
      iceServers: [
        {
          urls: "turn:evil.example.com:3478?transport=udp",
          username: "user",
          credential: "secret",
        },
      ],
    });
    const instance = await fixture("production");
    const connecting = instance.connector.connect(
      instance.host,
      instance.requested,
    );

    instance.deliver([instance.approved]);

    // createBrowserPeerConnection deliberately does not normalize, so this
    // connector is the only place the callable's response is validated.
    await expect(connecting).rejects.toThrow("TURN_HOST_UNSUPPORTED");
    expect(instance.peerRequests).toEqual([]);
  });
});

describe("BrowserPeerConnector client negotiation", () => {
  it("creates both data channels before it offers", async () => {
    const instance = await fixture("emulator");

    await connectToPeer(instance);

    expect(instance.peer.calls).toEqual([
      `createDataChannel:${CONTROL_CHANNEL_LABEL}:true`,
      `createDataChannel:${TERMINAL_CHANNEL_LABEL}:true`,
      "setLocalDescription:offer",
    ]);
    instance.connector.close();
  });

  it("publishes the offer under a negotiation id equal to the session id", async () => {
    const instance = await fixture("emulator");

    await connectToPeer(instance);
    await vi.waitFor(() => expect(instance.published.length).toBe(1));

    const [offer] = instance.published;
    expect(offer.payload.type).toBe("offer");
    expect(offer.negotiationId).toBe(SESSION_ID);
    expect(offer.sessionId).toBe(SESSION_ID);
    expect(offer.senderDeviceId).toBe(BROWSER_DEVICE_ID);
    expect(offer.recipientDeviceId).toBe(HOST_DEVICE_ID);
    instance.connector.close();
  });

  it("resolves a channel client once both channels open and the handshake completes", async () => {
    const instance = await fixture("emulator");
    const connecting = instance.connector.connect(
      instance.host,
      instance.requested,
    );
    instance.deliver([instance.approved]);
    await vi.waitFor(() => expect(instance.peer.channels.length).toBe(2));

    // A client is handed over only once *both* channels are open — an open
    // control channel alone sends no hello.
    instance.peer.channelFor(CONTROL_CHANNEL_LABEL).open();
    expect(instance.peer.channelFor(CONTROL_CHANNEL_LABEL).sent.length).toBe(0);
    instance.peer.channelFor(TERMINAL_CHANNEL_LABEL).open();
    await instance.completeHandshake();

    await expect(connecting).resolves.toBeInstanceOf(RemoteAgentChannelClient);
    instance.connector.close();
  });

  it("reports the states the console renders while it waits", async () => {
    const instance = await fixture("emulator");
    const update = vi.fn();
    void instance.connector
      .connect(instance.host, instance.requested, update)
      .catch(() => undefined);

    expect(update).toHaveBeenCalledWith("waiting_for_approval");
    instance.deliver([instance.approved]);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith("connecting"));
    instance.connector.close();
  });

  it("refuses to connect to itself", async () => {
    const instance = await fixture("emulator");
    const self = device(
      { deviceId: BROWSER_DEVICE_ID, kind: "browser", displayName: "Browser" },
      await ecKeyMaterial(),
    );

    await expect(
      instance.connector.connect(self, instance.requested),
    ).rejects.toThrow("REMOTE_SELF_TARGET_DENIED");
  });

  it("refuses to connect after it is closed", async () => {
    const instance = await fixture("emulator");
    instance.connector.close();

    await expect(
      instance.connector.connect(instance.host, instance.requested),
    ).rejects.toThrow("REMOTE_CONNECTOR_CLOSED");
  });
});

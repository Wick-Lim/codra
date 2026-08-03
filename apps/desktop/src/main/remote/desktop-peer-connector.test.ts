import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionPeerDevice: vi.fn(),
  issueTurnCredentials: vi.fn(),
  createRemoteSession: vi.fn(),
  subscribeClientSessions: vi.fn(),
  createFirebaseSignalBackend: vi.fn(),
}));

vi.mock("@codra/firebase", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSessionPeerDevice: mocks.getSessionPeerDevice,
  issueTurnCredentials: mocks.issueTurnCredentials,
  createRemoteSession: mocks.createRemoteSession,
  subscribeClientSessions: mocks.subscribeClientSessions,
}));

vi.mock("@codra/remote-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFirebaseSignalBackend: mocks.createFirebaseSignalBackend,
}));

import type { FirebaseRuntime } from "@codra/firebase";
import {
  PublicEcJwkSchema,
  RemoteDeviceSchema,
  RemoteSessionSchema,
  SessionApprovalSchema,
  createRfc7638Thumbprint,
  type PublicEcJwk,
  type RemoteDevice,
  type RemoteSession,
} from "@codra/protocol";
import { signCanonical } from "@codra/webrtc";
import type { HostIdentity } from "./host-identity";
import type { PeerChannelPort, PeerConnectionPort } from "@codra/remote-client";
import { DesktopPeerConnector } from "./desktop-peer-connector";

const FIXED_NOW = 1_700_000_000_000;
const SESSION_ID = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";
const OWNER_UID = "owner-uid";
const HOST_DEVICE_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const CLIENT_DEVICE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const REQUESTED_SCOPES = ["workspace.read", "agent.launch"];

async function ecKeyMaterial() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exportedPublic = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKeyJwk: PublicEcJwk = PublicEcJwkSchema.parse({
    kty: exportedPublic.kty,
    crv: exportedPublic.crv,
    x: exportedPublic.x,
    y: exportedPublic.y,
  });
  return {
    privateKey: pair.privateKey,
    privateJwk,
    publicKeyJwk,
    keyThumbprint: createRfc7638Thumbprint(publicKeyJwk),
  };
}

function noopChannel(label: string): PeerChannelPort {
  return {
    label,
    ordered: true,
    maxRetransmits: null,
    maxPacketLifeTime: null,
    bufferedAmount: 0,
    send: () => undefined,
    close: () => undefined,
    onOpen: () => () => undefined,
    onClosed: () => () => undefined,
    onError: () => () => undefined,
    onMessage: () => () => undefined,
    onBufferedAmountLow: () => () => undefined,
  };
}

function noopPeer(): PeerConnectionPort {
  return {
    createDataChannel: (label) => noopChannel(label),
    setLocalDescription: () => undefined,
    setRemoteDescription: () => undefined,
    addRemoteCandidate: () => undefined,
    onLocalDescription: () => undefined,
    onLocalCandidate: () => undefined,
    onStateChange: () => undefined,
    onGatheringStateChange: () => undefined,
    onDataChannel: () => undefined,
    close: () => undefined,
  };
}

function runtimeFor(mode: "production" | "emulator"): FirebaseRuntime {
  return {
    functions: {},
    firestore: {},
    auth: { currentUser: { uid: OWNER_UID } },
    deployment: { mode },
  } as unknown as FirebaseRuntime;
}

function device(
  overrides: Partial<RemoteDevice> & { deviceId: string },
  material: { publicKeyJwk: PublicEcJwk; keyThumbprint: string },
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
    expiresAt: FIXED_NOW + 60 * 60 * 1000,
    ...overrides,
  });
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

describe("DesktopPeerConnector ICE acquisition on the host accept path", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function hostFixture(mode: "production" | "emulator") {
    const hostKeys = await ecKeyMaterial();
    const clientKeys = await ecKeyMaterial();
    const identity: HostIdentity = {
      deviceId: HOST_DEVICE_ID,
      publicKeyJwk: hostKeys.publicKeyJwk,
      privateKey: hostKeys.privateJwk,
      keyThumbprint: hostKeys.keyThumbprint,
      created: false,
    };
    const hostDevice = device(
      { deviceId: HOST_DEVICE_ID, displayName: "Studio Mac" },
      hostKeys,
    );
    const clientDevice = device(
      { deviceId: CLIENT_DEVICE_ID, displayName: "Laptop Mac" },
      clientKeys,
    );
    const session: RemoteSession = RemoteSessionSchema.parse({
      sessionId: SESSION_ID,
      ownerUid: OWNER_UID,
      clientDeviceId: CLIENT_DEVICE_ID,
      hostDeviceId: HOST_DEVICE_ID,
      clientKeyThumbprint: clientKeys.keyThumbprint,
      hostKeyThumbprint: hostKeys.keyThumbprint,
      clientDeviceGeneration: 1,
      hostDeviceGeneration: 1,
      protocolVersion: 1,
      requestedScopes: REQUESTED_SCOPES,
      approvedScopes: REQUESTED_SCOPES,
      clientChallenge: "client-challenge",
      hostChallenge: "host-challenge",
      requestSignature: "A".repeat(86),
      approvalSignature: "A".repeat(86),
      createdAt: FIXED_NOW - 5_000,
      decidedAt: FIXED_NOW - 1_000,
      expiresAt: FIXED_NOW + 30 * 60 * 1000,
      status: "approved",
    });
    mocks.getSessionPeerDevice.mockResolvedValue(clientDevice);
    mocks.createFirebaseSignalBackend.mockReturnValue({
      publish: vi.fn(async (signal: unknown) => signal),
      subscribe: vi.fn(() => () => undefined),
    });
    const createPeer = vi.fn(() => noopPeer());
    const connector = new DesktopPeerConnector({
      runtime: runtimeFor(mode),
      identity,
      device: hostDevice,
      terminalOwners: new Map(),
      createPeer,
      hostServices: () => ({}) as never,
      reportError: vi.fn(),
      now: () => FIXED_NOW,
    });
    return { connector, session, createPeer };
  }

  it("skips issueTurnCredentials and hands the native peer an empty, relay-optional ICE list under the emulator runtime", async () => {
    const { connector, session, createPeer } = await hostFixture("emulator");

    void connector.acceptHostSession(session).catch(() => undefined);
    await vi.waitFor(() => expect(createPeer).toHaveBeenCalled());

    expect(mocks.issueTurnCredentials).not.toHaveBeenCalled();
    expect(createPeer).toHaveBeenCalledWith(`host-${SESSION_ID}`, [], {
      relayOnly: false,
    });
    connector.close();
  });

  it("issues TURN credentials and requires relay under the production runtime", async () => {
    mocks.issueTurnCredentials.mockResolvedValue(TURN_RESPONSE);
    const { connector, session, createPeer } = await hostFixture("production");

    void connector.acceptHostSession(session).catch(() => undefined);
    await vi.waitFor(() => expect(createPeer).toHaveBeenCalled());

    expect(mocks.issueTurnCredentials).toHaveBeenCalledWith({}, SESSION_ID);
    expect(createPeer).toHaveBeenCalledWith(
      `host-${SESSION_ID}`,
      [
        {
          urls: "turn:turn.cloudflare.com:3478?transport=udp",
          username: "user",
          credential: "secret",
        },
      ],
      { relayOnly: true },
    );
    connector.close();
  });
});

describe("DesktopPeerConnector ICE acquisition on the client create path", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function clientFixture(mode: "production" | "emulator") {
    const hostKeys = await ecKeyMaterial();
    const clientKeys = await ecKeyMaterial();
    const identity: HostIdentity = {
      deviceId: CLIENT_DEVICE_ID,
      publicKeyJwk: clientKeys.publicKeyJwk,
      privateKey: clientKeys.privateJwk,
      keyThumbprint: clientKeys.keyThumbprint,
      created: false,
    };
    const clientDevice = device(
      { deviceId: CLIENT_DEVICE_ID, displayName: "Laptop Mac" },
      clientKeys,
    );
    const host = device(
      { deviceId: HOST_DEVICE_ID, displayName: "Studio Mac" },
      hostKeys,
    );

    const requested: RemoteSession = RemoteSessionSchema.parse({
      sessionId: SESSION_ID,
      ownerUid: OWNER_UID,
      clientDeviceId: CLIENT_DEVICE_ID,
      hostDeviceId: HOST_DEVICE_ID,
      clientKeyThumbprint: clientKeys.keyThumbprint,
      hostKeyThumbprint: hostKeys.keyThumbprint,
      clientDeviceGeneration: 1,
      hostDeviceGeneration: 1,
      protocolVersion: 1,
      requestedScopes: REQUESTED_SCOPES,
      clientChallenge: "client-challenge",
      requestSignature: "A".repeat(86),
      createdAt: FIXED_NOW - 5_000,
      expiresAt: FIXED_NOW + 30 * 60 * 1000,
      status: "requested",
    });
    mocks.createRemoteSession.mockResolvedValue(requested);

    const approvalExpiresAtMillis = FIXED_NOW + 30 * 60 * 1000;
    const unsignedApproval = SessionApprovalSchema.omit({
      signature: true,
    }).parse({
      domain: "codra.session-approval.v1",
      protocolVersion: 1,
      sessionId: SESSION_ID,
      clientDeviceId: CLIENT_DEVICE_ID,
      hostDeviceId: HOST_DEVICE_ID,
      clientKeyThumbprint: clientKeys.keyThumbprint,
      hostKeyThumbprint: hostKeys.keyThumbprint,
      clientDeviceGeneration: 1,
      hostDeviceGeneration: 1,
      requestedScopes: REQUESTED_SCOPES,
      approvedScopes: REQUESTED_SCOPES,
      clientChallenge: "client-challenge",
      hostChallenge: "host-challenge",
      expiresAtMillis: approvalExpiresAtMillis,
    });
    const approvalSignature = await signCanonical(
      hostKeys.privateKey,
      unsignedApproval,
    );
    const approved: RemoteSession = RemoteSessionSchema.parse({
      sessionId: SESSION_ID,
      ownerUid: OWNER_UID,
      clientDeviceId: CLIENT_DEVICE_ID,
      hostDeviceId: HOST_DEVICE_ID,
      clientKeyThumbprint: clientKeys.keyThumbprint,
      hostKeyThumbprint: hostKeys.keyThumbprint,
      clientDeviceGeneration: 1,
      hostDeviceGeneration: 1,
      protocolVersion: 1,
      requestedScopes: REQUESTED_SCOPES,
      approvedScopes: REQUESTED_SCOPES,
      clientChallenge: "client-challenge",
      hostChallenge: "host-challenge",
      requestSignature: "A".repeat(86),
      approvalSignature,
      createdAt: FIXED_NOW - 5_000,
      decidedAt: FIXED_NOW - 1_000,
      expiresAt: approvalExpiresAtMillis,
      status: "approved",
    });

    let onChange: ((sessions: RemoteSession[]) => void) | undefined;
    mocks.subscribeClientSessions.mockImplementation(
      (options: { onChange: (sessions: RemoteSession[]) => void }) => {
        onChange = options.onChange;
        return () => undefined;
      },
    );
    mocks.createFirebaseSignalBackend.mockReturnValue({
      publish: vi.fn(async (signal: unknown) => signal),
      subscribe: vi.fn(() => () => undefined),
    });
    const createPeer = vi.fn(() => noopPeer());
    const connector = new DesktopPeerConnector({
      runtime: runtimeFor(mode),
      identity,
      device: clientDevice,
      terminalOwners: new Map(),
      createPeer,
      hostServices: () => undefined,
      reportError: vi.fn(),
      now: () => FIXED_NOW,
    });
    return {
      connector,
      host,
      createPeer,
      deliverApproval: () => onChange?.([approved]),
    };
  }

  it("skips issueTurnCredentials and hands the native peer an empty, relay-optional ICE list under the emulator runtime", async () => {
    const { connector, host, createPeer, deliverApproval } =
      await clientFixture("emulator");
    const update = vi.fn();

    void connector.connectClient(host, update).catch(() => undefined);
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith("waiting_for_approval"),
    );
    deliverApproval();
    await vi.waitFor(() => expect(createPeer).toHaveBeenCalled());

    expect(mocks.issueTurnCredentials).not.toHaveBeenCalled();
    expect(createPeer).toHaveBeenCalledWith(`client-${SESSION_ID}`, [], {
      relayOnly: false,
    });
    connector.close();
  });

  it("issues TURN credentials and requires relay under the production runtime", async () => {
    mocks.issueTurnCredentials.mockResolvedValue(TURN_RESPONSE);
    const { connector, host, createPeer, deliverApproval } =
      await clientFixture("production");
    const update = vi.fn();

    void connector.connectClient(host, update).catch(() => undefined);
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith("waiting_for_approval"),
    );
    deliverApproval();
    await vi.waitFor(() => expect(createPeer).toHaveBeenCalled());

    expect(mocks.issueTurnCredentials).toHaveBeenCalledWith({}, SESSION_ID);
    expect(createPeer).toHaveBeenCalledWith(
      `client-${SESSION_ID}`,
      [
        {
          urls: "turn:turn.cloudflare.com:3478?transport=udp",
          username: "user",
          credential: "secret",
        },
      ],
      { relayOnly: true },
    );
    connector.close();
  });
});

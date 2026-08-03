import {
  RemoteSessionSchema,
  decodeRemoteControlMessage,
  encodeOutputFrameBinary,
  encodeRemoteControlMessageBinary,
  type RemoteControlMessage,
  type RemoteSession,
} from "@codra/protocol";
import { HandshakeGate } from "@codra/webrtc";
import { describe, expect, it, vi } from "vitest";
import type { PeerChannelPort } from "./peer-session";
import {
  RemoteAgentChannelClient,
  RemoteAgentClient,
} from "./remote-agent-client";

const clientDeviceId = "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d";
const hostDeviceId = "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1";
const clientThumbprint = "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M";
const hostThumbprint = "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo";
const terminalId = "f4b0f73d-3406-48ec-a5c2-2cf290905e99";

function session(): RemoteSession {
  return RemoteSessionSchema.parse({
    sessionId: "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f",
    ownerUid: "owner-uid",
    clientDeviceId,
    hostDeviceId,
    clientKeyThumbprint: clientThumbprint,
    hostKeyThumbprint: hostThumbprint,
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 2,
    protocolVersion: 1,
    requestedScopes: ["workspace.read", "agent.runtimes"],
    approvedScopes: ["workspace.read", "agent.runtimes"],
    clientChallenge: "client-challenge",
    hostChallenge: "host-challenge",
    requestSignature: "A".repeat(86),
    approvalSignature: "A".repeat(86),
    createdAt: 1_700_000_000_000,
    decidedAt: 1_700_000_000_001,
    expiresAt: 1_700_000_000_000 + 60 * 60 * 1000,
    status: "approved",
  });
}

class ChannelFake implements PeerChannelPort {
  readonly ordered = true;
  readonly maxRetransmits = null;
  readonly maxPacketLifeTime = null;
  bufferedAmount = 0;
  readonly sent: ArrayBuffer[] = [];
  private readonly openListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly messageListeners = new Set<
    (message: ArrayBuffer | Uint8Array | string) => void
  >();
  private readonly lowListeners = new Set<() => void>();

  constructor(readonly label: string) {}

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === "string") throw new Error("binary expected");
    this.sent.push(
      data instanceof ArrayBuffer ? data : Uint8Array.from(data).buffer,
    );
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
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

  emit(message: ArrayBuffer): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

async function harness() {
  const clientKeys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const hostKeys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const control = new ChannelFake("codra.control.v1");
  const terminal = new ChannelFake("codra.terminal.v1");
  const client = new RemoteAgentChannelClient({
    session: session(),
    negotiationId: "negotiation-1",
    clientSigner: clientKeys.privateKey,
    hostPublicKey: hostKeys.publicKey,
    control,
    terminal,
    requestTimeoutMs: 1_000,
  });
  const start = client.start();
  await vi.waitFor(() => expect(control.sent).toHaveLength(1));
  const hello = decodeRemoteControlMessage(control.sent[0]!);
  const hostHandshake = new HandshakeGate({
    role: "host",
    sessionId: session().sessionId,
    negotiationId: "negotiation-1",
    signer: hostKeys.privateKey,
    publicKeyResolver: async (thumbprint) =>
      thumbprint === clientThumbprint ? clientKeys.publicKey : undefined,
  });
  const acknowledgement = await hostHandshake.acceptClientHello(hello);
  control.emit(encodeRemoteControlMessageBinary(acknowledgement));
  await start;
  return { client, control, terminal, hello };
}

describe("RemoteAgentChannelClient", () => {
  it("authenticates the data channel before correlating workspace requests", async () => {
    const { client, control, hello } = await harness();
    expect(hello).toMatchObject({
      type: "hello",
      sessionId: session().sessionId,
      clientDeviceId,
      hostDeviceId,
    });

    const roots = client.workspaceRoots();
    await vi.waitFor(() => expect(control.sent).toHaveLength(2));
    const request = decodeRemoteControlMessage(control.sent.at(-1)!);
    expect(request).toMatchObject({ type: "workspace.roots" });
    control.emit(
      encodeRemoteControlMessageBinary({
        type: "workspace.ok",
        requestId: "requestId" in request ? request.requestId : "missing",
        operation: "workspace.roots",
        result: { roots: [{ path: "/Users/codra", label: "Home" }] },
      }),
    );

    await expect(roots).resolves.toEqual([
      { path: "/Users/codra", label: "Home" },
    ]);
  });

  it("maps correlated remote errors without accepting a success for another operation", async () => {
    const { client, control } = await harness();
    const runtimes = client.runtimes();
    await vi.waitFor(() => expect(control.sent).toHaveLength(2));
    const request = decodeRemoteControlMessage(control.sent.at(-1)!);
    if (!("requestId" in request)) throw new Error("missing request id");
    control.emit(
      encodeRemoteControlMessageBinary({
        type: "operation.error",
        requestId: request.requestId,
        operation: "agent.runtimes",
        code: "SCOPE_DENIED",
        message: "Not approved",
      }),
    );
    await expect(runtimes).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("emits terminal frames and acknowledgements only on the terminal/control channels", async () => {
    const { client, control, terminal } = await harness();
    const frames: unknown[] = [];
    client.onOutputFrame((frame) => frames.push(frame));
    terminal.emit(
      encodeOutputFrameBinary({
        terminalId,
        cursor: 4n,
        data: new TextEncoder().encode("ready"),
      }),
    );
    client.acknowledge(terminalId, 9n);

    expect(frames).toEqual([
      expect.objectContaining({ terminalId, cursor: 4n }),
    ]);
    const acknowledgement = decodeRemoteControlMessage(control.sent.at(-1)!);
    expect(acknowledgement).toEqual({
      type: "terminal.cursor_ack",
      terminalId,
      cursor: "9",
    } satisfies RemoteControlMessage);
  });

  it("re-attaches an existing remote terminal over the control channel", async () => {
    const { client, control } = await harness();
    const attach = client.attach(terminalId);
    await vi.waitFor(() => expect(control.sent).toHaveLength(2));
    const request = decodeRemoteControlMessage(control.sent.at(-1)!);
    expect(request).toMatchObject({ type: "terminal.attach", terminalId });
    if (!("requestId" in request)) throw new Error("missing request id");
    control.emit(
      encodeRemoteControlMessageBinary({
        type: "terminal.ok",
        requestId: request.requestId,
        operation: "terminal.attach",
        result: { terminalId },
      }),
    );

    await expect(attach).resolves.toBeUndefined();
  });
});

describe("RemoteAgentClient targets", () => {
  it("lists only This Mac while disabled and excludes the current device when enabled", async () => {
    let enabled = false;
    const connect = vi.fn();
    const client = new RemoteAgentClient({
      enabled: () => enabled,
      currentDeviceId: () => clientDeviceId,
      listDevices: async () =>
        [
          {
            deviceId: clientDeviceId,
            displayName: "This Mac",
          },
          {
            deviceId: hostDeviceId,
            displayName: "Studio Mac",
          },
        ] as never,
      connect,
    });

    await expect(client.refreshTargets()).resolves.toEqual([
      { target: { kind: "local" }, state: "connected" },
    ]);
    enabled = true;
    await expect(client.refreshTargets()).resolves.toEqual([
      { target: { kind: "local" }, state: "connected" },
      {
        target: {
          kind: "remote",
          deviceId: hostDeviceId,
          displayName: "Studio Mac",
        },
        state: "available",
      },
    ]);
  });

  it("publishes approval and connection states and reuses one connected peer", async () => {
    const peer = { onDisconnected: vi.fn(() => () => undefined) };
    const states: string[] = [];
    const connect = vi.fn(async (_device, update) => {
      update("waiting_for_approval");
      update("connecting");
      return peer as never;
    });
    const client = new RemoteAgentClient({
      enabled: () => true,
      currentDeviceId: () => clientDeviceId,
      listDevices: async () =>
        [
          {
            deviceId: hostDeviceId,
            displayName: "Studio Mac",
          },
        ] as never,
      connect,
    });
    client.onTargetsChanged((targets) => {
      const remote = targets.find(({ target }) => target.kind === "remote");
      if (remote) states.push(remote.state);
    });
    await client.refreshTargets();
    const target = {
      kind: "remote" as const,
      deviceId: hostDeviceId,
      displayName: "Studio Mac",
    };

    await expect(client.connectTarget(target)).resolves.toMatchObject({
      target,
      state: "connected",
    });
    await client.connectTarget(target);

    expect(states).toEqual(
      expect.arrayContaining([
        "available",
        "waiting_for_approval",
        "connecting",
        "connected",
      ]),
    );
    expect(client.peerFor(target)).toBe(peer);
    expect(connect).toHaveBeenCalledOnce();
  });
});

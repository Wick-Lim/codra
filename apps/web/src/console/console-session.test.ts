import {
  RemoteSessionSchema,
  decodeRemoteControlMessage,
  encodeOutputFrameBinary,
  encodeRemoteControlMessageBinary,
  type RemoteControlMessage,
  type RemoteSession,
  type TerminalOutputChunk,
} from "@codra/protocol";
import { HandshakeGate } from "@codra/webrtc";
import {
  RemoteAgentChannelClient,
  type PeerChannelPort,
} from "@codra/remote-client";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SCOPES } from "../remote/controller";
import {
  ConsoleTerminalSession,
  LAUNCH_COLS,
  LAUNCH_ROWS,
  createBrowserLocalTerminalRouter,
} from "./console-session";

// This file runs in the default node environment: nothing here renders, and the
// point is the wire. The client is the real `RemoteAgentChannelClient` over
// hand-rolled data channels, so every assertion below is about the bytes the
// console actually puts on the control channel.

const clientDeviceId = "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d";
const hostDeviceId = "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1";
const clientThumbprint = "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M";
const hostThumbprint = "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo";
const terminalId = "f4b0f73d-3406-48ec-a5c2-2cf290905e99";
const negotiationId = "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f";
const cwd = "/Users/codra/Projects";

function remoteSession(): RemoteSession {
  return RemoteSessionSchema.parse({
    sessionId: negotiationId,
    ownerUid: "owner-uid",
    clientDeviceId,
    hostDeviceId,
    clientKeyThumbprint: clientThumbprint,
    hostKeyThumbprint: hostThumbprint,
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 2,
    protocolVersion: 1,
    requestedScopes: [...DEFAULT_SCOPES],
    approvedScopes: [...DEFAULT_SCOPES],
    clientChallenge: "client-challenge",
    hostChallenge: "host-challenge",
    requestSignature: "A".repeat(86),
    approvalSignature: "A".repeat(86),
    createdAt: 1_700_000_000_000,
    decidedAt: 1_700_000_000_001,
    expiresAt: 1_700_000_000_000 + 30 * 60 * 1000,
    status: "approved",
  });
}

class ChannelFake implements PeerChannelPort {
  readonly ordered = true;
  readonly maxRetransmits = null;
  readonly maxPacketLifeTime = null;
  bufferedAmount = 0;
  readonly sent: ArrayBuffer[] = [];
  private readonly closeListeners = new Set<() => void>();
  private readonly messageListeners = new Set<
    (message: ArrayBuffer | Uint8Array | string) => void
  >();

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

  onOpen(): () => void {
    return () => undefined;
  }

  onClosed(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(): () => void {
    return () => undefined;
  }

  onMessage(
    listener: (message: ArrayBuffer | Uint8Array | string) => void,
  ): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onBufferedAmountLow(): () => void {
    return () => undefined;
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
    session: remoteSession(),
    negotiationId,
    clientSigner: clientKeys.privateKey,
    hostPublicKey: hostKeys.publicKey,
    control,
    terminal,
    requestTimeoutMs: 2_000,
  });
  const started = client.start();
  await vi.waitFor(() => expect(control.sent).toHaveLength(1));
  const hostHandshake = new HandshakeGate({
    role: "host",
    sessionId: negotiationId,
    negotiationId,
    signer: hostKeys.privateKey,
    publicKeyResolver: async (thumbprint) =>
      thumbprint === clientThumbprint ? clientKeys.publicKey : undefined,
  });
  control.emit(
    encodeRemoteControlMessageBinary(
      await hostHandshake.acceptClientHello(
        decodeRemoteControlMessage(control.sent[0]!),
      ),
    ),
  );
  await started;

  const session = new ConsoleTerminalSession({
    client,
    host: { deviceId: hostDeviceId, displayName: "Studio Mac" },
  });
  const chunks: TerminalOutputChunk[] = [];
  session.router.onOutput((chunk) => chunks.push(chunk));
  return { session, control, terminal, chunks };
}

function sentTypes(control: ChannelFake): string[] {
  return control.sent.map((raw) => decodeRemoteControlMessage(raw).type);
}

/**
 * The cursor each acknowledgement carried, in the order they were sent.
 *
 * `RemoteCursorSchema` is a union of a safe integer and a digit string —
 * `RemoteAgentChannelClient.acknowledge` sends the string form, because a
 * cursor is a `bigint` and JSON has no such type.
 */
function acknowledgements(control: ChannelFake): string[] {
  return control.sent.flatMap((raw) => {
    const message = decodeRemoteControlMessage(raw);
    return message.type === "terminal.cursor_ack"
      ? [String(message.cursor)]
      : [];
  });
}

/** Starts an operation, answers the request it sends, and returns its result. */
async function exchange<T>(
  control: ChannelFake,
  start: () => Promise<T>,
  reply: (request: RemoteControlMessage) => RemoteControlMessage,
): Promise<T> {
  const at = control.sent.length;
  const operation = start();
  await vi.waitFor(() => expect(control.sent.length).toBeGreaterThan(at));
  const request = decodeRemoteControlMessage(control.sent[at]!);
  control.emit(encodeRemoteControlMessageBinary(reply(request)));
  return operation;
}

function requestId(message: RemoteControlMessage): string {
  if (!("requestId" in message))
    throw new Error("expected a correlated request");
  return message.requestId;
}

const descriptor = {
  id: terminalId,
  title: "claude",
  cols: LAUNCH_COLS,
  rows: LAUNCH_ROWS,
  state: "running" as const,
  createdAt: 1_700_000_000_002,
};

const agent = { kind: "claude" as const, yolo: false, prompt: "ship it" };

function frame(cursor: bigint, data: string): ArrayBuffer {
  const encoded = encodeOutputFrameBinary({
    terminalId,
    cursor,
    data: new TextEncoder().encode(data),
  });
  return encoded instanceof ArrayBuffer
    ? encoded
    : (Uint8Array.from(encoded).buffer as ArrayBuffer);
}

describe("ConsoleTerminalSession", () => {
  it("walks the host's sequence and never asks for terminal.list", async () => {
    const { session, control } = await harness();

    await exchange(
      control,
      () => session.workspaceRoots(),
      (request) => ({
        type: "workspace.ok",
        requestId: requestId(request),
        operation: "workspace.roots",
        result: { roots: [{ path: "/Users/codra", label: "Home" }] },
      }),
    );
    await exchange(
      control,
      () => session.workspaceList("/Users/codra"),
      (request) => ({
        type: "workspace.ok",
        requestId: requestId(request),
        operation: "workspace.list",
        result: {
          page: {
            path: "/Users/codra",
            label: "Home",
            breadcrumbs: [{ path: "/Users/codra", label: "Home" }],
            entries: [{ path: cwd, name: "Projects" }],
          },
        },
      }),
    );
    await exchange(
      control,
      () => session.workspaceValidate(cwd),
      (request) => ({
        type: "workspace.ok",
        requestId: requestId(request),
        operation: "workspace.validate",
        result: { workspace: { path: cwd, label: "Projects" } },
      }),
    );
    await exchange(
      control,
      () => session.runtimes(),
      (request) => ({
        type: "agent.ok",
        requestId: requestId(request),
        operation: "agent.runtimes",
        result: { runtimes: [] },
      }),
    );
    const launched = await exchange(
      control,
      () => session.launch(cwd, agent),
      (request) => ({
        type: "agent.ok",
        requestId: requestId(request),
        operation: "agent.launch",
        result: { terminal: descriptor },
      }),
    );
    expect(launched.id).toBe(terminalId);

    await exchange(
      control,
      () => session.router.write({ terminalId, data: "ls\r" }),
      (request) => ({
        type: "terminal.ok",
        requestId: requestId(request),
        operation: "terminal.write",
        result: { terminalId },
      }),
    );
    await exchange(
      control,
      () => session.router.resize({ terminalId, cols: 100, rows: 30 }),
      (request) => ({
        type: "terminal.ok",
        requestId: requestId(request),
        operation: "terminal.resize",
        result: { terminalId },
      }),
    );

    expect(sentTypes(control)).toEqual([
      "hello",
      "workspace.roots",
      "workspace.list",
      "workspace.validate",
      "agent.runtimes",
      "agent.launch",
      "terminal.write",
      "terminal.resize",
    ]);
    // The scope is never requested (`controller.ts:52-60`) and the operation is
    // never sent. The host would answer it, and would list terminals this
    // client may never attach to.
    expect(sentTypes(control)).not.toContain("terminal.list");
    expect([...DEFAULT_SCOPES]).not.toContain("terminal.list");
  });

  it("launches at a size the host's terminal bounds accept", async () => {
    const { session, control } = await harness();

    const at = control.sent.length;
    const launched = session.launch(cwd, agent);
    await vi.waitFor(() => expect(control.sent.length).toBeGreaterThan(at));
    const request = decodeRemoteControlMessage(control.sent[at]!);

    expect(request).toMatchObject({
      type: "agent.launch",
      cwd,
      cols: LAUNCH_COLS,
      rows: LAUNCH_ROWS,
      agent,
    });
    control.emit(
      encodeRemoteControlMessageBinary({
        type: "agent.ok",
        requestId: requestId(request),
        operation: "agent.launch",
        result: { terminal: descriptor },
      }),
    );
    await launched;
  });

  it("keeps output that arrives before agent.ok does", async () => {
    const { session, control, terminal, chunks } = await harness();

    const at = control.sent.length;
    const launched = session.launch(cwd, agent);
    await vi.waitFor(() => expect(control.sent.length).toBeGreaterThan(at));
    const request = decodeRemoteControlMessage(control.sent[at]!);

    // The host attaches before it replies (`host-control-gateway.ts:437-444`),
    // so these land while the console still has no terminal id.
    terminal.emit(frame(0n, "boot"));
    terminal.emit(frame(4n, "ing"));
    expect(chunks).toEqual([]);

    control.emit(
      encodeRemoteControlMessageBinary({
        type: "agent.ok",
        requestId: requestId(request),
        operation: "agent.launch",
        result: { terminal: descriptor },
      }),
    );
    await launched;

    expect(chunks.map((chunk) => chunk.data)).toEqual(["boot", "ing"]);
    expect(acknowledgements(control)).toEqual(["4", "7"]);
  });

  it("never acknowledges a cursor below one it has already sent", async () => {
    const { session, control, terminal, chunks } = await harness();

    const at = control.sent.length;
    const launched = session.launch(cwd, agent);
    await vi.waitFor(() => expect(control.sent.length).toBeGreaterThan(at));
    control.emit(
      encodeRemoteControlMessageBinary({
        type: "agent.ok",
        requestId: requestId(decodeRemoteControlMessage(control.sent[at]!)),
        operation: "agent.launch",
        result: { terminal: descriptor },
      }),
    );
    await launched;

    terminal.emit(frame(0n, "hello"));
    terminal.emit(frame(5n, "world"));
    // A stale `AttachmentPump.pump()` resending a range this session already
    // absorbed. Acking its own end cursor would regress the host's
    // `acknowledgedCursor` and throw `OUTPUT_CURSOR_INVALID` in a message with
    // no `requestId`, which kills the peer session rather than one request.
    terminal.emit(frame(0n, "hello"));

    expect(acknowledgements(control)).toEqual(["5", "10", "10"]);
    expect(chunks.map((chunk) => chunk.data)).toEqual(["hello", "world"]);
  });
});

describe("createBrowserLocalTerminalRouter", () => {
  it("owns nothing and refuses anything local", async () => {
    const local = createBrowserLocalTerminalRouter();

    await expect(local.list()).resolves.toEqual([]);
    await expect(
      local.replay({ terminalId, afterSequence: 0, limit: 10 }),
    ).resolves.toEqual([]);
    await expect(local.write({ terminalId, data: "x" })).rejects.toThrow(
      "CONSOLE_LOCAL_TERMINALS_UNSUPPORTED",
    );
    await expect(local.create({ cols: 80, rows: 24 })).rejects.toThrow(
      "CONSOLE_LOCAL_TERMINALS_UNSUPPORTED",
    );
  });
});

// Read through Vite rather than `node:fs`: `apps/web` has no `@types/node`, and
// this assertion is about the shipped source, which is exactly what Vite sees.
const consoleSources = import.meta.glob("./*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("the console's frame path", () => {
  it("exists only inside the router", () => {
    const modules = Object.entries(consoleSources).filter(
      ([name]) => !name.includes(".test."),
    );

    expect(modules.length).toBeGreaterThan(3);
    for (const [name, text] of modules) {
      // `onOutputFrame` and `acknowledge` belong to `ProxyTerminalRouter`
      // alone. A console module calling either has built the second frame path
      // this whole design exists to prevent.
      expect({ name, calls: text.includes("onOutputFrame(") }).toEqual({
        name,
        calls: false,
      });
      expect({ name, calls: text.includes(".acknowledge(") }).toEqual({
        name,
        calls: false,
      });
      expect({ name, sends: text.includes('"terminal.list"') }).toEqual({
        name,
        sends: false,
      });
    }
  });
});

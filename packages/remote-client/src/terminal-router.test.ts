import type {
  AgentLaunchRequest,
  CreateTerminalRequest,
  OutputFrame,
  RemoteAgentExecutionTarget,
  RemoteTerminalDescriptor,
  TerminalDescriptor,
  TerminalOutputChunk,
} from "@codra/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ProxyTerminalRouter,
  type LocalTerminalRouterPort,
  type RemoteAgentPeerPort,
} from "./terminal-router";

const target: RemoteAgentExecutionTarget = {
  kind: "remote",
  deviceId: "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1",
  displayName: "Studio Mac",
};
const terminalId = "f4b0f73d-3406-48ec-a5c2-2cf290905e99";
const agent: AgentLaunchRequest = {
  kind: "codex",
  yolo: false,
  model: "gpt-5.6-sol",
  prompt: "Fix the login callback",
};

class LocalFake implements LocalTerminalRouterPort {
  readonly create = vi.fn(
    async (request: CreateTerminalRequest): Promise<TerminalDescriptor> => ({
      id: "731341f7-2f2e-4535-8727-a90baf762dc1",
      title: "Terminal",
      cwd: request.cwd ?? "/Users/local",
      cols: request.cols,
      rows: request.rows,
      state: "running",
      createdAt: "2026-08-02T00:00:00.000Z",
    }),
  );
  readonly write = vi.fn(async () => undefined);
  readonly resize = vi.fn(async () => undefined);
  readonly replay = vi.fn(async (): Promise<TerminalOutputChunk[]> => []);
  readonly close = vi.fn(async () => undefined);
  readonly closeAll = vi.fn(async () => undefined);
  private readonly output = new Set<(chunk: TerminalOutputChunk) => void>();
  private readonly changed = new Set<(value: TerminalDescriptor) => void>();

  async list(): Promise<TerminalDescriptor[]> {
    return [];
  }

  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void {
    this.output.add(listener);
    return () => this.output.delete(listener);
  }

  onChanged(listener: (value: TerminalDescriptor) => void): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }
}

class PeerFake implements RemoteAgentPeerPort {
  readonly launch = vi.fn(async (): Promise<RemoteTerminalDescriptor> => ({
    id: terminalId,
    title: "Codex · gpt-5.6-sol",
    cols: 100,
    rows: 30,
    state: "running",
    createdAt: "2026-08-02T00:00:00.000Z",
  }));
  readonly attach = vi.fn(async () => undefined);
  readonly write = vi.fn(async () => undefined);
  readonly resize = vi.fn(async () => undefined);
  readonly detach = vi.fn(async () => undefined);
  readonly acknowledge = vi.fn();
  private readonly output = new Set<(frame: OutputFrame) => void>();
  private readonly changed = new Set<
    (terminal: RemoteTerminalDescriptor) => void
  >();
  private readonly disconnected = new Set<(error: Error) => void>();

  onOutputFrame(listener: (frame: OutputFrame) => void): () => void {
    this.output.add(listener);
    return () => this.output.delete(listener);
  }

  onTerminalChanged(
    listener: (terminal: RemoteTerminalDescriptor) => void,
  ): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }

  onDisconnected(listener: (error: Error) => void): () => void {
    this.disconnected.add(listener);
    return () => this.disconnected.delete(listener);
  }

  emitOutput(frame: OutputFrame): void {
    for (const listener of this.output) listener(frame);
  }

  disconnect(): void {
    for (const listener of this.disconnected) {
      listener(new Error("TARGET_DISCONNECTED"));
    }
  }
}

function setup() {
  const local = new LocalFake();
  const peer = new PeerFake();
  const router = new ProxyTerminalRouter(local, (requestedTarget) => {
    expect(requestedTarget).toEqual(target);
    return peer;
  });
  return { local, peer, router };
}

describe("ProxyTerminalRouter", () => {
  it("launches remote agents without invoking the local terminal manager", async () => {
    const { local, peer, router } = setup();
    const request = {
      target,
      cwd: "/Users/remote/project",
      cols: 100,
      rows: 30,
      agent,
    } satisfies CreateTerminalRequest;

    await expect(router.create(request)).resolves.toEqual({
      id: terminalId,
      title: "Codex · gpt-5.6-sol",
      cwd: "/Users/remote/project",
      cols: 100,
      rows: 30,
      state: "running",
      createdAt: "2026-08-02T00:00:00.000Z",
      origin: target,
    });
    expect(peer.launch).toHaveBeenCalledWith(
      "/Users/remote/project",
      agent,
      100,
      30,
    );
    expect(local.create).not.toHaveBeenCalled();
  });

  it("routes input, resize, replay, output, and detach by the internal origin registry", async () => {
    const { local, peer, router } = setup();
    const chunks: TerminalOutputChunk[] = [];
    router.onOutput((chunk) => chunks.push(chunk));
    await router.create({
      target,
      cwd: "/Users/remote/project",
      cols: 100,
      rows: 30,
      agent,
    });
    peer.emitOutput({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("ready"),
    });

    await router.write({ terminalId, data: "ls\r" });
    await router.resize({ terminalId, cols: 120, rows: 40 });
    await expect(
      router.replay({ terminalId, afterSequence: 0, limit: 10 }),
    ).resolves.toEqual([{ terminalId, sequence: 1, data: "ready" }]);
    await router.close(terminalId);

    expect(chunks).toEqual([{ terminalId, sequence: 1, data: "ready" }]);
    expect(peer.acknowledge).toHaveBeenCalledWith(terminalId, 5n);
    expect(peer.write).toHaveBeenCalledWith(terminalId, "ls\r");
    expect(peer.resize).toHaveBeenCalledWith(terminalId, 120, 40);
    expect(peer.detach).toHaveBeenCalledWith(terminalId);
    expect(local.write).not.toHaveBeenCalled();
    expect(local.resize).not.toHaveBeenCalled();
    expect(local.close).not.toHaveBeenCalled();
  });

  it("marks remote descriptors exited on disconnect without falling back locally", async () => {
    const { local, peer, router } = setup();
    const changed: TerminalDescriptor[] = [];
    router.onChanged((descriptor) => changed.push(descriptor));
    await router.create({
      target,
      cwd: "/Users/remote/project",
      cols: 100,
      rows: 30,
      agent,
    });

    peer.disconnect();
    await expect(router.write({ terminalId, data: "pwd\r" })).rejects.toThrow(
      "TARGET_DISCONNECTED",
    );
    expect(changed.at(-1)).toMatchObject({
      id: terminalId,
      state: "exited",
      exitCode: -1,
      origin: target,
    });
    expect(local.write).not.toHaveBeenCalled();
  });

  it("resumes a dropped remote terminal and acknowledges replayed frames at their own boundary", async () => {
    const { peer, router } = setup();
    const chunks: TerminalOutputChunk[] = [];
    router.onOutput((chunk) => chunks.push(chunk));
    await router.create({
      target,
      cwd: "/Users/remote/project",
      cols: 100,
      rows: 30,
      agent,
    });
    peer.emitOutput({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("one"),
    });
    peer.disconnect();

    await router.resume(target);

    expect(peer.attach).toHaveBeenCalledWith(terminalId);
    peer.emitOutput({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("one"),
    });
    peer.emitOutput({
      terminalId,
      cursor: 3n,
      data: new TextEncoder().encode("two"),
    });

    expect(chunks).toEqual([
      { terminalId, sequence: 1, data: "one" },
      { terminalId, sequence: 2, data: "two" },
    ]);
    expect(peer.acknowledge).toHaveBeenNthCalledWith(2, terminalId, 3n);
    await expect(
      router.replay({ terminalId, afterSequence: 0, limit: 10 }),
    ).resolves.toEqual(chunks);
    await router.write({ terminalId, data: "ls\r" });
    expect(peer.write).toHaveBeenCalledWith(terminalId, "ls\r");
  });

  it("clamps a stale duplicate's acknowledgement to the highest cursor already sent", async () => {
    const { peer, router } = setup();
    await router.create({
      target,
      cwd: "/Users/remote/project",
      cols: 100,
      rows: 30,
      agent,
    });
    peer.emitOutput({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("one"),
    });
    peer.disconnect();
    await router.resume(target);

    // Advance well past the stale duplicate emitted below.
    peer.emitOutput({
      terminalId,
      cursor: 3n,
      data: new TextEncoder().encode("two"),
    });
    peer.emitOutput({
      terminalId,
      cursor: 6n,
      data: new TextEncoder().encode("three"),
    });
    expect(peer.acknowledge).toHaveBeenLastCalledWith(terminalId, 11n);

    // A stale, already-superseded resend of the very first frame arrives
    // late — this is what AttachmentPump's re-entrant pump() can produce
    // under output pressure (see acknowledgeAtLeast's comment). Acking its
    // own low frameEnd (3n) here would regress the cursor the host has
    // already recorded; the router must clamp to what it has already sent.
    peer.emitOutput({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("one"),
    });
    expect(peer.acknowledge).toHaveBeenLastCalledWith(terminalId, 11n);
  });

  it("resets the acknowledgement clamp on resume so a fresh pump's low cursors are accepted", async () => {
    const { peer, router } = setup();
    await router.create({
      target,
      cwd: "/Users/remote/project",
      cols: 100,
      rows: 30,
      agent,
    });
    // Build up a high acknowledgement watermark before the break.
    peer.emitOutput({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("one"),
    });
    peer.emitOutput({
      terminalId,
      cursor: 3n,
      data: new TextEncoder().encode("two"),
    });
    peer.emitOutput({
      terminalId,
      cursor: 6n,
      data: new TextEncoder().encode("three"),
    });
    expect(peer.acknowledge).toHaveBeenLastCalledWith(terminalId, 11n);

    peer.disconnect();
    await router.resume(target);

    // The host's fresh pump on resume starts its own bookkeeping back at
    // cursor 0 — it has no record of this session ever acking up to 11n.
    // A low-cursor duplicate of the very first frame must be acked at its
    // own (low) value, not clamped up to the pre-break high-water mark, or
    // the fresh AttachmentPump would see an ack above its own sentCursor
    // and throw OUTPUT_CURSOR_INVALID.
    peer.emitOutput({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("one"),
    });
    expect(peer.acknowledge).toHaveBeenLastCalledWith(terminalId, 3n);
  });

  it("tears the session down on a genuine cursor mismatch rather than absorbing it", async () => {
    const { local, peer, router } = setup();
    const changed: TerminalDescriptor[] = [];
    router.onChanged((descriptor) => changed.push(descriptor));
    await router.create({
      target,
      cwd: "/Users/remote/project",
      cols: 100,
      rows: 30,
      agent,
    });
    peer.emitOutput({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("one"),
    });

    // A frame whose cursor neither matches nextCursor nor falls entirely
    // within already-seen territory: genuine corruption or desync, not a
    // replay artifact the acknowledgement clamp is meant to absorb. The
    // clamp added for resume() must not blind this detector.
    peer.emitOutput({
      terminalId,
      cursor: 100n,
      data: new TextEncoder().encode("x"),
    });

    expect(changed.at(-1)).toMatchObject({
      id: terminalId,
      state: "exited",
      exitCode: -1,
      origin: target,
    });
    await expect(router.write({ terminalId, data: "pwd\r" })).rejects.toThrow(
      "TARGET_DISCONNECTED",
    );
    expect(local.write).not.toHaveBeenCalled();
  });
});

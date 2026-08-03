import type {
  AgentLaunchRequest,
  CreateTerminalRequest,
  OutputFrame,
  RemoteAgentExecutionTarget,
  RemoteTerminalDescriptor,
  ReplayTerminalRequest,
  ResizeTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
  WriteTerminalRequest,
} from "@codra/protocol";

const REMOTE_REPLAY_CHUNK_LIMIT = 1_000;
const REMOTE_REPLAY_BYTE_LIMIT = 1024 * 1024;

export interface LocalTerminalRouterPort {
  list(): Promise<TerminalDescriptor[]>;
  create(request: CreateTerminalRequest): Promise<TerminalDescriptor>;
  write(request: WriteTerminalRequest): Promise<void>;
  resize(request: ResizeTerminalRequest): Promise<void>;
  replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]>;
  close(terminalId: string): Promise<void>;
  closeAll(): Promise<void>;
  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void;
  onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void;
}

export interface RemoteAgentPeerPort {
  launch(
    cwd: string,
    agent: AgentLaunchRequest,
    cols: number,
    rows: number,
  ): Promise<RemoteTerminalDescriptor>;
  attach(terminalId: string): Promise<void>;
  write(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  detach(terminalId: string): Promise<void>;
  acknowledge(terminalId: string, cursor: bigint): void;
  onOutputFrame(listener: (frame: OutputFrame) => void): () => void;
  onTerminalChanged(
    listener: (terminal: RemoteTerminalDescriptor) => void,
  ): () => void;
  onDisconnected(listener: (error: Error) => void): () => void;
}

interface RemoteProxySession {
  descriptor: TerminalDescriptor;
  peer: RemoteAgentPeerPort;
  decoder: TextDecoder;
  chunks: TerminalOutputChunk[];
  cachedBytes: number;
  nextSequence: number;
  nextCursor?: bigint;
  // The highest cursor value this router has ever sent back to the peer as
  // an acknowledgement, for *this* attachment of the peer's AttachmentPump.
  // Tracked separately from nextCursor (which never regresses and survives
  // a resume) because acknowledgements must never regress either — see
  // acknowledgeAtLeast.
  lastAcknowledged?: bigint;
  connected: boolean;
  visible: boolean;
}

interface PeerSubscriptions {
  stops: Array<() => void>;
}

function createdAt(value: RemoteTerminalDescriptor["createdAt"]): string {
  return typeof value === "number"
    ? new Date(value).toISOString()
    : new Date(value).toISOString();
}

export class ProxyTerminalRouter implements LocalTerminalRouterPort {
  private readonly remoteSessions = new Map<string, RemoteProxySession>();
  private readonly remoteTerminalIds = new Set<string>();
  private readonly resuming = new Set<string>();
  private readonly peerSubscriptions = new Map<
    RemoteAgentPeerPort,
    PeerSubscriptions
  >();
  private readonly earlyFrames = new Map<string, OutputFrame[]>();
  private readonly outputListeners = new Set<
    (chunk: TerminalOutputChunk) => void
  >();
  private readonly changedListeners = new Set<
    (descriptor: TerminalDescriptor) => void
  >();

  constructor(
    private readonly local: LocalTerminalRouterPort,
    private readonly resolvePeer: (
      target: RemoteAgentExecutionTarget,
    ) => RemoteAgentPeerPort,
  ) {
    local.onOutput((chunk) => this.publishOutput(chunk));
    local.onChanged((descriptor) => this.publishChanged(descriptor));
  }

  async list(): Promise<TerminalDescriptor[]> {
    return [
      ...(await this.local.list()),
      ...[...this.remoteSessions.values()]
        .filter((session) => session.visible)
        .map((session) => session.descriptor),
    ];
  }

  async create(request: CreateTerminalRequest): Promise<TerminalDescriptor> {
    if (request.target?.kind !== "remote") {
      const { target: _target, ...localRequest } = request;
      void _target;
      return this.local.create(localRequest);
    }
    if (!request.agent || !request.cwd) {
      throw new Error("REMOTE_AGENT_REQUEST_REQUIRED");
    }
    const peer = this.resolvePeer(request.target);
    this.ensurePeer(peer);
    const remote = await peer.launch(
      request.cwd,
      request.agent,
      request.cols,
      request.rows,
    );
    const descriptor: TerminalDescriptor = {
      id: remote.id,
      title: remote.title,
      cwd: request.cwd,
      cols: remote.cols,
      rows: remote.rows,
      state: remote.state,
      createdAt: createdAt(remote.createdAt),
      ...(remote.exitCode === undefined ? {} : { exitCode: remote.exitCode }),
      origin: request.target,
    };
    const session: RemoteProxySession = {
      descriptor,
      peer,
      decoder: new TextDecoder("utf-8", { fatal: true }),
      chunks: [],
      cachedBytes: 0,
      nextSequence: 1,
      connected: true,
      visible: true,
    };
    this.remoteTerminalIds.add(remote.id);
    this.remoteSessions.set(remote.id, session);
    for (const frame of this.earlyFrames.get(remote.id) ?? []) {
      this.acceptFrame(frame);
    }
    this.earlyFrames.delete(remote.id);
    this.publishChanged(descriptor);
    return descriptor;
  }

  async resume(target: RemoteAgentExecutionTarget): Promise<void> {
    const peer = this.resolvePeer(target);
    this.ensurePeer(peer);
    for (const [terminalId, session] of this.remoteSessions) {
      const origin = session.descriptor.origin;
      if (session.connected || !session.visible) continue;
      if (origin?.kind !== "remote" || origin.deviceId !== target.deviceId) {
        continue;
      }
      if (this.resuming.has(terminalId)) continue;
      this.resuming.add(terminalId);
      session.peer = peer;
      session.connected = true;
      // The peer we are attaching to is a brand-new AttachmentPump on the
      // host, whose own sentCursor starts back at 0 — any ack cursor this
      // session sent before the break is meaningless to it now. Reset the
      // monotonic ack tracker so the first ack this session sends after
      // resuming is bounded only by what the new pump has actually sent
      // (see acknowledgeAtLeast below), not by a stale high-water mark left
      // over from the connection that just died.
      session.lastAcknowledged = undefined;
      try {
        await peer.attach(terminalId);
        session.descriptor = {
          ...session.descriptor,
          state: "running",
          exitCode: undefined,
        };
        this.publishChanged(session.descriptor);
      } catch (error) {
        this.disconnectSession(session);
        throw error;
      } finally {
        this.resuming.delete(terminalId);
      }
    }
  }

  async write(request: WriteTerminalRequest): Promise<void> {
    const session = this.remoteSessions.get(request.terminalId);
    if (session) {
      this.requireConnected(session);
      await session.peer.write(request.terminalId, request.data);
      return;
    }
    if (this.remoteTerminalIds.has(request.terminalId)) {
      throw new Error("TARGET_DISCONNECTED");
    }
    await this.local.write(request);
  }

  async resize(request: ResizeTerminalRequest): Promise<void> {
    const session = this.remoteSessions.get(request.terminalId);
    if (session) {
      this.requireConnected(session);
      await session.peer.resize(request.terminalId, request.cols, request.rows);
      session.descriptor = {
        ...session.descriptor,
        cols: request.cols,
        rows: request.rows,
      };
      return;
    }
    if (this.remoteTerminalIds.has(request.terminalId)) {
      throw new Error("TARGET_DISCONNECTED");
    }
    await this.local.resize(request);
  }

  async replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]> {
    const session = this.remoteSessions.get(request.terminalId);
    if (session) {
      return session.chunks
        .filter((chunk) => chunk.sequence > request.afterSequence)
        .slice(0, request.limit);
    }
    if (this.remoteTerminalIds.has(request.terminalId)) return [];
    return this.local.replay(request);
  }

  async close(terminalId: string): Promise<void> {
    const session = this.remoteSessions.get(terminalId);
    if (session) {
      if (session.connected) await session.peer.detach(terminalId);
      session.connected = false;
      session.visible = false;
      session.descriptor = {
        ...session.descriptor,
        state: "exited",
        exitCode: session.descriptor.exitCode ?? 0,
      };
      return;
    }
    if (this.remoteTerminalIds.has(terminalId)) return;
    await this.local.close(terminalId);
  }

  async closeAll(): Promise<void> {
    const remote = [...this.remoteSessions.entries()].map(
      async ([terminalId, session]) => {
        if (session.connected) await session.peer.detach(terminalId);
        session.connected = false;
        session.visible = false;
      },
    );
    await Promise.allSettled(remote);
    await this.local.closeAll();
    for (const subscription of this.peerSubscriptions.values()) {
      for (const stop of subscription.stops) stop();
    }
    this.peerSubscriptions.clear();
  }

  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  private ensurePeer(peer: RemoteAgentPeerPort): void {
    if (this.peerSubscriptions.has(peer)) return;
    this.peerSubscriptions.set(peer, {
      stops: [
        peer.onOutputFrame((frame) => this.acceptFrame(frame)),
        peer.onTerminalChanged((terminal) =>
          this.acceptTerminalChange(peer, terminal),
        ),
        peer.onDisconnected(() => this.disconnectPeer(peer)),
      ],
    });
  }

  private acceptFrame(frame: OutputFrame): void {
    const session = this.remoteSessions.get(frame.terminalId);
    if (!session) {
      const queued = this.earlyFrames.get(frame.terminalId) ?? [];
      if (queued.length < 64) queued.push(frame);
      this.earlyFrames.set(frame.terminalId, queued);
      return;
    }
    if (!session.connected) return;
    const frameEnd = frame.cursor + BigInt(frame.data.byteLength);
    if (session.nextCursor !== undefined) {
      if (frameEnd <= session.nextCursor) {
        this.acknowledgeAtLeast(session, frame.terminalId, frameEnd);
        return;
      }
      if (frame.cursor !== session.nextCursor) {
        this.disconnectSession(session);
        return;
      }
    }
    let data: string;
    try {
      data = session.decoder.decode(frame.data, { stream: true });
    } catch {
      this.disconnectSession(session);
      return;
    }
    session.nextCursor = frameEnd;
    if (data) {
      const chunk = {
        terminalId: frame.terminalId,
        sequence: session.nextSequence++,
        data,
      };
      session.chunks.push(chunk);
      session.cachedBytes += new TextEncoder().encode(data).byteLength;
      this.trimReplay(session);
      this.publishOutput(chunk);
    }
    this.acknowledgeAtLeast(session, frame.terminalId, frameEnd);
  }

  // AttachmentPump.pump() re-reads from its own acknowledgedCursor on every
  // trigger (see packages/webrtc/src/attachment-pump.ts), and the host
  // processes incoming control messages without serializing them against
  // one another (DesktopPeerConnector.acceptHostSession's `onMessage`
  // handler fires `handleHostControl` without awaiting the previous call).
  // Under output pressure — exactly what a fake agent ticking every 200ms
  // produces — this lets a *stale* pump() call, still mid-flight on an
  // earlier (lower) acknowledgedCursor snapshot, resend a range the host
  // has already sent (and this router has already absorbed) after newer,
  // higher acknowledgements have already landed. That stale resend reaches
  // this method again here, and its own frameEnd is genuinely lower than
  // what this session already told the host. Acking that frameEnd verbatim
  // would regress the cursor value sent to the host's AttachmentPump,
  // which throws OUTPUT_CURSOR_INVALID on any cursor below what it already
  // has recorded as acknowledged (attachment-pump.ts's `acknowledge`) —
  // tearing the whole session down over what is, on this end, a duplicate
  // frame it already discarded correctly. Tracking the highest cursor this
  // session has ever sent and only ever sending forward from there makes
  // every acknowledgement to the peer monotonic, matching what
  // AttachmentPump requires, regardless of how many times the same range
  // gets redelivered or in what order those redeliveries are processed.
  private acknowledgeAtLeast(
    session: RemoteProxySession,
    terminalId: string,
    cursor: bigint,
  ): void {
    const next =
      session.lastAcknowledged === undefined ||
      cursor > session.lastAcknowledged
        ? cursor
        : session.lastAcknowledged;
    session.lastAcknowledged = next;
    session.peer.acknowledge(terminalId, next);
  }

  private acceptTerminalChange(
    peer: RemoteAgentPeerPort,
    remote: RemoteTerminalDescriptor,
  ): void {
    const session = this.remoteSessions.get(remote.id);
    if (!session || session.peer !== peer) return;
    session.descriptor = {
      ...session.descriptor,
      title: remote.title,
      cols: remote.cols,
      rows: remote.rows,
      state: remote.state,
      ...(remote.exitCode === undefined
        ? { exitCode: undefined }
        : { exitCode: remote.exitCode }),
    };
    if (remote.state === "exited") session.connected = false;
    this.publishChanged(session.descriptor);
  }

  private disconnectPeer(peer: RemoteAgentPeerPort): void {
    for (const session of this.remoteSessions.values()) {
      if (session.peer === peer) this.disconnectSession(session);
    }
  }

  private disconnectSession(session: RemoteProxySession): void {
    if (!session.connected) return;
    session.connected = false;
    session.descriptor = {
      ...session.descriptor,
      state: "exited",
      exitCode: -1,
    };
    this.publishChanged(session.descriptor);
  }

  private requireConnected(session: RemoteProxySession): void {
    if (!session.connected) throw new Error("TARGET_DISCONNECTED");
  }

  private trimReplay(session: RemoteProxySession): void {
    while (
      session.chunks.length > REMOTE_REPLAY_CHUNK_LIMIT ||
      session.cachedBytes > REMOTE_REPLAY_BYTE_LIMIT
    ) {
      const removed = session.chunks.shift();
      if (!removed) break;
      session.cachedBytes -= new TextEncoder().encode(removed.data).byteLength;
    }
  }

  private publishOutput(chunk: TerminalOutputChunk): void {
    for (const listener of this.outputListeners) listener(chunk);
  }

  private publishChanged(descriptor: TerminalDescriptor): void {
    for (const listener of this.changedListeners) listener(descriptor);
  }
}

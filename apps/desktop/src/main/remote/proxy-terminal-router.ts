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
        session.peer.acknowledge(frame.terminalId, session.nextCursor);
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
    session.peer.acknowledge(frame.terminalId, frameEnd);
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

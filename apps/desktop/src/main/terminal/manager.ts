import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
  CreateTerminalRequest,
  ReplayTerminalRequest,
  ResizeTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
  WriteTerminalRequest,
} from "@codra/protocol";
import type {
  PtyFactory,
  PtyHandle,
  TerminalOutputStore,
  TerminalRepository,
} from "./contracts";

export class TerminalError extends Error {
  constructor(readonly code: "TERMINAL_NOT_FOUND") {
    super(code);
    this.name = "TerminalError";
  }
}

interface TerminalSession {
  descriptor: TerminalDescriptor;
  pty?: PtyHandle;
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
  outputQueue: Promise<void>;
  closeRequested: boolean;
  finished: boolean;
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly outputListeners = new Set<
    (chunk: TerminalOutputChunk) => void
  >();
  private readonly changedListeners = new Set<
    (descriptor: TerminalDescriptor) => void
  >();

  constructor(
    private readonly ptyFactory: PtyFactory,
    private readonly repository: TerminalRepository,
    private readonly outputStore: TerminalOutputStore,
  ) {}

  async create(request: CreateTerminalRequest): Promise<TerminalDescriptor> {
    const cwd = request.cwd ?? homedir();
    const descriptor: TerminalDescriptor = {
      id: randomUUID(),
      title: "Terminal",
      cwd,
      cols: request.cols,
      rows: request.rows,
      state: "running",
      createdAt: new Date().toISOString(),
    };
    const pty = this.ptyFactory.spawn({ ...request, cwd });
    const session: TerminalSession = {
      descriptor,
      pty,
      unsubscribeData: () => {},
      unsubscribeExit: () => {},
      outputQueue: Promise.resolve(),
      closeRequested: false,
      finished: false,
    };

    await this.repository.save(descriptor);
    this.sessions.set(descriptor.id, session);
    session.unsubscribeData = pty.onData((data) => {
      this.enqueueOutput(session, data);
    });
    session.unsubscribeExit = pty.onExit((exitCode) => {
      void this.finish(session, session.closeRequested ? 0 : exitCode).catch(
        () => {},
      );
    });
    this.publishChanged(descriptor);
    return descriptor;
  }

  async list(): Promise<TerminalDescriptor[]> {
    return this.repository.list();
  }

  async write(request: WriteTerminalRequest): Promise<void> {
    this.getActiveSession(request.terminalId).pty?.write(request.data);
  }

  async resize(request: ResizeTerminalRequest): Promise<void> {
    const session = this.getActiveSession(request.terminalId);
    session.pty?.resize(request.cols, request.rows);
    const descriptor = {
      ...session.descriptor,
      cols: request.cols,
      rows: request.rows,
    };
    session.descriptor = descriptor;
    await this.repository.update(descriptor);
    this.publishChanged(descriptor);
  }

  async replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]> {
    this.getSession(request.terminalId);
    return this.outputStore.readAfter(
      request.terminalId,
      request.afterSequence,
      request.limit,
    );
  }

  async close(terminalId: string): Promise<void> {
    const session = this.getSession(terminalId);
    if (session.finished) return;
    session.closeRequested = true;
    session.pty?.kill();
    await this.finish(session, 0);
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => !session.finished)
        .map((session) => this.close(session.descriptor.id)),
    );
  }

  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  private getSession(terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) throw new TerminalError("TERMINAL_NOT_FOUND");
    return session;
  }

  private getActiveSession(terminalId: string): TerminalSession {
    const session = this.getSession(terminalId);
    if (session.finished || !session.pty) {
      throw new TerminalError("TERMINAL_NOT_FOUND");
    }
    return session;
  }

  private enqueueOutput(session: TerminalSession, data: string): void {
    session.outputQueue = session.outputQueue
      .then(async () => {
        const chunk = await this.outputStore.append(
          session.descriptor.id,
          data,
        );
        this.publishOutput(chunk);
      })
      .catch(() => {});
  }

  private async finish(
    session: TerminalSession,
    exitCode: number,
  ): Promise<void> {
    if (session.finished) return;
    session.finished = true;
    session.unsubscribeData();
    session.unsubscribeExit();
    session.pty = undefined;
    const descriptor: TerminalDescriptor = {
      ...session.descriptor,
      state: "exited",
      exitCode,
    };
    session.descriptor = descriptor;
    await this.repository.update(descriptor);
    this.publishChanged(descriptor);
  }

  private publishOutput(chunk: TerminalOutputChunk): void {
    for (const listener of this.outputListeners) listener(chunk);
  }

  private publishChanged(descriptor: TerminalDescriptor): void {
    for (const listener of this.changedListeners) listener(descriptor);
  }
}

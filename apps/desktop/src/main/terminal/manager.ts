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
import { agentTerminalTitle } from "./agent-runtime";

const FINALIZATION_TIMEOUT_MS = 1_000;

export type TerminalErrorReporter = (error: unknown) => void;

export class TerminalError extends Error {
  constructor(
    readonly code: "TERMINAL_NOT_FOUND" | "TERMINAL_TERMINATION_FAILED",
    message: string = code,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

export class TerminalTerminationError extends TerminalError {
  constructor(terminalId: string) {
    super(
      "TERMINAL_TERMINATION_FAILED",
      `Terminal ${terminalId} did not exit after SIGKILL`,
    );
    this.name = "TerminalTerminationError";
  }
}

type FinalizationCause =
  { kind: "close"; exitCode: 0 } | { kind: "native"; exitCode: number };

interface TerminalSession {
  descriptor: TerminalDescriptor;
  pty?: PtyHandle;
  unsubscribeData?: () => void;
  unsubscribeExit?: () => void;
  outputTail: Promise<void>;
  outputError?: unknown;
  descriptorTail: Promise<void>;
  pendingOutput: string[];
  acceptingInput: boolean;
  created: boolean;
  rolledBack: boolean;
  saveAttempted: boolean;
  exitResolved: boolean;
  nativeExitCode?: number;
  exitPromise: Promise<number>;
  resolveExit: (exitCode: number) => void;
  finalizationCause?: FinalizationCause;
  finalizationPromise?: Promise<void>;
}

function createExitSignal(): Pick<
  TerminalSession,
  "exitPromise" | "resolveExit"
> {
  let resolveExit!: (exitCode: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return { exitPromise, resolveExit };
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
    private readonly errorReporter: TerminalErrorReporter = (error) => {
      console.error("TerminalManager internal error", error);
    },
  ) {}

  async create(request: CreateTerminalRequest): Promise<TerminalDescriptor> {
    const cwd = request.cwd ?? homedir();
    const descriptor: TerminalDescriptor = {
      id: randomUUID(),
      title: request.agent
        ? agentTerminalTitle(request.agent.kind, request.agent.model)
        : request.agentSetup
          ? `Setup ${agentTerminalTitle(request.agentSetup.kind)}`
          : "Terminal",
      cwd,
      cols: request.cols,
      rows: request.rows,
      state: "running",
      createdAt: new Date().toISOString(),
    };
    const pty = this.ptyFactory.spawn({ ...request, cwd });
    const exitSignal = createExitSignal();
    const session: TerminalSession = {
      descriptor,
      pty,
      outputTail: Promise.resolve(),
      descriptorTail: Promise.resolve(),
      pendingOutput: [],
      acceptingInput: true,
      created: false,
      rolledBack: false,
      saveAttempted: false,
      exitResolved: false,
      ...exitSignal,
    };
    this.sessions.set(descriptor.id, session);

    try {
      session.unsubscribeExit = pty.onExit((exitCode) => {
        this.handleExit(session, exitCode);
      });
      session.unsubscribeData = pty.onData((data) => {
        this.handleData(session, data);
      });
      session.saveAttempted = true;
      await this.repository.save(descriptor);
      session.created = true;
      for (const data of session.pendingOutput.splice(0)) {
        this.enqueueOutput(session, data);
      }
      this.publishChanged(descriptor);
      if (session.exitResolved) {
        this.startFinalization(session, {
          kind: "native",
          exitCode: session.nativeExitCode ?? -1,
        });
      }
      return descriptor;
    } catch (error) {
      await this.rollbackCreation(session, error);
      throw error;
    }
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
    await this.enqueueDescriptorTransition(session, async () => {
      const descriptor: TerminalDescriptor = {
        ...session.descriptor,
        cols: request.cols,
        rows: request.rows,
      };
      await this.repository.update(descriptor);
      session.descriptor = descriptor;
      this.publishChanged(descriptor);
    });
  }

  async replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]> {
    if (
      !this.sessions.has(request.terminalId) &&
      (await this.repository.find(request.terminalId)) === undefined
    ) {
      throw new TerminalError("TERMINAL_NOT_FOUND");
    }
    return this.outputStore.readAfter(
      request.terminalId,
      request.afterSequence,
      request.limit,
    );
  }

  async close(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (session) {
      return this.startFinalization(session, {
        kind: "close",
        exitCode: 0,
      });
    }
    const persisted = await this.repository.find(terminalId);
    if (persisted?.state === "exited") return;
    throw new TerminalError("TERMINAL_NOT_FOUND");
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) =>
        this.startFinalization(session, { kind: "close", exitCode: 0 }),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
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
    if (!session.acceptingInput || !session.pty) {
      throw new TerminalError("TERMINAL_NOT_FOUND");
    }
    return session;
  }

  private handleData(session: TerminalSession, data: string): void {
    if (session.rolledBack) return;
    if (!session.created) {
      session.pendingOutput.push(data);
      return;
    }
    this.enqueueOutput(session, data);
  }

  private handleExit(session: TerminalSession, exitCode: number): void {
    if (session.rolledBack || session.exitResolved) return;
    session.exitResolved = true;
    session.nativeExitCode = exitCode;
    session.resolveExit(exitCode);
    if (session.created) {
      this.startFinalization(session, { kind: "native", exitCode });
    }
  }

  private enqueueOutput(session: TerminalSession, data: string): void {
    const operation = session.outputTail.then(async () => {
      const chunk = await this.outputStore.append(session.descriptor.id, data);
      this.publishOutput(chunk);
    });
    operation.catch((error: unknown) => {
      session.outputError ??= error;
      this.report(error);
    });
    session.outputTail = operation.then(
      () => undefined,
      () => undefined,
    );
  }

  private enqueueDescriptorTransition<T>(
    session: TerminalSession,
    transition: () => Promise<T>,
  ): Promise<T> {
    const operation = session.descriptorTail.then(transition);
    operation.catch((error: unknown) => this.report(error));
    session.descriptorTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private startFinalization(
    session: TerminalSession,
    requestedCause: FinalizationCause,
  ): Promise<void> {
    session.acceptingInput = false;
    if (session.finalizationPromise) return session.finalizationPromise;
    session.finalizationCause ??= requestedCause;
    const cause = session.finalizationCause;

    let resolveFinalization!: () => void;
    let rejectFinalization!: (error: unknown) => void;
    const finalizationPromise = new Promise<void>((resolve, reject) => {
      resolveFinalization = resolve;
      rejectFinalization = reject;
    });
    session.finalizationPromise = finalizationPromise;
    finalizationPromise.catch((error: unknown) => this.report(error));
    void this.runFinalization(session, cause).then(
      resolveFinalization,
      (error) => {
        if (error instanceof TerminalTerminationError) {
          session.finalizationPromise = undefined;
        }
        rejectFinalization(error);
      },
    );
    return finalizationPromise;
  }

  private async runFinalization(
    session: TerminalSession,
    cause: FinalizationCause,
  ): Promise<void> {
    let lifecycleError: unknown;
    if (cause.kind === "close" && !session.exitResolved) {
      try {
        session.pty?.kill();
      } catch (error) {
        lifecycleError = error;
        this.report(error);
      }
      if (!(await this.waitForNativeExit(session))) {
        try {
          session.pty?.kill("SIGKILL");
        } catch (error) {
          lifecycleError ??= error;
          this.report(error);
        }
        if (!(await this.waitForNativeExit(session))) {
          throw new TerminalTerminationError(session.descriptor.id);
        }
      }
    }

    if (!session.exitResolved) {
      throw new TerminalTerminationError(session.descriptor.id);
    }
    const dataDisposalError = this.disposeListener(session.unsubscribeData);
    const exitDisposalError = this.disposeListener(session.unsubscribeExit);
    lifecycleError ??= dataDisposalError;
    lifecycleError ??= exitDisposalError;
    session.unsubscribeData = undefined;
    session.unsubscribeExit = undefined;
    await session.outputTail;

    let descriptorError: unknown;
    try {
      await this.enqueueDescriptorTransition(session, async () => {
        const descriptor: TerminalDescriptor = {
          ...session.descriptor,
          state: "exited",
          exitCode: cause.exitCode,
        };
        await this.repository.update(descriptor);
        session.descriptor = descriptor;
        this.publishChanged(descriptor);
      });
    } catch (error) {
      descriptorError = error;
    } finally {
      session.pty = undefined;
    }

    if (descriptorError !== undefined) throw descriptorError;
    if (session.outputError !== undefined) throw session.outputError;
    if (lifecycleError !== undefined) throw lifecycleError;
  }

  private async waitForNativeExit(session: TerminalSession): Promise<boolean> {
    if (session.exitResolved) return true;
    let timeout: number | NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        session.exitPromise.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), FINALIZATION_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async rollbackCreation(
    session: TerminalSession,
    cause: unknown,
  ): Promise<void> {
    this.report(cause);
    session.rolledBack = true;
    session.acceptingInput = false;
    session.pendingOutput.length = 0;
    this.sessions.delete(session.descriptor.id);
    this.disposeListener(session.unsubscribeData);
    this.disposeListener(session.unsubscribeExit);
    session.unsubscribeData = undefined;
    session.unsubscribeExit = undefined;
    try {
      session.pty?.kill();
    } catch (error) {
      this.report(error);
    }
    session.pty = undefined;

    if (session.saveAttempted) {
      const descriptor: TerminalDescriptor = {
        ...session.descriptor,
        state: "exited",
        exitCode: -1,
      };
      try {
        await this.repository.update(descriptor);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private disposeListener(unsubscribe?: () => void): unknown {
    if (!unsubscribe) return undefined;
    try {
      unsubscribe();
      return undefined;
    } catch (error) {
      this.report(error);
      return error;
    }
  }

  private publishOutput(chunk: TerminalOutputChunk): void {
    this.publishTo(this.outputListeners, chunk);
  }

  private publishChanged(descriptor: TerminalDescriptor): void {
    this.publishTo(this.changedListeners, descriptor);
  }

  private publishTo<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try {
        const result = (listener as (value: T) => unknown)(value);
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.report(error));
        }
      } catch (error) {
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.errorReporter(error);
    } catch (reporterError) {
      console.error("TerminalManager error reporter failed", reporterError);
    }
  }
}

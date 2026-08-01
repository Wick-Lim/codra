import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CreateTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
} from "@codra/protocol";
import type {
  PtyFactory,
  PtyHandle,
  TerminalOutputStore,
  TerminalRepository,
} from "./contracts";
import { TerminalError, TerminalManager } from "./manager";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakePty implements PtyHandle {
  readonly pid = 42;
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  readonly killSignals: Array<string | undefined> = [];
  exitOnKill = true;
  dataOnSubscribe?: string;
  exitOnSubscribe?: number;
  dataRegistrationError?: Error;
  exitRegistrationError?: Error;
  dataDisposalError?: Error;
  exitDisposalError?: Error;
  dataDisposals = 0;
  exitDisposals = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }

  kill(signal?: string): void {
    this.killSignals.push(signal);
    if (this.exitOnKill) this.emitExit(0);
  }

  get kills(): number {
    return this.killSignals.length;
  }

  onData(listener: (data: string) => void): () => void {
    if (this.dataRegistrationError) throw this.dataRegistrationError;
    this.dataListeners.add(listener);
    if (this.dataOnSubscribe !== undefined) listener(this.dataOnSubscribe);
    return () => {
      this.dataDisposals += 1;
      this.dataListeners.delete(listener);
      if (this.dataDisposalError) throw this.dataDisposalError;
    };
  }

  onExit(listener: (exitCode: number) => void): () => void {
    if (this.exitRegistrationError) throw this.exitRegistrationError;
    this.exitListeners.add(listener);
    if (this.exitOnSubscribe !== undefined) listener(this.exitOnSubscribe);
    return () => {
      this.exitDisposals += 1;
      this.exitListeners.delete(listener);
      if (this.exitDisposalError) throw this.exitDisposalError;
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener(exitCode);
  }

  get subscriptions(): { data: number; exit: number } {
    return { data: this.dataListeners.size, exit: this.exitListeners.size };
  }
}

class MemoryRepository implements TerminalRepository {
  readonly descriptors = new Map<string, TerminalDescriptor>();
  readonly saves: TerminalDescriptor[] = [];
  readonly updates: TerminalDescriptor[] = [];
  saveError?: Error;
  persistBeforeSaveError = false;
  updateError?: Error;
  private nextUpdateGate?: Deferred;
  private nextUpdateStarted?: Deferred;

  async save(descriptor: TerminalDescriptor): Promise<void> {
    this.saves.push(descriptor);
    if (this.persistBeforeSaveError) {
      this.descriptors.set(descriptor.id, descriptor);
    }
    if (this.saveError) throw this.saveError;
    this.descriptors.set(descriptor.id, descriptor);
  }

  async update(descriptor: TerminalDescriptor): Promise<void> {
    this.updates.push(descriptor);
    const gate = this.nextUpdateGate;
    const started = this.nextUpdateStarted;
    this.nextUpdateGate = undefined;
    this.nextUpdateStarted = undefined;
    started?.resolve();
    await gate?.promise;
    if (this.updateError) throw this.updateError;
    if (this.descriptors.has(descriptor.id)) {
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  async list(): Promise<TerminalDescriptor[]> {
    return [...this.descriptors.values()];
  }

  async markRunningExited(): Promise<void> {}

  delayNextUpdate(): { started: Promise<void>; release(): void } {
    const gate = createDeferred();
    const started = createDeferred();
    this.nextUpdateGate = gate;
    this.nextUpdateStarted = started;
    return { started: started.promise, release: () => gate.resolve() };
  }
}

class MemoryOutputStore implements TerminalOutputStore {
  readonly chunks: TerminalOutputChunk[] = [];
  private readonly appendWaiters: Array<() => void> = [];
  private readonly appendAttemptWaiters: Array<() => void> = [];
  private nextSequence = 1;
  private appendGate: Promise<void> | undefined;
  appendError?: Error;

  delayAppends(): { release(): void } {
    let release!: () => void;
    this.appendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      release: () => {
        this.appendGate = undefined;
        release();
      },
    };
  }

  async append(terminalId: string, data: string): Promise<TerminalOutputChunk> {
    this.appendAttemptWaiters.splice(0).forEach((resolve) => resolve());
    await this.appendGate;
    if (this.appendError) throw this.appendError;
    const chunk = { terminalId, sequence: this.nextSequence++, data };
    this.chunks.push(chunk);
    this.appendWaiters.splice(0).forEach((resolve) => resolve());
    return chunk;
  }

  async readAfter(
    terminalId: string,
    afterSequence: number,
    limit: number,
  ): Promise<TerminalOutputChunk[]> {
    return this.chunks
      .filter(
        (chunk) =>
          chunk.terminalId === terminalId && chunk.sequence > afterSequence,
      )
      .slice(0, limit);
  }

  async remove(): Promise<void> {}

  async whenAppended(): Promise<void> {
    if (this.chunks.length > 0) return;
    await new Promise<void>((resolve) => this.appendWaiters.push(resolve));
  }

  async whenAppendAttempted(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.appendAttemptWaiters.push(resolve),
    );
  }
}

function createHarness(options?: {
  pty?: FakePty;
  repository?: MemoryRepository;
  outputStore?: MemoryOutputStore;
  reporter?: (error: unknown) => void;
}) {
  const pty = options?.pty ?? new FakePty();
  const repository = options?.repository ?? new MemoryRepository();
  const outputStore = options?.outputStore ?? new MemoryOutputStore();
  const reporter = options?.reporter ?? vi.fn();
  const factory: PtyFactory = { spawn: vi.fn(() => pty) };
  const manager = new TerminalManager(
    factory,
    repository,
    outputStore,
    reporter,
  );
  const published: TerminalOutputChunk[] = [];
  const changed: TerminalDescriptor[] = [];
  manager.onOutput((chunk) => published.push(chunk));
  manager.onChanged((descriptor) => changed.push(descriptor));
  return {
    manager,
    pty,
    repository,
    outputStore,
    published,
    changed,
    factory,
    reporter,
  };
}

const request: CreateTerminalRequest = { cols: 80, rows: 24 };

describe("TerminalManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the home directory defaults and saves a running descriptor", async () => {
    const { manager, repository, factory, changed } = createHarness();
    vi.stubEnv("HOME", "/test-home");

    const terminal = await manager.create(request);

    expect(factory.spawn).toHaveBeenCalledWith({
      ...request,
      cwd: "/test-home",
    });
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      id: terminal.id,
      cwd: "/test-home",
      cols: 80,
      rows: 24,
      state: "running",
    });
    expect(changed).toEqual([terminal]);
  });

  it("rolls back a partially persisted descriptor when save fails", async () => {
    const repository = new MemoryRepository();
    const saveError = new Error("save failed after commit");
    repository.saveError = saveError;
    repository.persistBeforeSaveError = true;
    const { manager, pty, reporter } = createHarness({ repository });

    await expect(manager.create(request)).rejects.toBe(saveError);

    const descriptor = [...repository.descriptors.values()][0];
    expect(descriptor).toMatchObject({ state: "exited", exitCode: -1 });
    expect(pty.kills).toBe(1);
    expect(pty.subscriptions).toEqual({ data: 0, exit: 0 });
    await expect(manager.close(descriptor.id)).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    });
    expect(reporter).toHaveBeenCalledWith(saveError);
  });

  it("disposes the exit listener and child when data registration fails", async () => {
    const pty = new FakePty();
    const registrationError = new Error("data registration failed");
    pty.dataRegistrationError = registrationError;
    const { manager, repository, reporter } = createHarness({ pty });

    await expect(manager.create(request)).rejects.toBe(registrationError);

    expect(repository.saves).toHaveLength(0);
    expect(pty.kills).toBe(1);
    expect(pty.exitDisposals).toBe(1);
    expect(pty.subscriptions).toEqual({ data: 0, exit: 0 });
    expect(reporter).toHaveBeenCalledWith(registrationError);
  });

  it("kills the child and removes map state when exit registration fails", async () => {
    const pty = new FakePty();
    const registrationError = new Error("exit registration failed");
    pty.exitRegistrationError = registrationError;
    const { manager, repository, reporter } = createHarness({ pty });

    await expect(manager.create(request)).rejects.toBe(registrationError);

    expect(repository.saves).toHaveLength(0);
    expect(pty.kills).toBe(1);
    expect(pty.subscriptions).toEqual({ data: 0, exit: 0 });
    expect(reporter).toHaveBeenCalledWith(registrationError);
  });

  it("captures output emitted synchronously while listeners are installed", async () => {
    const pty = new FakePty();
    pty.dataOnSubscribe = "early output";
    const { manager, outputStore } = createHarness({ pty });

    const terminal = await manager.create(request);
    await outputStore.whenAppended();

    expect(outputStore.chunks).toEqual([
      { terminalId: terminal.id, sequence: 1, data: "early output" },
    ]);
  });

  it("persists output before publishing it", async () => {
    const { manager, pty, outputStore, published } = createHarness();
    const terminal = await manager.create(request);
    pty.emitData("hello\r\n");
    await outputStore.whenAppended();

    expect(outputStore.chunks).toEqual([
      { terminalId: terminal.id, sequence: 1, data: "hello\r\n" },
    ]);
    expect(published).toEqual(outputStore.chunks);
  });

  it("preserves output arrival order when appends resolve asynchronously", async () => {
    const { manager, pty, outputStore, published } = createHarness();
    const terminal = await manager.create(request);
    const gate = outputStore.delayAppends();

    pty.emitData("one");
    pty.emitData("two");
    gate.release();
    await vi.waitFor(() => expect(published).toHaveLength(2));

    expect(published).toEqual([
      { terminalId: terminal.id, sequence: 1, data: "one" },
      { terminalId: terminal.id, sequence: 2, data: "two" },
    ]);
  });

  it("reports output failures and makes close observe them", async () => {
    const outputStore = new MemoryOutputStore();
    const appendError = new Error("append failed");
    outputStore.appendError = appendError;
    const { manager, pty, repository, reporter } = createHarness({
      outputStore,
    });
    const terminal = await manager.create(request);

    pty.emitData("lost");
    await outputStore.whenAppendAttempted();

    await expect(manager.close(terminal.id)).rejects.toBe(appendError);
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      state: "exited",
    });
    expect(reporter).toHaveBeenCalledWith(appendError);
  });

  it("isolates throwing and rejecting subscribers from other subscribers", async () => {
    const reporter = vi.fn();
    const { manager, pty, outputStore } = createHarness({ reporter });
    const changed: TerminalDescriptor[] = [];
    const output: TerminalOutputChunk[] = [];
    const syncError = new Error("sync subscriber failed");
    const asyncError = new Error("async subscriber failed");
    manager.onChanged(() => {
      throw syncError;
    });
    manager.onChanged(async () => {
      throw asyncError;
    });
    manager.onChanged((descriptor) => changed.push(descriptor));
    manager.onOutput(() => {
      throw syncError;
    });
    manager.onOutput((chunk) => output.push(chunk));

    const terminal = await manager.create(request);
    pty.emitData("visible");
    await outputStore.whenAppended();

    expect(changed).toEqual([terminal]);
    expect(output).toEqual([
      { terminalId: terminal.id, sequence: 1, data: "visible" },
    ]);
    await vi.waitFor(() => {
      expect(reporter).toHaveBeenCalledWith(syncError);
      expect(reporter).toHaveBeenCalledWith(asyncError);
    });
  });

  it("routes validated input and resize to the selected PTY", async () => {
    const { manager, pty, changed } = createHarness();
    const terminal = await manager.create(request);
    await manager.write({ terminalId: terminal.id, data: "pwd\r" });
    await manager.resize({ terminalId: terminal.id, cols: 120, rows: 40 });

    expect(pty.writes).toEqual(["pwd\r"]);
    expect(pty.sizes).toContainEqual([120, 40]);
    expect(changed.at(-1)).toMatchObject({
      id: terminal.id,
      cols: 120,
      rows: 40,
    });
  });

  it("rejects operations on unknown terminal IDs", async () => {
    const { manager } = createHarness();
    const terminalId = randomUUID();

    await expect(
      manager.write({ terminalId, data: "pwd\r" }),
    ).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    } satisfies Partial<TerminalError>);
    await expect(
      manager.resize({ terminalId, cols: 80, rows: 24 }),
    ).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    } satisfies Partial<TerminalError>);
    await expect(manager.close(terminalId)).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    } satisfies Partial<TerminalError>);
  });

  it("replays persisted scrollback without a running PTY", async () => {
    const { manager, pty } = createHarness();
    const terminal = await manager.create(request);
    pty.emitData("first");
    await vi.waitFor(async () => {
      expect(
        await manager.replay({
          terminalId: terminal.id,
          afterSequence: 0,
          limit: 20,
        }),
      ).toHaveLength(1);
    });
    await manager.close(terminal.id);

    await expect(
      manager.replay({ terminalId: terminal.id, afterSequence: 0, limit: 20 }),
    ).resolves.toEqual([
      { terminalId: terminal.id, sequence: 1, data: "first" },
    ]);
  });

  it("handles close and native exit only once and cleans up subscriptions", async () => {
    const { manager, pty, repository, changed } = createHarness();
    const terminal = await manager.create(request);
    await manager.close(terminal.id);
    pty.emitExit(143);

    expect(pty.kills).toBe(1);
    expect(pty.subscriptions).toEqual({ data: 0, exit: 0 });
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
    expect(
      changed.filter((descriptor) => descriptor.state === "exited"),
    ).toHaveLength(1);
  });

  it("waits for delayed output persistence before publishing exit", async () => {
    const { manager, pty, repository, outputStore, published, changed } =
      createHarness();
    const terminal = await manager.create(request);
    const gate = outputStore.delayAppends();
    pty.emitData("tail");
    await outputStore.whenAppendAttempted();
    let settled = false;

    const closing = manager.close(terminal.id).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(repository.descriptors.get(terminal.id)?.state).toBe("running");
    expect(published).toEqual([]);
    gate.release();
    await closing;
    expect(published).toEqual([
      { terminalId: terminal.id, sequence: 1, data: "tail" },
    ]);
    expect(changed.at(-1)).toMatchObject({ state: "exited" });
  });

  it("waits for a delayed native exit and accepts trailing output", async () => {
    const pty = new FakePty();
    pty.exitOnKill = false;
    const { manager, outputStore, repository } = createHarness({ pty });
    const terminal = await manager.create(request);
    let settled = false;

    const closing = manager.close(terminal.id).then(() => {
      settled = true;
    });
    await Promise.resolve();
    pty.emitData("after kill");
    await outputStore.whenAppended();

    expect(pty.kills).toBe(1);
    expect(settled).toBe(false);
    pty.emitExit(143);
    await closing;
    expect(outputStore.chunks).toEqual([
      { terminalId: terminal.id, sequence: 1, data: "after kill" },
    ]);
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
  });

  it("escalates to SIGKILL and waits for a delayed second-stage exit", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    pty.exitOnKill = false;
    const { manager, repository } = createHarness({ pty });
    const terminal = await manager.create(request);

    const closing = manager.close(terminal.id);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pty.killSignals).toEqual([undefined, "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(500);
    pty.emitExit(137);

    await expect(closing).resolves.toBeUndefined();
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a double timeout without publishing a false exit", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    pty.exitOnKill = false;
    const { manager, repository, changed, reporter } = createHarness({ pty });
    const terminal = await manager.create(request);

    const result = manager.close(terminal.id).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await result;

    expect(error).toMatchObject({
      code: "TERMINAL_TERMINATION_FAILED",
      message: expect.stringContaining(terminal.id),
    });
    expect(pty.killSignals).toEqual([undefined, "SIGKILL"]);
    expect(pty.subscriptions).toEqual({ data: 1, exit: 1 });
    expect(repository.descriptors.get(terminal.id)?.state).toBe("running");
    expect(changed).toEqual([terminal]);
    expect(reporter).toHaveBeenCalledWith(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a retained double-timeout session when exit arrives late", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    pty.exitOnKill = false;
    const { manager, repository, outputStore } = createHarness({ pty });
    const terminal = await manager.create(request);
    const failedClose = manager
      .close(terminal.id)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    await failedClose;

    pty.emitData("late output");
    await outputStore.whenAppended();
    pty.emitExit(137);
    await manager.close(terminal.id);

    expect(pty.killSignals).toEqual([undefined, "SIGKILL"]);
    expect(outputStore.chunks).toEqual([
      { terminalId: terminal.id, sequence: 1, data: "late output" },
    ]);
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
    expect(pty.subscriptions).toEqual({ data: 0, exit: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes closeAll reject when a terminal cannot be confirmed exited", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    pty.exitOnKill = false;
    const { manager, repository } = createHarness({ pty });
    const terminal = await manager.create(request);

    const result = manager.closeAll().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await result;

    expect(error).toMatchObject({ code: "TERMINAL_TERMINATION_FAILED" });
    expect(repository.descriptors.get(terminal.id)?.state).toBe("running");
    expect(pty.subscriptions).toEqual({ data: 1, exit: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for every closeAll finalizer before rejecting", async () => {
    vi.useFakeTimers();
    const stubbornPty = new FakePty();
    stubbornPty.exitOnKill = false;
    const exitingPty = new FakePty();
    const repository = new MemoryRepository();
    const outputStore = new MemoryOutputStore();
    const handles = [stubbornPty, exitingPty];
    const factory: PtyFactory = {
      spawn: () => {
        const handle = handles.shift();
        if (!handle) throw new Error("No fake PTY available");
        return handle;
      },
    };
    const manager = new TerminalManager(
      factory,
      repository,
      outputStore,
      vi.fn(),
    );
    await manager.create(request);
    await manager.create(request);
    const updateGate = repository.delayNextUpdate();
    let settled = false;

    const result = manager.closeAll().then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await updateGate.started;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(settled).toBe(false);
    updateGate.release();
    const error = await result;
    expect(error).toMatchObject({ code: "TERMINAL_TERMINATION_FAILED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a native exit cause when close joins its finalizer", async () => {
    const pty = new FakePty();
    pty.exitOnKill = false;
    const outputStore = new MemoryOutputStore();
    const gate = outputStore.delayAppends();
    const { manager, repository } = createHarness({ pty, outputStore });
    const terminal = await manager.create(request);
    pty.emitData("tail");
    await outputStore.whenAppendAttempted();

    pty.emitExit(143);
    const closing = manager.close(terminal.id);
    gate.release();
    await closing;

    expect(pty.killSignals).toEqual([]);
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      state: "exited",
      exitCode: 143,
    });
  });

  it("keeps the explicit-close exit code when close precedes native exit", async () => {
    const pty = new FakePty();
    pty.exitOnKill = false;
    const { manager, repository } = createHarness({ pty });
    const terminal = await manager.create(request);

    const closing = manager.close(terminal.id);
    pty.emitExit(143);
    await closing;

    expect(pty.killSignals).toEqual([undefined]);
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
  });

  it("serializes a delayed resize before finalization", async () => {
    const repository = new MemoryRepository();
    const { manager, changed } = createHarness({ repository });
    const terminal = await manager.create(request);
    const gate = repository.delayNextUpdate();

    const resizing = manager.resize({
      terminalId: terminal.id,
      cols: 120,
      rows: 40,
    });
    await gate.started;
    const closing = manager.close(terminal.id);
    await Promise.resolve();

    expect(changed).toEqual([terminal]);
    gate.release();
    await Promise.all([resizing, closing]);

    expect(repository.updates.map(({ state }) => state)).toEqual([
      "running",
      "exited",
    ]);
    expect(changed.map(({ state }) => state)).toEqual([
      "running",
      "running",
      "exited",
    ]);
    expect(repository.descriptors.get(terminal.id)).toMatchObject({
      state: "exited",
      cols: 120,
      rows: 40,
    });
  });

  it("shares finalization failures with every concurrent close caller", async () => {
    const repository = new MemoryRepository();
    const updateError = new Error("exit update failed");
    repository.updateError = updateError;
    const { manager, pty, reporter } = createHarness({ repository });
    const terminal = await manager.create(request);

    const results = await Promise.allSettled([
      manager.close(terminal.id),
      manager.close(terminal.id),
    ]);

    expect(results).toEqual([
      { status: "rejected", reason: updateError },
      { status: "rejected", reason: updateError },
    ]);
    expect(pty.kills).toBe(1);
    expect(repository.updates).toHaveLength(1);
    expect(reporter).toHaveBeenCalledWith(updateError);
  });

  it("attempts every listener cleanup when one disposer throws", async () => {
    const pty = new FakePty();
    const disposalError = new Error("data dispose failed");
    pty.dataDisposalError = disposalError;
    const { manager, reporter } = createHarness({ pty });
    const terminal = await manager.create(request);

    await expect(manager.close(terminal.id)).rejects.toBe(disposalError);

    expect(pty.dataDisposals).toBe(1);
    expect(pty.exitDisposals).toBe(1);
    expect(pty.subscriptions).toEqual({ data: 0, exit: 0 });
    expect(reporter).toHaveBeenCalledWith(disposalError);
  });

  it("closes every active terminal", async () => {
    const firstPty = new FakePty();
    const secondPty = new FakePty();
    const repository = new MemoryRepository();
    const outputStore = new MemoryOutputStore();
    const handles = [firstPty, secondPty];
    const factory: PtyFactory = {
      spawn: () => {
        const handle = handles.shift();
        if (!handle) throw new Error("No fake PTY available");
        return handle;
      },
    };
    const manager = new TerminalManager(
      factory,
      repository,
      outputStore,
      vi.fn(),
    );
    const first = await manager.create(request);
    const second = await manager.create({ cols: 90, rows: 30 });

    await manager.closeAll();

    await expect(manager.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, state: "exited" }),
        expect.objectContaining({ id: second.id, state: "exited" }),
      ]),
    );
    expect(firstPty.kills).toBe(1);
    expect(secondPty.kills).toBe(1);
  });

  it("makes closeAll wait for delayed finalization", async () => {
    const pty = new FakePty();
    pty.exitOnKill = false;
    const { manager } = createHarness({ pty });
    await manager.create(request);
    let settled = false;

    const closing = manager.closeAll().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    pty.emitExit(0);
    await closing;
    expect(settled).toBe(true);
  });
});

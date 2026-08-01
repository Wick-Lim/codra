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

class FakePty implements PtyHandle {
  readonly pid = 42;
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  kills = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }

  kill(): void {
    this.kills += 1;
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
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

  async save(descriptor: TerminalDescriptor): Promise<void> {
    this.descriptors.set(descriptor.id, descriptor);
  }

  async update(descriptor: TerminalDescriptor): Promise<void> {
    this.descriptors.set(descriptor.id, descriptor);
  }

  async list(): Promise<TerminalDescriptor[]> {
    return [...this.descriptors.values()];
  }

  async markRunningExited(): Promise<void> {}
}

class MemoryOutputStore implements TerminalOutputStore {
  readonly chunks: TerminalOutputChunk[] = [];
  private readonly appendWaiters: Array<() => void> = [];
  private nextSequence = 1;
  private appendGate: Promise<void> | undefined;

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
    await this.appendGate;
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
}

function createHarness() {
  const pty = new FakePty();
  const repository = new MemoryRepository();
  const outputStore = new MemoryOutputStore();
  const factory: PtyFactory = { spawn: vi.fn(() => pty) };
  const manager = new TerminalManager(factory, repository, outputStore);
  const published: TerminalOutputChunk[] = [];
  const changed: TerminalDescriptor[] = [];
  manager.onOutput((chunk) => published.push(chunk));
  manager.onChanged((descriptor) => changed.push(descriptor));
  return { manager, pty, repository, outputStore, published, changed, factory };
}

const request: CreateTerminalRequest = { cols: 80, rows: 24 };

describe("TerminalManager", () => {
  afterEach(() => {
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

  it("closes every active terminal", async () => {
    const { manager, pty } = createHarness();
    const first = await manager.create(request);
    const second = await manager.create({ cols: 90, rows: 30 });

    await manager.closeAll();

    await expect(manager.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, state: "exited" }),
        expect.objectContaining({ id: second.id, state: "exited" }),
      ]),
    );
    expect(pty.kills).toBe(2);
  });
});

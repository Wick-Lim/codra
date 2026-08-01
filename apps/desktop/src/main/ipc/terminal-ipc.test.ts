import { randomUUID } from "node:crypto";
import {
  IPC_CHANNELS,
  type TerminalDescriptor,
  type TerminalOutputChunk,
} from "@codra/protocol";
import { describe, expect, it, vi } from "vitest";
import { registerTerminalIpc } from "./terminal-ipc";

type Handler = (event: unknown, payload?: unknown) => unknown;

const terminalId = randomUUID();
const descriptor: TerminalDescriptor = {
  id: terminalId,
  title: "Terminal",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  state: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
};
const chunk: TerminalOutputChunk = {
  terminalId,
  sequence: 1,
  data: "ready\\n",
};

function createIpcHarness() {
  const handlers = new Map<string, Handler>();
  const outputListeners = new Set<(value: TerminalOutputChunk) => void>();
  const changedListeners = new Set<(value: TerminalDescriptor) => void>();
  const manager = {
    list: vi.fn(async () => [descriptor]),
    create: vi.fn(async () => descriptor),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    replay: vi.fn(async () => [chunk]),
    close: vi.fn(async () => undefined),
    onOutput: vi.fn((listener: (value: TerminalOutputChunk) => void) => {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    }),
    onChanged: vi.fn((listener: (value: TerminalDescriptor) => void) => {
      changedListeners.add(listener);
      return () => changedListeners.delete(listener);
    }),
  };
  const windows = [
    { webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() } },
    { webContents: { isDestroyed: vi.fn(() => true), send: vi.fn() } },
  ];
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) =>
      handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const unregister = registerTerminalIpc({
    ipc,
    manager,
    windows: () => windows,
  });

  return {
    manager,
    windows,
    ipc,
    unregister,
    handlers: {
      invoke: async (channel: string, payload?: unknown) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`No handler for ${channel}`);
        return handler({}, payload);
      },
      has: (channel: string) => handlers.has(channel),
    },
    emitOutput: (value: TerminalOutputChunk) => {
      for (const listener of outputListeners) listener(value);
    },
    emitChanged: (value: TerminalDescriptor) => {
      for (const listener of changedListeners) listener(value);
    },
  };
}

describe("registerTerminalIpc", () => {
  it("validates create requests before invoking the manager", async () => {
    const harness = createIpcHarness();

    await expect(
      harness.handlers.invoke(IPC_CHANNELS.terminalCreate, {
        cols: 1,
        rows: 1,
      }),
    ).rejects.toThrow();

    expect(harness.manager.create).not.toHaveBeenCalled();
  });

  it("validates every payload-bearing request before invoking the manager", async () => {
    const harness = createIpcHarness();

    await expect(
      harness.handlers.invoke(IPC_CHANNELS.terminalWrite, {
        terminalId,
        data: "",
      }),
    ).rejects.toThrow();
    await expect(
      harness.handlers.invoke(IPC_CHANNELS.terminalResize, {
        terminalId,
        cols: 2,
        rows: 2,
      }),
    ).rejects.toThrow();
    await expect(
      harness.handlers.invoke(IPC_CHANNELS.terminalReplay, {
        terminalId,
        afterSequence: -1,
      }),
    ).rejects.toThrow();
    await expect(
      harness.handlers.invoke(IPC_CHANNELS.terminalClose, "not-a-uuid"),
    ).rejects.toThrow();

    expect(harness.manager.write).not.toHaveBeenCalled();
    expect(harness.manager.resize).not.toHaveBeenCalled();
    expect(harness.manager.replay).not.toHaveBeenCalled();
    expect(harness.manager.close).not.toHaveBeenCalled();
  });

  it("passes parsed requests instead of raw payloads to the manager", async () => {
    const harness = createIpcHarness();

    await harness.handlers.invoke(IPC_CHANNELS.terminalCreate, {
      cols: 80,
      rows: 24,
      ignored: "untrusted",
    });

    expect(harness.manager.create).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it("fans persisted output to every live renderer", () => {
    const harness = createIpcHarness();

    harness.emitOutput(chunk);

    expect(harness.windows[0]?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalOutput,
      chunk,
    );
    expect(harness.windows[1]?.webContents.send).not.toHaveBeenCalled();
  });

  it("fans descriptor changes to every live renderer", () => {
    const harness = createIpcHarness();
    const exitedDescriptor = {
      ...descriptor,
      state: "exited" as const,
      exitCode: 0,
    };

    harness.emitChanged(exitedDescriptor);

    expect(harness.windows[0]?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalChanged,
      exitedDescriptor,
    );
    expect(harness.windows[1]?.webContents.send).not.toHaveBeenCalled();
  });

  it("unregisters every request handler and event subscription", () => {
    const harness = createIpcHarness();

    harness.unregister();
    harness.emitOutput(chunk);
    harness.emitChanged(descriptor);

    expect(harness.ipc.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalList,
    );
    expect(harness.ipc.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalCreate,
    );
    expect(harness.ipc.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalWrite,
    );
    expect(harness.ipc.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalResize,
    );
    expect(harness.ipc.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalReplay,
    );
    expect(harness.ipc.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalClose,
    );
    expect(harness.handlers.has(IPC_CHANNELS.terminalCreate)).toBe(false);
    expect(harness.windows[0]?.webContents.send).not.toHaveBeenCalled();
  });
});

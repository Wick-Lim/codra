import { describe, expect, it } from "vitest";
import { IPC_CHANNELS, type TerminalDescriptor } from "@codra/protocol";
import { createDesktopApi, type IpcRendererLike } from "./desktop-api";

type Listener = (event: unknown, payload: unknown) => void;

class FakeIpcRenderer implements IpcRendererLike {
  readonly invocations: Array<{ channel: string; args: unknown[] }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly responses = new Map<string, unknown>()) {}

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invocations.push({ channel, args });
    return Promise.resolve(this.responses.get(channel));
  }

  on(channel: string, listener: Listener): this {
    const listeners = this.listeners.get(channel) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return this;
  }

  removeListener(channel: string, listener: Listener): this {
    this.listeners.get(channel)?.delete(listener);
    return this;
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener({}, payload);
    }
  }
}

const terminalId = "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5";

const descriptor: TerminalDescriptor = {
  id: terminalId,
  title: "shell",
  cwd: "/workspace",
  cols: 120,
  rows: 32,
  state: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
};

describe("createDesktopApi", () => {
  it("routes every terminal invocation through its frozen channel", async () => {
    const ipc = new FakeIpcRenderer(
      new Map<string, unknown>([
        [IPC_CHANNELS.terminalList, [descriptor]],
        [IPC_CHANNELS.terminalCreate, descriptor],
        [IPC_CHANNELS.terminalReplay, []],
      ]),
    );
    const api = createDesktopApi(ipc);

    await api.terminal.list();
    await api.terminal.create({ cols: 120, rows: 32 });
    await api.terminal.write({ terminalId, data: "pwd\n" });
    await api.terminal.resize({ terminalId, cols: 100, rows: 30 });
    await api.terminal.replay({ terminalId, afterSequence: 0, limit: 100 });
    await api.terminal.close(terminalId);

    expect(ipc.invocations).toEqual([
      { channel: IPC_CHANNELS.terminalList, args: [] },
      {
        channel: IPC_CHANNELS.terminalCreate,
        args: [{ cols: 120, rows: 32 }],
      },
      {
        channel: IPC_CHANNELS.terminalWrite,
        args: [{ terminalId, data: "pwd\n" }],
      },
      {
        channel: IPC_CHANNELS.terminalResize,
        args: [{ terminalId, cols: 100, rows: 30 }],
      },
      {
        channel: IPC_CHANNELS.terminalReplay,
        args: [{ terminalId, afterSequence: 0, limit: 100 }],
      },
      { channel: IPC_CHANNELS.terminalClose, args: [terminalId] },
    ]);
  });

  it("forwards only valid output events", () => {
    const ipc = new FakeIpcRenderer();
    const received: string[] = [];
    createDesktopApi(ipc).terminal.onOutput((chunk) =>
      received.push(chunk.data),
    );

    ipc.emit(IPC_CHANNELS.terminalOutput, {
      terminalId,
      sequence: 0,
      data: "bad",
    });
    ipc.emit(IPC_CHANNELS.terminalOutput, {
      terminalId,
      sequence: 1,
      data: "ok",
    });

    expect(received).toEqual(["ok"]);
  });

  it("unsubscribes only the listener that requested removal", () => {
    const ipc = new FakeIpcRenderer();
    const api = createDesktopApi(ipc);
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = api.terminal.onOutput((chunk) => first.push(chunk.data));
    api.terminal.onOutput((chunk) => second.push(chunk.data));

    stopFirst();
    ipc.emit(IPC_CHANNELS.terminalOutput, {
      terminalId,
      sequence: 1,
      data: "still here",
    });

    expect(first).toEqual([]);
    expect(second).toEqual(["still here"]);
  });

  it("forwards only valid terminal change events", () => {
    const ipc = new FakeIpcRenderer();
    const received: TerminalDescriptor[] = [];
    createDesktopApi(ipc).terminal.onChanged((change) => received.push(change));

    ipc.emit(IPC_CHANNELS.terminalChanged, { ...descriptor, cols: 2 });
    ipc.emit(IPC_CHANNELS.terminalChanged, descriptor);

    expect(received).toEqual([descriptor]);
  });
});

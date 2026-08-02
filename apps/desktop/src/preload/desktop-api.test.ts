import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  type RemoteAccountStatus,
  type RemoteHostStatus,
  type TerminalDescriptor,
} from "@codra/protocol";
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
  it("routes account login and host activation independently", async () => {
    const signedIn = {
      state: "signed_in",
      profile: {
        displayName: "Jun Hyeog Im",
        email: "jun@example.com",
        photoUrl: null,
      },
    };
    const ipc = new FakeIpcRenderer(
      new Map<string, unknown>([
        [IPC_CHANNELS.remoteGetState, { state: "idle" }],
        [IPC_CHANNELS.remoteGetAuthState, { state: "signed_out" }],
        [IPC_CHANNELS.remoteLogin, signedIn],
        [IPC_CHANNELS.remoteLogout, { state: "signed_out" }],
        [IPC_CHANNELS.remoteActivate, { state: "online" }],
        [IPC_CHANNELS.remoteDeactivate, { state: "idle" }],
      ]),
    );
    const api = createDesktopApi(ipc);
    const received: RemoteHostStatus[] = [];
    const receivedAuth: RemoteAccountStatus[] = [];
    api.remote.onStateChanged((status) => received.push(status));
    api.remote.onAuthStateChanged((status) => receivedAuth.push(status));

    await expect(api.remote.getState()).resolves.toEqual({ state: "idle" });
    await expect(api.remote.getAuthState()).resolves.toEqual({
      state: "signed_out",
    });
    await expect(api.remote.login("google")).resolves.toEqual(signedIn);
    await expect(api.remote.logout()).resolves.toEqual({ state: "signed_out" });
    await expect(api.remote.activate()).resolves.toEqual({ state: "online" });
    await expect(api.remote.deactivate()).resolves.toEqual({ state: "idle" });
    ipc.emit(IPC_CHANNELS.remoteState, { state: "activating" });
    ipc.emit(IPC_CHANNELS.remoteState, { state: "error", message: "" });
    ipc.emit(IPC_CHANNELS.remoteState, {
      state: "error",
      message: "REMOTE_ACTIVATION_FAILED",
    });
    ipc.emit(IPC_CHANNELS.remoteAuthState, signedIn);

    expect(received).toEqual([
      { state: "activating" },
      { state: "error", message: "REMOTE_ACTIVATION_FAILED" },
    ]);
    expect(receivedAuth).toEqual([signedIn]);
    expect(ipc.invocations.slice(-6)).toEqual([
      { channel: IPC_CHANNELS.remoteGetState, args: [] },
      { channel: IPC_CHANNELS.remoteGetAuthState, args: [] },
      { channel: IPC_CHANNELS.remoteLogin, args: ["google"] },
      { channel: IPC_CHANNELS.remoteLogout, args: [] },
      { channel: IPC_CHANNELS.remoteActivate, args: [] },
      { channel: IPC_CHANNELS.remoteDeactivate, args: [] },
    ]);
  });

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

  it("loads and validates the installed agent registry", async () => {
    const agents = [
      {
        kind: "codex",
        label: "Codex CLI",
        description: "OpenAI's coding agent for repository work.",
        available: true,
        supportsYolo: true,
        modelRequired: false,
        efforts: [{ id: "high", label: "High" }],
        models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
        installHint: "Install Codex CLI to use this runtime.",
        setup: {
          installMethod: "managed_npm",
          authentication: "required",
        },
      },
      {
        kind: "gemini",
        label: "Gemini CLI",
        description: "Google's open-source terminal coding agent.",
        available: false,
        supportsYolo: true,
        modelRequired: false,
        efforts: [],
        models: [{ id: "auto", label: "Auto" }],
        installHint: "Install @google/gemini-cli to use this runtime.",
        setup: {
          installMethod: "managed_npm",
          authentication: "required",
        },
      },
    ];
    const ipc = new FakeIpcRenderer(
      new Map<string, unknown>([[IPC_CHANNELS.agentList, agents]]),
    );
    const api = createDesktopApi(ipc);

    await expect(api.agents.list()).resolves.toEqual(agents);
    expect(ipc.invocations).toEqual([
      { channel: IPC_CHANNELS.agentList, args: [] },
    ]);

    const malformed = createDesktopApi(
      new FakeIpcRenderer(
        new Map([[IPC_CHANNELS.agentList, [{ ...agents[0], kind: "shell" }]]]),
      ),
    );
    await expect(malformed.agents.list()).rejects.toThrow();
  });

  it("validates agent setup requests and discriminated results", async () => {
    const terminalResult = { kind: "terminal", terminal: descriptor };
    const ipc = new FakeIpcRenderer(
      new Map([[IPC_CHANNELS.agentSetup, terminalResult]]),
    );
    const api = createDesktopApi(ipc);

    await expect(
      api.agents.setup({ kind: "codex", action: "install" }),
    ).resolves.toEqual(terminalResult);
    expect(ipc.invocations).toEqual([
      {
        channel: IPC_CHANNELS.agentSetup,
        args: [{ kind: "codex", action: "install" }],
      },
    ]);

    const malformed = createDesktopApi(
      new FakeIpcRenderer(
        new Map([
          [
            IPC_CHANNELS.agentSetup,
            { kind: "external", url: "https://attacker.example" },
          ],
        ]),
      ),
    );
    await expect(
      malformed.agents.setup({ kind: "gemini", action: "install" }),
    ).rejects.toThrow();
  });

  it.each([
    {
      label: "create",
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.create({ cols: 19, rows: 32 }),
    },
    {
      label: "write",
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.write({ terminalId, data: "" }),
    },
    {
      label: "resize",
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.resize({ terminalId, cols: 19, rows: 32 }),
    },
    {
      label: "replay",
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.replay({ terminalId, afterSequence: -1, limit: 100 }),
    },
    {
      label: "close",
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.close("not-a-terminal-id"),
    },
  ])(
    "rejects invalid $label requests before invoking IPC",
    async ({ invoke }) => {
      const ipc = new FakeIpcRenderer();

      await expect(invoke(createDesktopApi(ipc))).rejects.toThrow();

      expect(ipc.invocations).toEqual([]);
    },
  );

  it.each([
    {
      label: "list",
      channel: IPC_CHANNELS.terminalList,
      response: [{ ...descriptor, cols: 2 }],
      invoke: (api: ReturnType<typeof createDesktopApi>) => api.terminal.list(),
    },
    {
      label: "create",
      channel: IPC_CHANNELS.terminalCreate,
      response: { ...descriptor, cols: 2 },
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.create({ cols: 120, rows: 32 }),
    },
    {
      label: "replay",
      channel: IPC_CHANNELS.terminalReplay,
      response: [{ terminalId, sequence: 0, data: "bad" }],
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.replay({ terminalId, afterSequence: 0, limit: 100 }),
    },
  ])(
    "rejects malformed $label responses",
    async ({ channel, response, invoke }) => {
      const ipc = new FakeIpcRenderer(new Map([[channel, response]]));

      await expect(invoke(createDesktopApi(ipc))).rejects.toThrow();
    },
  );

  it.each([
    {
      label: "write",
      channel: IPC_CHANNELS.terminalWrite,
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.write({ terminalId, data: "pwd\n" }),
    },
    {
      label: "resize",
      channel: IPC_CHANNELS.terminalResize,
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.resize({ terminalId, cols: 100, rows: 30 }),
    },
    {
      label: "close",
      channel: IPC_CHANNELS.terminalClose,
      invoke: (api: ReturnType<typeof createDesktopApi>) =>
        api.terminal.close(terminalId),
    },
  ])("rejects non-undefined $label responses", async ({ channel, invoke }) => {
    const ipc = new FakeIpcRenderer(new Map([[channel, "unexpected"]]));

    await expect(invoke(createDesktopApi(ipc))).rejects.toThrow();
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

  it("unsubscribes only its terminal change listener wrapper", () => {
    const ipc = new FakeIpcRenderer();
    const api = createDesktopApi(ipc);
    const first: TerminalDescriptor[] = [];
    const second: TerminalDescriptor[] = [];
    const stopFirst = api.terminal.onChanged((change) => first.push(change));
    api.terminal.onChanged((change) => second.push(change));

    stopFirst();
    ipc.emit(IPC_CHANNELS.terminalChanged, descriptor);

    expect(first).toEqual([]);
    expect(second).toEqual([descriptor]);
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

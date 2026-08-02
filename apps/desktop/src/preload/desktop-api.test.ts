import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  type AgentLaunchTarget,
  type PendingRemoteSession,
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

const pendingSession: PendingRemoteSession = {
  sessionId: "3f5f0a02-27b0-4a04-9a2f-6cb2f5d6a111",
  clientDeviceId: "7c9f1d33-4b62-4f0e-9f4c-1c0b7d2a2222",
  requesterDisplayName: "Studio Mac",
  requestedScopes: ["workspace.read", "agent.launch"],
  expiresAt: 1_785_000_000_000,
};

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
  it("routes target discovery and workspace browsing through strict channels", async () => {
    const remoteTarget = {
      kind: "remote" as const,
      deviceId: "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1",
      displayName: "Studio Mac",
    };
    const targets = [
      { target: { kind: "local" as const }, state: "connected" as const },
      { target: remoteTarget, state: "available" as const },
    ];
    const connected = { target: remoteTarget, state: "connected" as const };
    const runtimes = [
      {
        kind: "codex" as const,
        label: "Codex CLI",
        description: "OpenAI's coding agent for repository work.",
        available: true,
        supportsYolo: true,
        modelRequired: false,
        efforts: [],
        models: [],
        installHint: "Install Codex CLI to use this runtime.",
        setup: {
          installMethod: "managed_npm" as const,
          authentication: "required" as const,
        },
      },
    ];
    const roots = [{ path: "/Users/codra", label: "Home" }];
    const page = {
      path: "/Users/codra",
      label: "codra",
      breadcrumbs: [
        { path: "/", label: "/" },
        { path: "/Users", label: "Users" },
        { path: "/Users/codra", label: "codra" },
      ],
      entries: [{ path: "/Users/codra/project", name: "project" }],
    };
    const workspace = { path: "/Users/codra/project", label: "project" };
    const ipc = new FakeIpcRenderer(
      new Map<string, unknown>([
        [IPC_CHANNELS.agentTargets, targets],
        [IPC_CHANNELS.agentConnectTarget, connected],
        [IPC_CHANNELS.agentTargetRuntimes, runtimes],
        [IPC_CHANNELS.agentWorkspaceRoots, roots],
        [IPC_CHANNELS.agentWorkspaceList, page],
        [IPC_CHANNELS.agentWorkspaceValidate, workspace],
      ]),
    );
    const api = createDesktopApi(ipc);
    const changed: AgentLaunchTarget[][] = [];
    api.agents.onTargetsChanged((next) => changed.push(next));

    await expect(api.agents.targets()).resolves.toEqual(targets);
    await expect(api.agents.connectTarget(remoteTarget)).resolves.toEqual(
      connected,
    );
    await expect(api.agents.listForTarget(remoteTarget)).resolves.toEqual(
      runtimes,
    );
    await expect(api.agents.workspaceRoots(remoteTarget)).resolves.toEqual(
      roots,
    );
    await expect(
      api.agents.workspaceList(remoteTarget, "/Users/codra"),
    ).resolves.toEqual(page);
    await expect(
      api.agents.workspaceValidate(remoteTarget, "/Users/codra/project"),
    ).resolves.toEqual(workspace);
    ipc.emit(IPC_CHANNELS.agentTargetsChanged, targets);
    ipc.emit(IPC_CHANNELS.agentTargetsChanged, [{ target: remoteTarget }]);

    expect(changed).toEqual([targets]);
    expect(ipc.invocations).toEqual([
      { channel: IPC_CHANNELS.agentTargets, args: [] },
      {
        channel: IPC_CHANNELS.agentConnectTarget,
        args: [{ target: remoteTarget }],
      },
      {
        channel: IPC_CHANNELS.agentTargetRuntimes,
        args: [{ target: remoteTarget }],
      },
      {
        channel: IPC_CHANNELS.agentWorkspaceRoots,
        args: [{ target: remoteTarget }],
      },
      {
        channel: IPC_CHANNELS.agentWorkspaceList,
        args: [{ target: remoteTarget, path: "/Users/codra" }],
      },
      {
        channel: IPC_CHANNELS.agentWorkspaceValidate,
        args: [{ target: remoteTarget, path: "/Users/codra/project" }],
      },
    ]);
  });

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

  it("routes pending session approval through its own channels", async () => {
    const ipc = new FakeIpcRenderer(
      new Map<string, unknown>([
        [IPC_CHANNELS.remoteGetPendingSessions, [pendingSession]],
      ]),
    );
    const api = createDesktopApi(ipc);
    const received: PendingRemoteSession[][] = [];
    api.remote.onPendingSessionsChanged((sessions) => received.push(sessions));

    await expect(api.remote.getPendingSessions()).resolves.toEqual([
      pendingSession,
    ]);
    await expect(
      api.remote.approveSession({
        sessionId: pendingSession.sessionId,
        approvedScopes: ["workspace.read"],
      }),
    ).resolves.toBeUndefined();
    await expect(
      api.remote.rejectSession({ sessionId: pendingSession.sessionId }),
    ).resolves.toBeUndefined();
    ipc.emit(IPC_CHANNELS.remotePendingSessions, [
      { ...pendingSession, requestedScopes: [] },
    ]);
    ipc.emit(IPC_CHANNELS.remotePendingSessions, [pendingSession]);
    ipc.emit(IPC_CHANNELS.remotePendingSessions, []);

    expect(received).toEqual([[pendingSession], []]);
    expect(ipc.invocations).toEqual([
      { channel: IPC_CHANNELS.remoteGetPendingSessions, args: [] },
      {
        channel: IPC_CHANNELS.remoteApproveSession,
        args: [
          {
            sessionId: pendingSession.sessionId,
            approvedScopes: ["workspace.read"],
          },
        ],
      },
      {
        channel: IPC_CHANNELS.remoteRejectSession,
        args: [{ sessionId: pendingSession.sessionId }],
      },
    ]);
  });

  it("keeps invalid approval requests off the IPC bridge", async () => {
    const ipc = new FakeIpcRenderer();
    const api = createDesktopApi(ipc);

    await expect(
      api.remote.approveSession({
        sessionId: pendingSession.sessionId,
        approvedScopes: [],
      }),
    ).rejects.toThrow();
    await expect(
      api.remote.rejectSession({ sessionId: "not-a-session-id" }),
    ).rejects.toThrow();

    expect(ipc.invocations).toEqual([]);
  });

  it("rejects a non-undefined approval response", async () => {
    const ipc = new FakeIpcRenderer(
      new Map<string, unknown>([
        [IPC_CHANNELS.remoteApproveSession, "unexpected"],
      ]),
    );

    await expect(
      createDesktopApi(ipc).remote.approveSession({
        sessionId: pendingSession.sessionId,
        approvedScopes: ["workspace.read"],
      }),
    ).rejects.toThrow("Expected IPC mutation response to be undefined");
  });

  it("unsubscribes only its pending session listener wrapper", () => {
    const ipc = new FakeIpcRenderer();
    const api = createDesktopApi(ipc);
    const first: PendingRemoteSession[][] = [];
    const second: PendingRemoteSession[][] = [];
    const stopFirst = api.remote.onPendingSessionsChanged((sessions) =>
      first.push(sessions),
    );
    api.remote.onPendingSessionsChanged((sessions) => second.push(sessions));

    stopFirst();
    ipc.emit(IPC_CHANNELS.remotePendingSessions, [pendingSession]);

    expect(first).toEqual([]);
    expect(second).toEqual([[pendingSession]]);
  });

  it("routes every terminal invocation through its frozen channel", async () => {
    const ipc = new FakeIpcRenderer(
      new Map<string, unknown>([
        [IPC_CHANNELS.terminalDefaultCwd, "/Users/codra"],
        [IPC_CHANNELS.terminalChooseCwd, "/workspace/selected"],
        [IPC_CHANNELS.terminalList, [descriptor]],
        [IPC_CHANNELS.terminalCreate, descriptor],
        [IPC_CHANNELS.terminalReplay, []],
      ]),
    );
    const api = createDesktopApi(ipc);

    await expect(api.terminal.defaultCwd()).resolves.toBe("/Users/codra");
    await expect(api.terminal.chooseCwd("/workspace/codra")).resolves.toBe(
      "/workspace/selected",
    );
    await api.terminal.list();
    await api.terminal.create({ cols: 120, rows: 32 });
    await api.terminal.write({ terminalId, data: "pwd\n" });
    await api.terminal.resize({ terminalId, cols: 100, rows: 30 });
    await api.terminal.replay({ terminalId, afterSequence: 0, limit: 100 });
    await api.terminal.close(terminalId);

    expect(ipc.invocations).toEqual([
      { channel: IPC_CHANNELS.terminalDefaultCwd, args: [] },
      {
        channel: IPC_CHANNELS.terminalChooseCwd,
        args: [{ defaultPath: "/workspace/codra" }],
      },
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

import { randomUUID } from "node:crypto";
import {
  IPC_CHANNELS,
  type AgentRuntime,
  type TerminalDescriptor,
  type TerminalOutputChunk,
} from "@codra/protocol";
import { describe, expect, it, vi } from "vitest";
import { TerminalAdmissionGate, TerminalShutdownError } from "./admission";
import { registerTerminalIpc } from "./terminal-ipc";

type Handler = (event: unknown, payload?: unknown) => unknown;

const terminalId = randomUUID();
const trustedRendererUrl =
  "file:///Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/index.html";
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

function createTrustedRenderer() {
  const mainFrame = { url: trustedRendererUrl };
  const webContents = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    getURL: vi.fn(() => trustedRendererUrl),
    mainFrame,
  };
  return {
    event: { sender: webContents, senderFrame: mainFrame },
    windows: [
      {
        isDestroyed: vi.fn(() => false),
        webContents,
      },
    ],
  };
}

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
  const mainFrame = { url: trustedRendererUrl };
  const liveWebContents = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    getURL: vi.fn(() => trustedRendererUrl),
    mainFrame,
  };
  const destroyedWebContents = {
    isDestroyed: vi.fn(() => true),
    send: vi.fn(),
    getURL: vi.fn(() => trustedRendererUrl),
    mainFrame: { url: trustedRendererUrl },
  };
  const windows = [
    {
      isDestroyed: vi.fn(() => false),
      webContents: liveWebContents,
    },
    {
      isDestroyed: vi.fn(() => false),
      webContents: destroyedWebContents,
    },
  ];
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) =>
      handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const agents: AgentRuntime[] = [
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
  const listAgents = vi.fn(() => agents);
  const unregister = registerTerminalIpc({
    ipc,
    manager,
    windows: () => windows,
    isTrustedRendererUrl: (url) => url === trustedRendererUrl,
    listAgents,
  });

  const trustedEvent = () => ({
    sender: liveWebContents,
    senderFrame: mainFrame,
  });

  return {
    manager,
    listAgents,
    windows,
    ipc,
    unregister,
    handlers: {
      invoke: async (
        channel: string,
        payload?: unknown,
        event: unknown = trustedEvent(),
      ) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`No handler for ${channel}`);
        return handler(event, payload);
      },
      has: (channel: string) => handlers.has(channel),
    },
    emitOutput: (value: TerminalOutputChunk) => {
      for (const listener of outputListeners) listener(value);
    },
    emitChanged: (value: TerminalDescriptor) => {
      for (const listener of changedListeners) listener(value);
    },
    trustedEvent,
  };
}

describe("registerTerminalIpc", () => {
  it("returns validated local agent availability to a trusted renderer", async () => {
    const harness = createIpcHarness();

    await expect(
      harness.handlers.invoke(IPC_CHANNELS.agentList),
    ).resolves.toMatchObject([
      { kind: "codex", available: true },
      { kind: "gemini", available: false },
    ]);
    expect(harness.listAgents).toHaveBeenCalledOnce();
  });

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

  it("rejects PTY creation after an owned renderer reaches an HTTPS page", async () => {
    const harness = createIpcHarness();
    const sender = harness.windows[0]!.webContents;
    sender.getURL.mockReturnValue("https://attacker.example/terminal");

    await expect(
      harness.handlers.invoke(
        IPC_CHANNELS.terminalCreate,
        { cols: 80, rows: 24 },
        { sender, senderFrame: sender.mainFrame },
      ),
    ).rejects.toThrow("Unauthorized terminal IPC sender");

    expect(harness.manager.create).not.toHaveBeenCalled();
  });

  it("rejects an owned main frame whose event URL is no longer trusted", async () => {
    const harness = createIpcHarness();
    const sender = harness.windows[0]!.webContents;
    sender.mainFrame.url = "https://attacker.example/frame";

    await expect(
      harness.handlers.invoke(IPC_CHANNELS.terminalList, undefined, {
        sender,
        senderFrame: sender.mainFrame,
      }),
    ).rejects.toThrow("Unauthorized terminal IPC sender");

    expect(harness.manager.list).not.toHaveBeenCalled();
  });

  it("rejects a forged sender that is not owned by a live BrowserWindow", async () => {
    const harness = createIpcHarness();
    const mainFrame = { url: trustedRendererUrl };
    const forgedSender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      getURL: vi.fn(() => trustedRendererUrl),
      mainFrame,
    };

    await expect(
      harness.handlers.invoke(IPC_CHANNELS.terminalList, undefined, {
        sender: forgedSender,
        senderFrame: mainFrame,
      }),
    ).rejects.toThrow("Unauthorized terminal IPC sender");

    expect(harness.manager.list).not.toHaveBeenCalled();
  });

  it("rejects subframe IPC before parsing or manager side effects", async () => {
    const harness = createIpcHarness();
    const sender = harness.windows[0]!.webContents;

    await expect(
      harness.handlers.invoke(
        IPC_CHANNELS.terminalWrite,
        { terminalId, data: "whoami\n" },
        { sender, senderFrame: { url: trustedRendererUrl } },
      ),
    ).rejects.toThrow("Unauthorized terminal IPC sender");

    expect(harness.manager.write).not.toHaveBeenCalled();
  });

  it("rejects a sender owned only by a destroyed BrowserWindow", async () => {
    const harness = createIpcHarness();
    const owner = harness.windows[0]!;
    owner.isDestroyed.mockReturnValue(true);

    await expect(
      harness.handlers.invoke(IPC_CHANNELS.terminalList),
    ).rejects.toThrow("Unauthorized terminal IPC sender");

    expect(harness.manager.list).not.toHaveBeenCalled();
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

  it("withholds output from an owned window whose current URL is external", () => {
    const harness = createIpcHarness();
    const sender = harness.windows[0]!.webContents;
    sender.getURL.mockReturnValue("https://attacker.example/terminal");

    harness.emitOutput(chunk);

    expect(sender.send).not.toHaveBeenCalled();
  });

  it("withholds descriptor events from an owned main frame on an external URL", () => {
    const harness = createIpcHarness();
    const sender = harness.windows[0]!.webContents;
    sender.mainFrame.url = "https://attacker.example/terminal";

    harness.emitChanged(descriptor);

    expect(sender.send).not.toHaveBeenCalled();
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

  it("drains admitted creates before closeAll and rejects later requests during quit", async () => {
    const handlers = new Map<string, Handler>();
    const admission = new TerminalAdmissionGate();
    const activeTerminalIds = new Set<string>();
    let resolveCreate!: (value: TerminalDescriptor) => void;
    const manager = {
      list: vi.fn(async () => []),
      create: vi.fn(() => {
        activeTerminalIds.add(terminalId);
        return new Promise<TerminalDescriptor>((resolve) => {
          resolveCreate = resolve;
        });
      }),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      replay: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => {
        expect([...activeTerminalIds]).toEqual([terminalId]);
      }),
      onOutput: vi.fn(() => () => undefined),
      onChanged: vi.fn(() => () => undefined),
    };
    const ipc = {
      handle: vi.fn((channel: string, handler: Handler) =>
        handlers.set(channel, handler),
      ),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const renderer = createTrustedRenderer();
    const unregisterIpc = registerTerminalIpc({
      ipc,
      manager,
      windows: () => renderer.windows,
      isTrustedRendererUrl: (url) => url === trustedRendererUrl,
      admission,
    });
    const { DesktopLifecycle } = await import("../lifecycle");
    const lifecycle = new DesktopLifecycle({
      app: { quit: vi.fn() },
      manager,
      platform: "darwin",
      getWindowCount: () => 1,
      createWindow: vi.fn(),
      confirmQuit: vi.fn(async () => true),
      closeDatabase: vi.fn(),
      unregisterIpc,
      admission,
    });
    const create = handlers.get(IPC_CHANNELS.terminalCreate)!(renderer.event, {
      cols: 80,
      rows: 24,
    });

    const quitting = lifecycle.onBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(admission.isClosed()).toBe(true));

    await expect(
      handlers.get(IPC_CHANNELS.terminalCreate)!(renderer.event, {
        cols: 80,
        rows: 24,
      }),
    ).rejects.toBeInstanceOf(TerminalShutdownError);
    expect(manager.closeAll).not.toHaveBeenCalled();

    resolveCreate(descriptor);
    await create;
    await quitting;

    expect(manager.closeAll).toHaveBeenCalledOnce();
  });

  it("reopens admission after closeAll fails so later IPC can be served", async () => {
    const handlers = new Map<string, Handler>();
    const admission = new TerminalAdmissionGate();
    const failure = new Error("terminal termination failed");
    const manager = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => descriptor),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      replay: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => {
        throw failure;
      }),
      onOutput: vi.fn(() => () => undefined),
      onChanged: vi.fn(() => () => undefined),
    };
    const ipc = {
      handle: vi.fn((channel: string, handler: Handler) =>
        handlers.set(channel, handler),
      ),
      removeHandler: vi.fn(),
    };
    const renderer = createTrustedRenderer();
    const unregisterIpc = registerTerminalIpc({
      ipc,
      manager,
      windows: () => renderer.windows,
      isTrustedRendererUrl: (url) => url === trustedRendererUrl,
      admission,
    });
    const { DesktopLifecycle } = await import("../lifecycle");
    const lifecycle = new DesktopLifecycle({
      app: { quit: vi.fn() },
      manager,
      platform: "darwin",
      getWindowCount: () => 1,
      createWindow: vi.fn(),
      confirmQuit: vi.fn(async () => true),
      closeDatabase: vi.fn(),
      unregisterIpc,
      admission,
      reportError: vi.fn(),
    });

    await lifecycle.onBeforeQuit({ preventDefault: vi.fn() });

    expect(admission.isClosed()).toBe(false);
    await expect(
      handlers.get(IPC_CHANNELS.terminalCreate)!(renderer.event, {
        cols: 80,
        rows: 24,
      }),
    ).resolves.toEqual(descriptor);
  });
});

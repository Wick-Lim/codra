import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CodraDesktopApi,
  TerminalDescriptor,
  TerminalOutputChunk,
} from "@codra/protocol";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { TerminalSidebar } from "./TerminalSidebar";
import { TerminalPane } from "./TerminalPane";

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as Array<{
    cols: number;
    rows: number;
    loadAddon: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    inputDispose: ReturnType<typeof vi.fn>;
    emitData(data: string): void;
  }>,
  addons: [] as Array<{
    fit: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    readonly cols = 116;
    readonly rows = 34;
    readonly loadAddon = vi.fn();
    readonly open = vi.fn();
    readonly write = vi.fn();
    readonly focus = vi.fn();
    readonly dispose = vi.fn();
    readonly inputDispose = vi.fn();
    private inputListener: ((data: string) => void) | undefined;

    constructor() {
      xtermMocks.terminals.push(this);
    }

    onData(listener: (data: string) => void) {
      this.inputListener = listener;
      return { dispose: this.inputDispose };
    }

    emitData(data: string) {
      this.inputListener?.(data);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    readonly fit = vi.fn();
    readonly dispose = vi.fn();

    constructor() {
      xtermMocks.addons.push(this);
    }
  },
}));

class ResizeObserverFake {
  static instances: ResizeObserverFake[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverFake.instances.push(this);
  }

  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function createPaneApi(
  replay: TerminalOutputChunk[] | Promise<TerminalOutputChunk[]> = [],
): CodraDesktopApi & {
  emitOutput(chunk: TerminalOutputChunk): void;
  readonly outputUnsubscribes: ReturnType<typeof vi.fn>[];
  activeOutputSubscriptions(): number;
} {
  const outputListeners = new Set<(chunk: TerminalOutputChunk) => void>();
  const outputUnsubscribes: ReturnType<typeof vi.fn>[] = [];
  const api: CodraDesktopApi = {
    agents: {
      list: vi.fn().mockResolvedValue([
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
          kind: "claude",
          label: "Claude Code",
          description: "Anthropic's agentic coding CLI.",
          available: true,
          supportsYolo: true,
          modelRequired: false,
          efforts: [{ id: "high", label: "High" }],
          models: [{ id: "sonnet", label: "Sonnet" }],
          installHint: "Install Claude Code to use this runtime.",
          setup: {
            installMethod: "managed_npm",
            authentication: "required",
          },
        },
        {
          kind: "gemini",
          label: "Gemini CLI",
          description: "Google's open-source terminal coding agent.",
          available: true,
          supportsYolo: true,
          modelRequired: false,
          efforts: [],
          models: [
            { id: "auto", label: "Auto" },
            { id: "pro", label: "Pro" },
          ],
          installHint: "Install @google/gemini-cli to use this runtime.",
          setup: {
            installMethod: "managed_npm",
            authentication: "required",
          },
        },
        {
          kind: "ollama",
          label: "Ollama",
          description: "Run a local model through Ollama.",
          available: true,
          supportsYolo: false,
          modelRequired: true,
          efforts: [{ id: "high", label: "High" }],
          models: [{ id: "gemma4:e4b", label: "gemma4:e4b" }],
          installHint: "Install Ollama and pull a model to use this runtime.",
          setup: {
            installMethod: "external",
            authentication: "not_required",
          },
        },
      ]),
    },
    terminal: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      replay: vi.fn().mockResolvedValue(replay),
      close: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn((listener) => {
        outputListeners.add(listener);
        const unsubscribe = vi.fn(() => {
          outputListeners.delete(listener);
        });
        outputUnsubscribes.push(unsubscribe);
        return unsubscribe;
      }),
      onChanged: vi.fn(() => vi.fn()),
    },
    remote: {
      getState: vi.fn().mockResolvedValue({ state: "idle" }),
      getAuthState: vi.fn().mockResolvedValue({ state: "signed_out" }),
      login: vi.fn().mockResolvedValue({
        state: "signed_in",
        profile: {
          displayName: "Jun Hyeog Im",
          email: "jun@example.com",
          photoUrl: null,
        },
      }),
      logout: vi.fn().mockResolvedValue({ state: "signed_out" }),
      activate: vi.fn().mockResolvedValue({ state: "online" }),
      deactivate: vi.fn().mockResolvedValue({ state: "idle" }),
      onStateChanged: vi.fn(() => vi.fn()),
      onAuthStateChanged: vi.fn(() => vi.fn()),
    },
  };

  return Object.assign(api, {
    emitOutput(chunk: TerminalOutputChunk) {
      for (const listener of [...outputListeners]) listener(chunk);
    },
    outputUnsubscribes,
    activeOutputSubscriptions() {
      return outputListeners.size;
    },
  });
}

function chunk(
  sequence: number,
  data = `chunk ${sequence}\r\n`,
): TerminalOutputChunk {
  return {
    terminalId: runningTerminal.id,
    sequence,
    data,
  };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return {
    promise,
    resolve(value: T) {
      resolve?.(value);
    },
    reject(reason: unknown) {
      reject?.(reason);
    },
  };
}

const runningTerminal: TerminalDescriptor = {
  id: "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5",
  title: "api",
  cwd: "/workspace/services/api",
  cols: 100,
  rows: 30,
  state: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const exitedTerminal: TerminalDescriptor = {
  ...runningTerminal,
  id: "ba040703-89de-4147-8773-8e86ec5e7e13",
  title: "tests",
  cwd: "C:\\workspace\\tests",
  state: "exited",
  exitCode: 1,
};

describe("TerminalSidebar", () => {
  it("keeps remote controls out of the CLI session rail", async () => {
    const onSignIn = vi.fn();
    render(
      <TerminalSidebar
        terminals={[]}
        activeId={null}
        accountStatus={{ state: "signed_out" }}
        onSignIn={onSignIn}
        onOpenSettings={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    expect(screen.queryByRole("region", { name: "Remote access" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in to CODRA" }),
    );
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("shows terminal identity, cwd basename, and retained exit state", () => {
    render(
      <TerminalSidebar
        terminals={[runningTerminal, exitedTerminal]}
        activeId={exitedTerminal.id}
      />,
    );

    expect(screen.getByRole("navigation", { name: "Terminals" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New agent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New terminal" })).toBeVisible();
    expect(screen.getAllByText("api")[0]).toBeVisible();
    expect(screen.getAllByText("tests")[0]).toBeVisible();
    expect(screen.getByText("Exited")).toBeVisible();
    expect(screen.getAllByText("api")).toHaveLength(2);
    expect(screen.getAllByText("tests")).toHaveLength(2);
  });

  it("exposes selection, creation, and close actions to keyboard users", async () => {
    const onCreateAgent = vi.fn();
    const onCreateTerminal = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <TerminalSidebar
        terminals={[runningTerminal]}
        activeId={runningTerminal.id}
        onCreateAgent={onCreateAgent}
        onCreateTerminal={onCreateTerminal}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const terminalButton = screen.getByRole("button", {
      name: "api, api, Running",
    });
    expect(terminalButton).toHaveAttribute("aria-current", "true");

    await user.tab();
    expect(screen.getByRole("button", { name: "New agent" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByRole("button", { name: "New terminal" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(terminalButton).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByRole("button", { name: "Close api" })).toHaveFocus();
    await user.keyboard(" ");

    expect(onCreateAgent).toHaveBeenCalledOnce();
    expect(onCreateTerminal).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(runningTerminal.id);
    expect(onClose).toHaveBeenCalledWith(runningTerminal.id);
  });

  it("keeps a long pane registry inside a scrollable sidebar track", () => {
    const terminals = Array.from({ length: 30 }, (_, index) => ({
      ...runningTerminal,
      id: `terminal-${index + 1}`,
      title: `shell ${index + 1}`,
    }));
    const { container } = render(
      <TerminalSidebar terminals={terminals} activeId={terminals[0]!.id} />,
    );

    const sidebar = container.querySelector(".terminal-sidebar");
    const registry = screen.getByRole("navigation", { name: "Terminals" });
    expect(sidebar).toContainElement(registry);
    expect(registry).toHaveAttribute("data-scroll-region", "pane-registry");
    expect(registry.querySelectorAll(".terminal-list-item")).toHaveLength(30);
    expect(
      screen.getByRole("button", { name: "shell 30, api, Running" }),
    ).toBeInTheDocument();
  });
});

describe("TerminalPane", () => {
  beforeEach(() => {
    xtermMocks.terminals.length = 0;
    xtermMocks.addons.length = 0;
    ResizeObserverFake.instances.length = 0;
    vi.stubGlobal("ResizeObserver", ResizeObserverFake);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("replays before ordered live output and forwards terminal input", async () => {
    let resolveReplay: ((chunks: TerminalOutputChunk[]) => void) | undefined;
    const replay = new Promise<TerminalOutputChunk[]>((resolve) => {
      resolveReplay = resolve;
    });
    const api = createPaneApi(replay);
    const liveChunk: TerminalOutputChunk = {
      terminalId: runningTerminal.id,
      sequence: 2,
      data: "live\r\n",
    };
    const { rerender } = render(
      <TerminalPane terminal={runningTerminal} api={api} />,
    );

    expect(api.terminal.onOutput).toHaveBeenCalledOnce();
    expect(
      vi.mocked(api.terminal.onOutput).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(api.terminal.replay).mock.invocationCallOrder[0]!);
    expect(api.terminal.replay).toHaveBeenCalledWith({
      terminalId: runningTerminal.id,
      afterSequence: 0,
      limit: 1000,
    });
    act(() => api.emitOutput(liveChunk));
    expect(xtermMocks.terminals[0]?.write).not.toHaveBeenCalled();

    await act(async () => {
      resolveReplay?.([
        {
          terminalId: runningTerminal.id,
          sequence: 1,
          data: "$ ",
        },
        {
          terminalId: runningTerminal.id,
          sequence: 2,
          data: "replayed\r\n",
        },
      ]);
      await replay;
    });

    expect(xtermMocks.terminals[0]?.write.mock.calls).toEqual([
      ["$ "],
      ["replayed\r\n"],
    ]);

    const thirdChunk: TerminalOutputChunk = {
      terminalId: runningTerminal.id,
      sequence: 3,
      data: "done\r\n",
    };
    act(() => api.emitOutput(thirdChunk));
    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write).toHaveBeenLastCalledWith(
        "done\r\n",
      );
    });

    xtermMocks.terminals[0]?.emitData("pwd\r");
    expect(api.terminal.write).toHaveBeenCalledWith({
      terminalId: runningTerminal.id,
      data: "pwd\r",
    });
    rerender(
      <TerminalPane
        terminal={{ ...runningTerminal, title: "api — ready" }}
        api={api}
      />,
    );
    expect(api.terminal.onOutput).toHaveBeenCalledOnce();
  });

  it("paginates replay and deduplicates overlapping live output", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      chunk(index + 1),
    );
    const api = createPaneApi();
    vi.mocked(api.terminal.replay)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([chunk(1001, "replayed 1001\r\n")]);

    render(<TerminalPane terminal={runningTerminal} api={api} />);
    act(() => {
      api.emitOutput(chunk(1001, "live duplicate 1001\r\n"));
      api.emitOutput(chunk(1002, "live 1002\r\n"));
    });

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write).toHaveBeenCalledTimes(1002);
    });
    expect(vi.mocked(api.terminal.replay).mock.calls).toEqual([
      [
        {
          terminalId: runningTerminal.id,
          afterSequence: 0,
          limit: 1000,
        },
      ],
      [
        {
          terminalId: runningTerminal.id,
          afterSequence: 1000,
          limit: 1000,
        },
      ],
    ]);
    expect(xtermMocks.terminals[0]?.write.mock.calls[1000]).toEqual([
      "replayed 1001\r\n",
    ]);
    expect(xtermMocks.terminals[0]?.write).toHaveBeenLastCalledWith(
      "live 1002\r\n",
    );
  });

  it("buffers live sequence gaps until the missing chunk arrives", async () => {
    const api = createPaneApi([chunk(1, "$ ")]);
    render(<TerminalPane terminal={runningTerminal} api={api} />);
    act(() => {
      api.emitOutput(chunk(3, "three\r\n"));
      api.emitOutput(chunk(3, "duplicate three\r\n"));
    });

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write).toHaveBeenCalledWith("$ ");
    });
    expect(xtermMocks.terminals[0]?.write.mock.calls).toEqual([["$ "]]);

    act(() => api.emitOutput(chunk(2, "two\r\n")));

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write.mock.calls).toEqual([
        ["$ "],
        ["two\r\n"],
        ["three\r\n"],
      ]);
    });
  });

  it("ignores output for inactive terminals", async () => {
    const api = createPaneApi();
    render(<TerminalPane terminal={runningTerminal} api={api} />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      api.emitOutput({
        terminalId: exitedTerminal.id,
        sequence: 1,
        data: "inactive\r\n",
      });
      api.emitOutput(chunk(1, "active\r\n"));
    });

    expect(xtermMocks.terminals[0]?.write.mock.calls).toEqual([["active\r\n"]]);
  });

  it("streams thousands of chunks without React commits or accumulated output props", async () => {
    const api = createPaneApi();
    let commits = 0;
    render(
      <React.Profiler
        id="terminal-pane"
        onRender={() => {
          commits += 1;
        }}
      >
        <TerminalPane terminal={runningTerminal} api={api} />
      </React.Profiler>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const commitsBeforeOutput = commits;

    act(() => {
      for (let sequence = 1; sequence <= 5_000; sequence += 1) {
        api.emitOutput(chunk(sequence));
      }
    });

    expect(xtermMocks.terminals[0]?.write).toHaveBeenCalledTimes(5_000);
    expect(commits).toBe(commitsBeforeOutput);
  });

  it("uses a compacted replay as the live sequence baseline", async () => {
    const api = createPaneApi([chunk(10, "ten\r\n"), chunk(12, "twelve\r\n")]);
    render(<TerminalPane terminal={runningTerminal} api={api} />);
    act(() => api.emitOutput(chunk(13, "thirteen\r\n")));

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write.mock.calls).toEqual([
        ["ten\r\n"],
        ["twelve\r\n"],
        ["thirteen\r\n"],
      ]);
    });
  });

  it("renders buffered live output above sequence one when initial replay fails", async () => {
    const api = createPaneApi();
    vi.mocked(api.terminal.replay).mockRejectedValueOnce(
      new Error("scrollback unavailable"),
    );
    render(<TerminalPane terminal={runningTerminal} api={api} />);
    act(() => api.emitOutput(chunk(7, "live seven\r\n")));

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write).toHaveBeenCalledWith(
        "live seven\r\n",
      );
    });
  });

  it("renders live output that arrives after initial replay has failed", async () => {
    const failedReplay = deferred<TerminalOutputChunk[]>();
    const api = createPaneApi(failedReplay.promise);
    render(<TerminalPane terminal={runningTerminal} api={api} />);

    await act(async () => {
      failedReplay.reject(new Error("scrollback unavailable"));
      await failedReplay.promise.catch(() => undefined);
    });
    act(() => api.emitOutput(chunk(9, "live nine\r\n")));

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write).toHaveBeenCalledWith(
        "live nine\r\n",
      );
    });
  });

  it("retains replay and resumes live output when a later replay page fails", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      chunk(index + 1),
    );
    const failedPage = deferred<TerminalOutputChunk[]>();
    const api = createPaneApi();
    vi.mocked(api.terminal.replay)
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(failedPage.promise);
    render(<TerminalPane terminal={runningTerminal} api={api} />);
    await waitFor(() => {
      expect(api.terminal.replay).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      failedPage.reject(new Error("second replay page unavailable"));
      await failedPage.promise.catch(() => undefined);
    });
    expect(xtermMocks.terminals[0]?.write).toHaveBeenCalledTimes(1000);

    act(() => api.emitOutput(chunk(1005, "live 1005\r\n")));
    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write).toHaveBeenLastCalledWith(
        "live 1005\r\n",
      );
    });
  });

  it("does not recover a failed replay into a stale terminal after terminal change", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      chunk(index + 1),
    );
    const failedPage = deferred<TerminalOutputChunk[]>();
    const api = createPaneApi();
    vi.mocked(api.terminal.replay).mockImplementation((request) => {
      if (request.terminalId === exitedTerminal.id) return Promise.resolve([]);
      if (request.afterSequence === 0) return Promise.resolve(firstPage);
      return failedPage.promise;
    });
    const { rerender } = render(
      <TerminalPane terminal={runningTerminal} api={api} />,
    );
    act(() => api.emitOutput(chunk(1005, "stale live\r\n")));
    const staleXterm = xtermMocks.terminals[0];
    await waitFor(() => {
      expect(api.terminal.replay).toHaveBeenCalledWith({
        terminalId: runningTerminal.id,
        afterSequence: 1000,
        limit: 1000,
      });
    });

    rerender(<TerminalPane terminal={exitedTerminal} api={api} />);
    await act(async () => {
      failedPage.reject(new Error("stale page failed"));
      await failedPage.promise.catch(() => undefined);
    });

    expect(staleXterm?.write).not.toHaveBeenCalled();
  });

  it("does not recover a failed replay after unmount", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      chunk(index + 1),
    );
    const failedPage = deferred<TerminalOutputChunk[]>();
    const api = createPaneApi();
    vi.mocked(api.terminal.replay)
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(failedPage.promise);
    const { unmount } = render(
      <TerminalPane terminal={runningTerminal} api={api} />,
    );
    act(() => api.emitOutput(chunk(1005, "stale live\r\n")));
    const staleXterm = xtermMocks.terminals[0];
    await waitFor(() => {
      expect(api.terminal.replay).toHaveBeenCalledTimes(2);
    });

    unmount();
    await act(async () => {
      failedPage.reject(new Error("stale page failed"));
      await failedPage.promise.catch(() => undefined);
    });

    expect(staleXterm?.write).not.toHaveBeenCalled();
  });

  it("cancels a stale replay page when the active terminal changes", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      chunk(index + 1),
    );
    const stalePage = deferred<TerminalOutputChunk[]>();
    const api = createPaneApi();
    vi.mocked(api.terminal.replay).mockImplementation((request) => {
      if (request.terminalId === exitedTerminal.id) return Promise.resolve([]);
      if (request.afterSequence === 0) return Promise.resolve(firstPage);
      return stalePage.promise;
    });
    const { rerender } = render(
      <TerminalPane terminal={runningTerminal} api={api} />,
    );
    const staleXterm = xtermMocks.terminals[0];
    await waitFor(() => {
      expect(api.terminal.replay).toHaveBeenCalledWith({
        terminalId: runningTerminal.id,
        afterSequence: 1000,
        limit: 1000,
      });
    });

    rerender(<TerminalPane terminal={exitedTerminal} api={api} />);
    await act(async () => {
      stalePage.resolve([chunk(1001)]);
      await stalePage.promise;
    });

    expect(staleXterm?.write).not.toHaveBeenCalled();
  });

  it("cancels a stale replay page after unmount", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      chunk(index + 1),
    );
    const stalePage = deferred<TerminalOutputChunk[]>();
    const api = createPaneApi();
    vi.mocked(api.terminal.replay)
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(stalePage.promise);
    const { unmount } = render(
      <TerminalPane terminal={runningTerminal} api={api} />,
    );
    const staleXterm = xtermMocks.terminals[0];
    await waitFor(() => {
      expect(api.terminal.replay).toHaveBeenCalledTimes(2);
    });

    unmount();
    await act(async () => {
      stalePage.resolve([chunk(1001)]);
      await stalePage.promise;
    });

    expect(staleXterm?.write).not.toHaveBeenCalled();
  });

  it("keeps one lifecycle for descriptor updates and cleans up on terminal change", async () => {
    vi.useFakeTimers();
    const api = createPaneApi();
    const { rerender, unmount } = render(
      <TerminalPane terminal={runningTerminal} api={api} />,
    );
    const firstXterm = xtermMocks.terminals[0];
    const firstAddon = xtermMocks.addons[0];
    const firstObserver = ResizeObserverFake.instances[0];
    expect(api.activeOutputSubscriptions()).toBe(1);

    rerender(
      <TerminalPane
        terminal={{ ...runningTerminal, title: "api — ready" }}
        api={api}
      />,
    );
    expect(xtermMocks.terminals).toHaveLength(1);

    act(() => {
      firstObserver?.emit();
      vi.advanceTimersByTime(120);
    });
    expect(firstAddon?.fit).toHaveBeenCalled();
    expect(api.terminal.resize).toHaveBeenCalledWith({
      terminalId: runningTerminal.id,
      cols: 116,
      rows: 34,
    });

    rerender(<TerminalPane terminal={exitedTerminal} api={api} />);
    expect(xtermMocks.terminals).toHaveLength(2);
    expect(firstXterm?.inputDispose).toHaveBeenCalledOnce();
    expect(firstXterm?.dispose).toHaveBeenCalledOnce();
    expect(firstAddon?.dispose).toHaveBeenCalledOnce();
    expect(firstObserver?.disconnect).toHaveBeenCalledOnce();
    expect(api.outputUnsubscribes[0]).toHaveBeenCalledOnce();
    expect(api.terminal.onOutput).toHaveBeenCalledTimes(2);
    expect(api.activeOutputSubscriptions()).toBe(1);

    const secondXterm = xtermMocks.terminals[1];
    const secondAddon = xtermMocks.addons[1];
    const secondObserver = ResizeObserverFake.instances[1];
    act(() => api.emitOutput(chunk(1, "stale first terminal\r\n")));
    expect(secondXterm?.write).not.toHaveBeenCalledWith(
      "stale first terminal\r\n",
    );
    unmount();

    expect(secondXterm?.dispose).toHaveBeenCalledOnce();
    expect(secondAddon?.dispose).toHaveBeenCalledOnce();
    expect(secondObserver?.disconnect).toHaveBeenCalledOnce();
    expect(api.outputUnsubscribes[1]).toHaveBeenCalledOnce();
    expect(api.activeOutputSubscriptions()).toBe(0);
  });

  it("labels active and empty terminal stages for assistive technology", () => {
    const api = createPaneApi();
    const { rerender } = render(
      <TerminalPane terminal={runningTerminal} api={api} />,
    );
    expect(
      screen.getByRole("region", { name: "Terminal api" }),
    ).toHaveAttribute("data-terminal-id", runningTerminal.id);

    rerender(<TerminalPane terminal={null} api={api} />);
    expect(screen.getByText("Create a terminal to begin.")).toBeVisible();
  });
});

describe("App terminal workspace", () => {
  beforeEach(() => {
    xtermMocks.terminals.length = 0;
    xtermMocks.addons.length = 0;
    ResizeObserverFake.instances.length = 0;
    vi.stubGlobal("ResizeObserver", ResizeObserverFake);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects the terminal registry, active pane, and status strip", async () => {
    const api = createPaneApi();
    vi.mocked(api.terminal.list).mockResolvedValue([runningTerminal]);
    Object.defineProperty(window, "codra", {
      configurable: true,
      value: api,
    });

    render(React.createElement(App));

    expect(
      await screen.findByRole("navigation", { name: "Terminals" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("region", { name: "Terminal api" }),
    ).toHaveAttribute("data-terminal-id", runningTerminal.id);
    expect(screen.getByRole("status")).toHaveTextContent("Running");
    expect(screen.getByRole("status")).toHaveTextContent("100 × 30");
  });

  it("removes a terminal from the sidebar after its close request succeeds", async () => {
    const api = createPaneApi();
    vi.mocked(api.terminal.list).mockResolvedValue([runningTerminal]);
    Object.defineProperty(window, "codra", {
      configurable: true,
      value: api,
    });

    render(React.createElement(App));

    await userEvent.click(
      await screen.findByRole("button", { name: "Close api" }),
    );

    await waitFor(() =>
      expect(api.terminal.close).toHaveBeenCalledWith(runningTerminal.id),
    );
    expect(screen.queryByRole("button", { name: "Close api" })).toBeNull();
    expect(
      screen.getByText("No terminals. Create one to start."),
    ).toBeVisible();
  });

  it("launches a configured CLI agent and keeps plain terminal creation separate", async () => {
    const api = createPaneApi();
    vi.mocked(api.terminal.create)
      .mockResolvedValueOnce({ ...runningTerminal, title: "Gemini · pro" })
      .mockResolvedValueOnce(runningTerminal);
    Object.defineProperty(window, "codra", {
      configurable: true,
      value: api,
    });

    render(React.createElement(App));

    await userEvent.click(
      await screen.findByRole("button", { name: "New agent" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "New agent" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("radio", { name: /Gemini CLI/ }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "pro",
    );
    await userEvent.click(screen.getByRole("switch", { name: "YOLO mode" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "First prompt" }),
      "Fix the desktop login flow",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() =>
      expect(api.terminal.create).toHaveBeenCalledWith({
        cols: 100,
        rows: 30,
        agent: {
          kind: "gemini",
          yolo: true,
          model: "pro",
          prompt: "Fix the desktop login flow",
        },
      }),
    );
    expect(screen.queryByRole("dialog", { name: "New agent" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() =>
      expect(api.terminal.create).toHaveBeenLastCalledWith({
        cols: 100,
        rows: 30,
      }),
    );
  });

  it("opens sign-in and settings as supporting modal surfaces", async () => {
    const api = createPaneApi();
    Object.defineProperty(window, "codra", {
      configurable: true,
      value: api,
    });

    render(React.createElement(App));

    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in to CODRA" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Sign in to CODRA" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Google/ }));
    expect(api.remote.login).toHaveBeenCalledWith("google");
    expect(api.remote.activate).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Remote offline — open settings" }),
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    const remoteSwitch = screen.getByRole("switch", {
      name: "Remote access",
    });
    expect(remoteSwitch).not.toBeDisabled();
    await userEvent.click(remoteSwitch);
    expect(api.remote.activate).toHaveBeenCalledOnce();
  });
});

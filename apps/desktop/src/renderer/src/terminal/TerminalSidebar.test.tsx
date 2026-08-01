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
): CodraDesktopApi {
  return {
    terminal: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      replay: vi.fn().mockResolvedValue(replay),
      close: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn(() => vi.fn()),
      onChanged: vi.fn(() => vi.fn()),
    },
  };
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
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return {
    promise,
    resolve(value: T) {
      resolve?.(value);
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
  it("shows terminal identity, cwd basename, and retained exit state", () => {
    render(
      <TerminalSidebar
        terminals={[runningTerminal, exitedTerminal]}
        activeId={exitedTerminal.id}
      />,
    );

    expect(screen.getByRole("navigation", { name: "Terminals" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New terminal" })).toBeVisible();
    expect(screen.getAllByText("api")[0]).toBeVisible();
    expect(screen.getAllByText("tests")[0]).toBeVisible();
    expect(screen.getByText("Exited")).toBeVisible();
    expect(screen.getAllByText("api")).toHaveLength(2);
    expect(screen.getAllByText("tests")).toHaveLength(2);
  });

  it("exposes selection, creation, and close actions to keyboard users", async () => {
    const onCreate = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <TerminalSidebar
        terminals={[runningTerminal]}
        activeId={runningTerminal.id}
        onCreate={onCreate}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const terminalButton = screen.getByRole("button", {
      name: "api, api, Running",
    });
    expect(terminalButton).toHaveAttribute("aria-current", "true");

    await user.tab();
    expect(screen.getByRole("button", { name: "New terminal" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(terminalButton).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByRole("button", { name: "Close api" })).toHaveFocus();
    await user.keyboard(" ");

    expect(onCreate).toHaveBeenCalledOnce();
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
      <TerminalPane
        terminal={runningTerminal}
        output={[liveChunk]}
        api={api}
      />,
    );

    expect(api.terminal.replay).toHaveBeenCalledWith({
      terminalId: runningTerminal.id,
      afterSequence: 0,
      limit: 1000,
    });
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
    rerender(
      <TerminalPane
        terminal={runningTerminal}
        output={[liveChunk, thirdChunk]}
        api={api}
      />,
    );
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
  });

  it("paginates replay and deduplicates overlapping live output", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      chunk(index + 1),
    );
    const api = createPaneApi();
    vi.mocked(api.terminal.replay)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([chunk(1001, "replayed 1001\r\n")]);

    render(
      <TerminalPane
        terminal={runningTerminal}
        output={[
          chunk(1001, "live duplicate 1001\r\n"),
          chunk(1002, "live 1002\r\n"),
        ]}
        api={api}
      />,
    );

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
    const { rerender } = render(
      <TerminalPane
        terminal={runningTerminal}
        output={[chunk(3, "three\r\n"), chunk(3, "three\r\n")]}
        api={api}
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write).toHaveBeenCalledWith("$ ");
    });
    expect(xtermMocks.terminals[0]?.write.mock.calls).toEqual([["$ "]]);

    rerender(
      <TerminalPane
        terminal={runningTerminal}
        output={[
          chunk(3, "three\r\n"),
          chunk(2, "two\r\n"),
          chunk(3, "three\r\n"),
        ]}
        api={api}
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write.mock.calls).toEqual([
        ["$ "],
        ["two\r\n"],
        ["three\r\n"],
      ]);
    });
  });

  it("uses a compacted replay as the live sequence baseline", async () => {
    const api = createPaneApi([chunk(10, "ten\r\n"), chunk(12, "twelve\r\n")]);
    render(
      <TerminalPane
        terminal={runningTerminal}
        output={[chunk(13, "thirteen\r\n")]}
        api={api}
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals[0]?.write.mock.calls).toEqual([
        ["ten\r\n"],
        ["twelve\r\n"],
        ["thirteen\r\n"],
      ]);
    });
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
      <TerminalPane terminal={runningTerminal} output={[]} api={api} />,
    );
    const staleXterm = xtermMocks.terminals[0];
    await waitFor(() => {
      expect(api.terminal.replay).toHaveBeenCalledWith({
        terminalId: runningTerminal.id,
        afterSequence: 1000,
        limit: 1000,
      });
    });

    rerender(<TerminalPane terminal={exitedTerminal} output={[]} api={api} />);
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
      <TerminalPane terminal={runningTerminal} output={[]} api={api} />,
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
      <TerminalPane terminal={runningTerminal} output={[]} api={api} />,
    );
    const firstXterm = xtermMocks.terminals[0];
    const firstAddon = xtermMocks.addons[0];
    const firstObserver = ResizeObserverFake.instances[0];

    rerender(
      <TerminalPane
        terminal={{ ...runningTerminal, title: "api — ready" }}
        output={[]}
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

    rerender(<TerminalPane terminal={exitedTerminal} output={[]} api={api} />);
    expect(xtermMocks.terminals).toHaveLength(2);
    expect(firstXterm?.inputDispose).toHaveBeenCalledOnce();
    expect(firstXterm?.dispose).toHaveBeenCalledOnce();
    expect(firstAddon?.dispose).toHaveBeenCalledOnce();
    expect(firstObserver?.disconnect).toHaveBeenCalledOnce();

    const secondXterm = xtermMocks.terminals[1];
    const secondAddon = xtermMocks.addons[1];
    const secondObserver = ResizeObserverFake.instances[1];
    unmount();

    expect(secondXterm?.dispose).toHaveBeenCalledOnce();
    expect(secondAddon?.dispose).toHaveBeenCalledOnce();
    expect(secondObserver?.disconnect).toHaveBeenCalledOnce();
  });

  it("labels active and empty terminal stages for assistive technology", () => {
    const api = createPaneApi();
    const { rerender } = render(
      <TerminalPane terminal={runningTerminal} output={[]} api={api} />,
    );
    expect(
      screen.getByRole("region", { name: "Terminal api" }),
    ).toHaveAttribute("data-terminal-id", runningTerminal.id);

    rerender(<TerminalPane terminal={null} output={[]} api={api} />);
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
});

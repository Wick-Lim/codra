// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalDescriptor, TerminalOutputChunk } from "@codra/protocol";
import {
  TERMINAL_THEME_TOKENS,
  WebTerminalPane,
  readTerminalTheme,
  type WebTerminalPort,
} from "./WebTerminalPane";
import { t } from "../i18n/messages";

afterEach(cleanup);

/**
 * xterm needs a real canvas and a real layout engine; jsdom has neither, so the
 * emulator is replaced by a fake that records what the pane asked of it. Same
 * hand-rolled-fake approach as `browser-peer.test.ts` and
 * `browser-channel.test.ts`, which stand in for a WebRTC stack jsdom also lacks.
 */
const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 120;
    rows = 40;
    readonly written: string[] = [];
    disposed = false;
    focused = false;
    private data: ((value: string) => void) | undefined;

    constructor(readonly options: Record<string, unknown>) {
      FakeTerminal.instances.push(this);
    }

    loadAddon(): void {}
    open(): void {}
    focus(): void {
      this.focused = true;
    }
    write(value: string): void {
      this.written.push(value);
    }
    onData(listener: (value: string) => void): { dispose(): void } {
      this.data = listener;
      return {
        dispose: () => {
          this.data = undefined;
        },
      };
    }
    type(value: string): void {
      this.data?.(value);
    }
    dispose(): void {
      this.disposed = true;
    }
  }

  class FakeFitAddon {
    fits = 0;
    fit(): void {
      this.fits += 1;
    }
    dispose(): void {}
  }

  return { FakeTerminal, FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xterm.FakeFitAddon }));

const terminalId = "7d0b7f8c-9d5f-4f3d-9f0e-96b0b0a1c111";

const descriptor: TerminalDescriptor = {
  id: terminalId,
  title: "claude",
  cwd: "/Users/codra/Projects",
  cols: 120,
  rows: 40,
  state: "running",
  createdAt: new Date(1_700_000_000_000).toISOString(),
};

function chunk(sequence: number, data: string): TerminalOutputChunk {
  return { terminalId, sequence, data };
}

class PortFake implements WebTerminalPort {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly replayed: number[] = [];
  replayPages: TerminalOutputChunk[][] = [[]];
  replayError: Error | undefined;
  private listeners = new Set<(value: TerminalOutputChunk) => void>();
  private release: (() => void) | undefined;
  private gate: Promise<void> | undefined;

  holdReplay(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseReplay(): void {
    this.release?.();
    this.release = undefined;
  }

  emit(value: TerminalOutputChunk): void {
    for (const listener of this.listeners) listener(value);
  }

  onOutput(listener: (value: TerminalOutputChunk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async write(request: { terminalId: string; data: string }): Promise<void> {
    this.writes.push(request.data);
  }

  async resize(request: {
    terminalId: string;
    cols: number;
    rows: number;
  }): Promise<void> {
    this.resizes.push({ cols: request.cols, rows: request.rows });
  }

  async replay(request: {
    terminalId: string;
    afterSequence: number;
    limit: number;
  }): Promise<TerminalOutputChunk[]> {
    await this.gate;
    if (this.replayError) throw this.replayError;
    this.replayed.push(request.afterSequence);
    return this.replayPages.shift() ?? [];
  }
}

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
  // jsdom implements no layout, so it ships no ResizeObserver either.
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      this.callback();
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

function latest() {
  const instance = xterm.FakeTerminal.instances.at(-1);
  if (!instance) throw new Error("no terminal was constructed");
  return instance;
}

describe("readTerminalTheme", () => {
  it("resolves every xterm colour from a CSS custom property", () => {
    const seen: string[] = [];
    const theme = readTerminalTheme((token) => {
      seen.push(token);
      return `resolved${token}`;
    });

    expect(seen).toEqual(Object.values(TERMINAL_THEME_TOKENS));
    expect(Object.keys(theme)).toEqual(Object.keys(TERMINAL_THEME_TOKENS));
    expect(theme.background).toBe("resolved--terminal-background");
  });

  it("omits a colour whose token is not defined rather than inventing one", () => {
    const theme = readTerminalTheme((token) =>
      token === TERMINAL_THEME_TOKENS.magenta ? "" : "#000000",
    );

    expect("magenta" in theme).toBe(false);
    expect(theme.foreground).toBe("#000000");
  });
});

describe("WebTerminalPane", () => {
  it("writes replayed output before live output and holds a gap open", async () => {
    const port = new PortFake();
    port.holdReplay();
    port.replayPages = [[chunk(1, "a"), chunk(2, "b")]];
    render(<WebTerminalPane terminal={descriptor} port={port} />);

    // Live frames arrive while the replay page is still in flight — exactly
    // what the host's auto-attach produces.
    port.emit(chunk(3, "c"));
    port.emit(chunk(5, "e"));
    expect(latest().written).toEqual([]);

    port.releaseReplay();
    await waitFor(() => expect(latest().written).toEqual(["a", "b", "c"]));

    port.emit(chunk(4, "d"));
    await waitFor(() =>
      expect(latest().written).toEqual(["a", "b", "c", "d", "e"]),
    );
  });

  it("ignores a chunk belonging to another terminal", async () => {
    const port = new PortFake();
    render(<WebTerminalPane terminal={descriptor} port={port} />);
    await waitFor(() => expect(port.replayed).toEqual([0]));

    port.emit({ terminalId: "other", sequence: 1, data: "nope" });
    port.emit(chunk(1, "yes"));

    await waitFor(() => expect(latest().written).toEqual(["yes"]));
  });

  it("still shows live output when the replay cannot be read", async () => {
    const port = new PortFake();
    port.holdReplay();
    port.replayError = new Error("REPLAY_UNAVAILABLE");
    render(<WebTerminalPane terminal={descriptor} port={port} />);

    port.emit(chunk(41, "late"));
    port.releaseReplay();

    await waitFor(() => expect(latest().written).toEqual(["late"]));
  });

  it("sends keystrokes as terminal.write", async () => {
    const port = new PortFake();
    render(<WebTerminalPane terminal={descriptor} port={port} />);
    await waitFor(() => expect(port.replayed).toEqual([0]));

    latest().type("ls\r");

    await waitFor(() => expect(port.writes).toEqual(["ls\r"]));
  });

  it("fits, then reports the fitted size as terminal.resize", async () => {
    const port = new PortFake();
    render(<WebTerminalPane terminal={descriptor} port={port} />);

    await waitFor(() =>
      expect(port.resizes).toEqual([{ cols: 120, rows: 40 }]),
    );
  });

  it("disposes the emulator when the pane goes away", async () => {
    const port = new PortFake();
    const { unmount } = render(
      <WebTerminalPane terminal={descriptor} port={port} />,
    );
    await waitFor(() => expect(port.replayed).toEqual([0]));

    const instance = latest();
    unmount();

    expect(instance.disposed).toBe(true);
  });

  it("renders an empty stage before an agent has been launched", () => {
    render(<WebTerminalPane terminal={null} port={new PortFake()} />);

    expect(screen.getByText(t.console.terminal.empty)).toBeTruthy();
    expect(xterm.FakeTerminal.instances).toHaveLength(0);
  });
});

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  CodraDesktopApi,
  TerminalDescriptor,
  TerminalOutputChunk,
} from "@codra/protocol";
import React from "react";

export interface TerminalPaneProps {
  terminal: TerminalDescriptor | null;
  api?: CodraDesktopApi;
}

interface TerminalRuntime {
  terminalId: string;
  xterm: XtermTerminal;
  pendingLive: Map<number, TerminalOutputChunk>;
  lastWrittenSequence: number;
  replayReady: boolean;
  replayDegraded: boolean;
  fallbackBaselineEstablished: boolean;
  disposed: boolean;
}

function flushOutput(runtime: TerminalRuntime): void {
  if (!runtime.replayReady || runtime.disposed) return;

  let nextSequence = runtime.lastWrittenSequence + 1;
  let chunk = runtime.pendingLive.get(nextSequence);
  if (
    !chunk &&
    runtime.replayDegraded &&
    !runtime.fallbackBaselineEstablished &&
    runtime.pendingLive.size > 0
  ) {
    let fallbackSequence: number | undefined;
    for (const sequence of runtime.pendingLive.keys()) {
      if (fallbackSequence === undefined || sequence < fallbackSequence) {
        fallbackSequence = sequence;
      }
    }
    if (fallbackSequence !== undefined) {
      nextSequence = fallbackSequence;
      runtime.lastWrittenSequence = nextSequence - 1;
      runtime.fallbackBaselineEstablished = true;
      chunk = runtime.pendingLive.get(nextSequence);
    }
  }
  while (chunk) {
    runtime.xterm.write(chunk.data);
    runtime.pendingLive.delete(nextSequence);
    runtime.lastWrittenSequence = nextSequence;
    nextSequence += 1;
    chunk = runtime.pendingLive.get(nextSequence);
  }
}

function finishReplay(
  runtime: TerminalRuntime,
  replayed: ReadonlyMap<number, TerminalOutputChunk>,
  degraded: boolean,
): void {
  if (runtime.disposed) return;

  const replayChunks = [...replayed.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (const chunk of replayChunks) runtime.xterm.write(chunk.data);
  runtime.lastWrittenSequence = replayChunks.at(-1)?.sequence ?? 0;
  for (const sequence of runtime.pendingLive.keys()) {
    if (sequence <= runtime.lastWrittenSequence) {
      runtime.pendingLive.delete(sequence);
    }
  }
  runtime.replayReady = true;
  runtime.replayDegraded = degraded;
  runtime.fallbackBaselineEstablished = false;
  flushOutput(runtime);
}

async function replayAll(
  runtime: TerminalRuntime,
  api: CodraDesktopApi,
): Promise<void> {
  const pageSize = 1000;
  const replayed = new Map<number, TerminalOutputChunk>();
  let afterSequence = 0;
  let degraded = false;

  try {
    while (!runtime.disposed) {
      const page = await api.terminal.replay({
        terminalId: runtime.terminalId,
        afterSequence,
        limit: pageSize,
      });
      if (runtime.disposed) return;

      for (const chunk of page) {
        if (
          chunk.terminalId === runtime.terminalId &&
          !replayed.has(chunk.sequence)
        ) {
          replayed.set(chunk.sequence, chunk);
        }
      }
      if (page.length < pageSize) break;

      const nextAfterSequence = page.at(-1)?.sequence;
      if (
        nextAfterSequence === undefined ||
        nextAfterSequence <= afterSequence
      ) {
        break;
      }
      afterSequence = nextAfterSequence;
    }
  } catch {
    degraded = true;
  }

  finishReplay(runtime, replayed, degraded);
}

export function TerminalPane({
  terminal,
  api = window.codra,
}: TerminalPaneProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!terminal || !host) return;

    const xterm = new XtermTerminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: 10_000,
      theme: {
        background: "#0b0e14",
        foreground: "#dbe1ea",
        cursor: "#91a7ff",
        cursorAccent: "#0b0e14",
        selectionBackground: "#2b3858",
        black: "#111722",
        red: "#dc7b7b",
        green: "#62c7a5",
        yellow: "#d8a25e",
        blue: "#7f9fe3",
        magenta: "#b28bd8",
        cyan: "#74b7c3",
        white: "#c5ced9",
        brightBlack: "#5f6b7a",
        brightRed: "#ed9292",
        brightGreen: "#7bd8b8",
        brightYellow: "#e7b875",
        brightBlue: "#9ab6f0",
        brightMagenta: "#c7a0eb",
        brightCyan: "#91cbd4",
        brightWhite: "#f1f4f8",
      },
    });
    const fitAddon = new FitAddon();
    const runtime: TerminalRuntime = {
      terminalId: terminal.id,
      xterm,
      pendingLive: new Map(),
      lastWrittenSequence: 0,
      replayReady: false,
      replayDegraded: false,
      fallbackBaselineEstablished: false,
      disposed: false,
    };
    xterm.loadAddon(fitAddon);
    xterm.open(host);
    xterm.focus();

    const input = xterm.onData((data) => {
      void api.terminal.write({ terminalId: terminal.id, data }).catch(() => {
        // The descriptor change event is the source of truth for terminal exits.
      });
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const fitAndResize = () => {
      fitAddon.fit();
      void api.terminal
        .resize({
          terminalId: terminal.id,
          cols: xterm.cols,
          rows: xterm.rows,
        })
        .catch(() => {
          // Resize can race a terminal exit; the retained pane remains readable.
        });
    };
    const scheduleResize = () => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitAndResize, 80);
    };
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(host);
    scheduleResize();

    const stopOutput = api.terminal.onOutput((chunk) => {
      if (
        runtime.disposed ||
        chunk.terminalId !== runtime.terminalId ||
        chunk.sequence <= runtime.lastWrittenSequence ||
        runtime.pendingLive.has(chunk.sequence)
      ) {
        return;
      }

      runtime.pendingLive.set(chunk.sequence, chunk);
      flushOutput(runtime);
    });
    void replayAll(runtime, api);

    return () => {
      runtime.disposed = true;
      stopOutput();
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      input.dispose();
      fitAddon.dispose();
      xterm.dispose();
    };
  }, [api, terminal?.id]);

  if (!terminal) {
    return (
      <section
        className="terminal-empty"
        role="region"
        aria-label="Terminal stage"
      >
        <p>Create a terminal to begin.</p>
        <span>Use New terminal to open a local shell.</span>
      </section>
    );
  }

  return (
    <section
      className="terminal-pane"
      role="region"
      aria-label={`Terminal ${terminal.title}`}
      data-testid="active-terminal"
      data-terminal-id={terminal.id}
    >
      <div className="terminal-canvas" ref={hostRef} />
    </section>
  );
}

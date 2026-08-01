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
  output: readonly TerminalOutputChunk[];
  api?: CodraDesktopApi;
}

interface TerminalRuntime {
  terminalId: string;
  xterm: XtermTerminal;
  pending: Map<number, TerminalOutputChunk>;
  written: Set<number>;
  replayReady: boolean;
  disposed: boolean;
}

function flushOutput(runtime: TerminalRuntime): void {
  if (!runtime.replayReady || runtime.disposed) return;

  const chunks = [...runtime.pending.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  runtime.pending.clear();
  for (const chunk of chunks) {
    if (runtime.written.has(chunk.sequence)) continue;
    runtime.xterm.write(chunk.data);
    runtime.written.add(chunk.sequence);
  }
}

export function TerminalPane({
  terminal,
  output,
  api = window.codra,
}: TerminalPaneProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const runtimeRef = React.useRef<TerminalRuntime | null>(null);

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
        background: "#101214",
        foreground: "#ece8df",
        cursor: "#45e0f0",
        cursorAccent: "#101214",
        selectionBackground: "#29545a",
        black: "#171a1d",
        brightBlack: "#74777a",
        white: "#d8d5cd",
        brightWhite: "#fffaf0",
        cyan: "#45e0f0",
        brightCyan: "#80edf6",
      },
    });
    const fitAddon = new FitAddon();
    const runtime: TerminalRuntime = {
      terminalId: terminal.id,
      xterm,
      pending: new Map(),
      written: new Set(),
      replayReady: false,
      disposed: false,
    };
    runtimeRef.current = runtime;

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

    void api.terminal
      .replay({ terminalId: terminal.id, afterSequence: 0, limit: 1000 })
      .then(
        (chunks) => {
          if (runtime.disposed) return;
          for (const chunk of chunks)
            runtime.pending.set(chunk.sequence, chunk);
          runtime.replayReady = true;
          flushOutput(runtime);
        },
        () => {
          if (runtime.disposed) return;
          runtime.replayReady = true;
          flushOutput(runtime);
        },
      );

    return () => {
      runtime.disposed = true;
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      input.dispose();
      fitAddon.dispose();
      xterm.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [api, terminal?.id]);

  React.useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.terminalId !== terminal?.id) return;

    for (const chunk of output) {
      if (
        chunk.terminalId === runtime.terminalId &&
        !runtime.written.has(chunk.sequence)
      ) {
        runtime.pending.set(chunk.sequence, chunk);
      }
    }
    flushOutput(runtime);
  }, [output, terminal?.id]);

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
      data-terminal-id={terminal.id}
    >
      <div className="terminal-canvas" ref={hostRef} />
    </section>
  );
}

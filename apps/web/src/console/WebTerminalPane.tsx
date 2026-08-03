import { useEffect, useRef, type ReactElement } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  ReplayTerminalRequest,
  ResizeTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
  WriteTerminalRequest,
} from "@codra/protocol";
import { t } from "../i18n/messages";

const copy = t.console.terminal;

/**
 * Every xterm colour, and the CSS custom property it comes from.
 *
 * xterm takes its theme as a constructor argument, so CSS cannot style it. The
 * values therefore live in `src/styles.css` — including the thirteen that have
 * no instrument-deck token — and are read back here, which keeps the stylesheet
 * the single place the web console's colours are written down and keeps this
 * module free of colour literals.
 */
export const TERMINAL_THEME_TOKENS = {
  background: "--terminal-background",
  foreground: "--terminal-foreground",
  cursor: "--terminal-cursor",
  cursorAccent: "--terminal-cursor-accent",
  selectionBackground: "--terminal-selection",
  black: "--terminal-black",
  red: "--terminal-red",
  green: "--terminal-green",
  yellow: "--terminal-yellow",
  blue: "--terminal-blue",
  magenta: "--terminal-magenta",
  cyan: "--terminal-cyan",
  white: "--terminal-white",
  brightBlack: "--terminal-bright-black",
  brightRed: "--terminal-bright-red",
  brightGreen: "--terminal-bright-green",
  brightYellow: "--terminal-bright-yellow",
  brightBlue: "--terminal-bright-blue",
  brightMagenta: "--terminal-bright-magenta",
  brightCyan: "--terminal-bright-cyan",
  brightWhite: "--terminal-bright-white",
} as const;

/**
 * Builds the xterm theme from CSS custom properties.
 *
 * A token that resolves to nothing is left out rather than defaulted to some
 * literal here: a second copy of the palette in this file is exactly the
 * duplication the tokens exist to remove, and xterm's own default for a missing
 * key is a better answer than a stale guess.
 */
export function readTerminalTheme(
  resolve: (token: string) => string,
): Record<string, string> {
  const theme: Record<string, string> = {};
  for (const [key, token] of Object.entries(TERMINAL_THEME_TOKENS)) {
    const value = resolve(token).trim();
    if (value) theme[key] = value;
  }
  return theme;
}

function cssVariableResolver(element: Element): (token: string) => string {
  const computed = getComputedStyle(element);
  return (token) => computed.getPropertyValue(token);
}

/**
 * The terminal operations this pane needs, which is a subset of
 * `LocalTerminalRouterPort`.
 *
 * `ProxyTerminalRouter` satisfies it structurally, and that is the point: the
 * pane is handed the router, never the `RemoteAgentChannelClient`. Output
 * frames, cursor acknowledgements, and the early-frame queue all stay inside
 * the router, so no second frame path exists for them to disagree with.
 */
export interface WebTerminalPort {
  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void;
  write(request: WriteTerminalRequest): Promise<void>;
  resize(request: ResizeTerminalRequest): Promise<void>;
  replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]>;
}

export interface WebTerminalPaneProps {
  terminal: TerminalDescriptor | null;
  port: WebTerminalPort;
}

interface PaneRuntime {
  terminalId: string;
  xterm: XtermTerminal;
  pending: Map<number, TerminalOutputChunk>;
  lastWrittenSequence: number;
  replayReady: boolean;
  replayDegraded: boolean;
  baselineEstablished: boolean;
  disposed: boolean;
}

const REPLAY_PAGE_SIZE = 1000;
const RESIZE_DEBOUNCE_MS = 80;

/** Ported from `apps/desktop/src/renderer/src/terminal/TerminalPane.tsx:27-58`. */
function flushOutput(runtime: PaneRuntime): void {
  if (!runtime.replayReady || runtime.disposed) return;

  let nextSequence = runtime.lastWrittenSequence + 1;
  let chunk = runtime.pending.get(nextSequence);
  // A router that has trimmed its replay buffer, or a launch that produced
  // more output than one replay page holds, leaves the first live chunk above
  // `lastWrittenSequence + 1`. Without a baseline the pane would wait forever
  // for a sequence the router no longer has.
  if (
    !chunk &&
    runtime.replayDegraded &&
    !runtime.baselineEstablished &&
    runtime.pending.size > 0
  ) {
    let baseline: number | undefined;
    for (const sequence of runtime.pending.keys()) {
      if (baseline === undefined || sequence < baseline) baseline = sequence;
    }
    if (baseline !== undefined) {
      nextSequence = baseline;
      runtime.lastWrittenSequence = baseline - 1;
      runtime.baselineEstablished = true;
      chunk = runtime.pending.get(baseline);
    }
  }
  while (chunk) {
    runtime.xterm.write(chunk.data);
    runtime.pending.delete(nextSequence);
    runtime.lastWrittenSequence = nextSequence;
    nextSequence += 1;
    chunk = runtime.pending.get(nextSequence);
  }
}

/** Ported from `TerminalPane.tsx:83-125`. */
async function replayAll(
  runtime: PaneRuntime,
  port: WebTerminalPort,
): Promise<void> {
  const replayed = new Map<number, TerminalOutputChunk>();
  let afterSequence = 0;
  let degraded = false;

  try {
    while (!runtime.disposed) {
      const page = await port.replay({
        terminalId: runtime.terminalId,
        afterSequence,
        limit: REPLAY_PAGE_SIZE,
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
      if (page.length < REPLAY_PAGE_SIZE) break;
      const next = page.at(-1)?.sequence;
      if (next === undefined || next <= afterSequence) break;
      afterSequence = next;
    }
  } catch {
    degraded = true;
  }

  if (runtime.disposed) return;
  const ordered = [...replayed.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (const chunk of ordered) runtime.xterm.write(chunk.data);
  runtime.lastWrittenSequence = ordered.at(-1)?.sequence ?? 0;
  for (const sequence of runtime.pending.keys()) {
    if (sequence <= runtime.lastWrittenSequence)
      runtime.pending.delete(sequence);
  }
  runtime.replayReady = true;
  // A replay that returned nothing is as good as one that failed: either way
  // the pane has no baseline of its own and must take one from the live
  // stream, which is the normal case for a terminal the host auto-attached.
  runtime.replayDegraded = degraded || ordered.length === 0;
  runtime.baselineEstablished = false;
  flushOutput(runtime);
}

/**
 * Step 7 of the console flow: render output, send `terminal.write` and
 * `terminal.resize`.
 *
 * The xterm wiring is `apps/desktop/src/renderer/src/terminal/TerminalPane.tsx`
 * with its Electron IPC swapped for the injected port: same `FitAddon`, same
 * 80 ms debounced fit-and-resize, same replay-then-live sequence merge. The
 * theme is the one deliberate difference — see `TERMINAL_THEME_TOKENS`.
 */
export function WebTerminalPane({
  terminal,
  port,
}: WebTerminalPaneProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const portRef = useRef(port);
  portRef.current = port;

  const terminalId = terminal?.id;

  useEffect(() => {
    const host = hostRef.current;
    if (!terminalId || !host) return;
    const activePort = portRef.current;

    const xterm = new XtermTerminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: 10_000,
      theme: readTerminalTheme(
        cssVariableResolver(host.ownerDocument.documentElement),
      ),
    });
    const fitAddon = new FitAddon();
    const runtime: PaneRuntime = {
      terminalId,
      xterm,
      pending: new Map(),
      lastWrittenSequence: 0,
      replayReady: false,
      replayDegraded: false,
      baselineEstablished: false,
      disposed: false,
    };
    xterm.loadAddon(fitAddon);
    xterm.open(host);
    xterm.focus();

    const input = xterm.onData((data) => {
      void activePort.write({ terminalId, data }).catch(() => {
        // A write can race the agent exiting; `terminal.changed` is what
        // reports that, and the pane stays readable either way.
      });
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const fitAndResize = (): void => {
      fitAddon.fit();
      void activePort
        .resize({ terminalId, cols: xterm.cols, rows: xterm.rows })
        .catch(() => {
          // Same race as above.
        });
    };
    const scheduleResize = (): void => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitAndResize, RESIZE_DEBOUNCE_MS);
    };
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(host);
    scheduleResize();

    const stopOutput = activePort.onOutput((chunk) => {
      if (
        runtime.disposed ||
        chunk.terminalId !== runtime.terminalId ||
        chunk.sequence <= runtime.lastWrittenSequence ||
        runtime.pending.has(chunk.sequence)
      ) {
        return;
      }
      runtime.pending.set(chunk.sequence, chunk);
      flushOutput(runtime);
    });
    void replayAll(runtime, activePort);

    return () => {
      runtime.disposed = true;
      stopOutput();
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      input.dispose();
      fitAddon.dispose();
      xterm.dispose();
    };
  }, [terminalId]);

  if (!terminal) {
    return (
      <section className="terminal-empty" aria-label={copy.empty}>
        <p className="empty">{copy.empty}</p>
      </section>
    );
  }

  return (
    <section
      className="terminal-pane"
      aria-label={copy.regionLabel(terminal.title)}
      data-testid="console-terminal"
      data-terminal-id={terminal.id}
    >
      <div className="terminal-canvas" ref={hostRef} />
    </section>
  );
}

export default WebTerminalPane;

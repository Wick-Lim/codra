import React from "react";
import { TerminalPane } from "./terminal/TerminalPane";
import { TerminalSidebar } from "./terminal/TerminalSidebar";
import { useTerminals } from "./terminal/useTerminals";

export default function App() {
  const {
    terminals,
    activeTerminalId,
    activeTerminal,
    createTerminal,
    selectTerminal,
    closeTerminal,
  } = useTerminals();
  const stateLabel = activeTerminal
    ? activeTerminal.state === "running"
      ? "Running"
      : `Exited${activeTerminal.exitCode === undefined ? "" : ` ${activeTerminal.exitCode}`}`
    : "Idle";

  return (
    <React.Fragment>
      <main className="workspace-shell">
        <div className="workspace-grid">
          <TerminalSidebar
            terminals={terminals}
            activeId={activeTerminalId}
            onCreate={() => void createTerminal()}
            onSelect={selectTerminal}
            onClose={(terminalId) => void closeTerminal(terminalId)}
          />

          <section
            className="terminal-stage"
            aria-label="Active terminal workspace"
          >
            <header className="stage-header">
              <div className="stage-identity">
                <span className="stage-kicker">Active pane</span>
                <h1>{activeTerminal?.title ?? "No terminal selected"}</h1>
              </div>
              <p className="stage-cwd" title={activeTerminal?.cwd}>
                {activeTerminal?.cwd ??
                  "Create a terminal to open a local shell"}
              </p>
            </header>
            <TerminalPane terminal={activeTerminal} />
          </section>
        </div>

        <footer className="status-strip" role="status" aria-live="polite">
          <span className="status-context">
            <span className="status-prompt" aria-hidden="true">
              ▸
            </span>
            local
          </span>
          <span className="status-divider" aria-hidden="true" />
          <span>{stateLabel}</span>
          <span className="status-spacer" />
          <span>
            {activeTerminal
              ? `${activeTerminal.cols} × ${activeTerminal.rows}`
              : "— × —"}
          </span>
        </footer>
      </main>
    </React.Fragment>
  );
}

import React from "react";
import type { RemoteHostStatus } from "@codra/protocol";
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
  const [remoteStatus, setRemoteStatus] = React.useState<RemoteHostStatus>({
    state: "idle",
  });

  React.useEffect(() => {
    const stopListening = window.codra.remote.onStateChanged(setRemoteStatus);
    void window.codra.remote
      .getState()
      .then(setRemoteStatus)
      .catch(() => setRemoteStatus({ state: "error", message: "REMOTE_STATUS_UNAVAILABLE" }));
    return stopListening;
  }, []);

  async function loginRemote(): Promise<void> {
    setRemoteStatus({ state: "signing_in" });
    try {
      setRemoteStatus(await window.codra.remote.login());
    } catch {
      try {
        setRemoteStatus(await window.codra.remote.getState());
      } catch {
        setRemoteStatus({ state: "error", message: "REMOTE_LOGIN_FAILED" });
      }
    }
  }
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
            remoteStatus={remoteStatus}
            onRemoteLogin={() => void loginRemote()}
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

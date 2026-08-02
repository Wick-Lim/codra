import type { RemoteAccountStatus, TerminalDescriptor } from "@codra/protocol";
import React from "react";
import { AccountControl } from "../account/AccountControl";

void React;

export interface TerminalSidebarProps {
  terminals: readonly TerminalDescriptor[];
  activeId: string | null;
  onCreateAgent?: () => void;
  onCreateTerminal?: () => void;
  onSelect?: (terminalId: string) => void;
  onClose?: (terminalId: string) => void;
  accountStatus?: RemoteAccountStatus;
  onSignIn?: () => void;
  onOpenSettings?: () => void;
  onLogout?: () => void;
}

function cwdBasename(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? cwd;
}

export function TerminalSidebar({
  terminals,
  activeId,
  onCreateAgent,
  onCreateTerminal,
  onSelect,
  onClose,
  accountStatus = { state: "signed_out" },
  onSignIn,
  onOpenSettings,
  onLogout,
}: TerminalSidebarProps) {
  return (
    <aside className="terminal-sidebar">
      <header className="sidebar-header">
        <div>
          <p className="product-mark">CODRA</p>
          <p className="workspace-label">Operator console</p>
        </div>
        <div className="new-session-actions">
          <button
            className="new-agent-button"
            type="button"
            onClick={onCreateAgent}
          >
            <span aria-hidden="true">＋</span>
            New agent
          </button>
          <button
            className="new-terminal-icon-button"
            type="button"
            aria-label="New terminal"
            title="New terminal"
            onClick={onCreateTerminal}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <path d="M3.5 4.5h13v11h-13z" />
              <path d="m6.3 8 2 2-2 2M10.5 12h3.2" />
            </svg>
          </button>
        </div>
      </header>

      <nav
        className="terminal-registry"
        aria-label="Terminals"
        data-scroll-region="pane-registry"
      >
        <div className="registry-heading-row">
          <p className="registry-heading">CLI sessions</p>
          <span>{terminals.length}</span>
        </div>
        {terminals.length === 0 ? (
          <p className="empty-terminals">No terminals. Create one to start.</p>
        ) : (
          <ol className="terminal-list">
            {terminals.map((terminal, index) => {
              const isActive = terminal.id === activeId;
              const stateLabel =
                terminal.state === "running" ? "Running" : "Exited";
              return (
                <li
                  className="terminal-list-item"
                  data-active={isActive}
                  key={terminal.id}
                >
                  <span
                    className="session-node"
                    data-state={terminal.state}
                    data-active={isActive}
                    aria-hidden="true"
                  >
                    <span>{index === 0 ? "›_" : "·"}</span>
                  </span>
                  <button
                    className="terminal-select-button"
                    type="button"
                    aria-label={`${terminal.title}, ${cwdBasename(terminal.cwd)}, ${stateLabel}`}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelect?.(terminal.id)}
                  >
                    <span className="terminal-title">{terminal.title}</span>
                    <span className="terminal-meta">
                      <span>{cwdBasename(terminal.cwd)}</span>
                      <span className="terminal-state">
                        <span
                          className="state-indicator"
                          data-state={terminal.state}
                          aria-hidden="true"
                        />
                        {stateLabel}
                      </span>
                    </span>
                  </button>
                  <button
                    className="terminal-close-button"
                    type="button"
                    aria-label={`Close ${terminal.title}`}
                    onClick={() => onClose?.(terminal.id)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </nav>

      <footer className="sidebar-account-footer">
        <AccountControl
          accountStatus={accountStatus}
          onSignIn={() => onSignIn?.()}
          onOpenSettings={() => onOpenSettings?.()}
          onLogout={() => onLogout?.()}
        />
      </footer>
    </aside>
  );
}

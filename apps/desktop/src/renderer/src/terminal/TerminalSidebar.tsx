import type { TerminalDescriptor } from "@codra/protocol";
import React from "react";

export interface TerminalSidebarProps {
  terminals: readonly TerminalDescriptor[];
  activeId: string | null;
  onCreate?: () => void;
  onSelect?: (terminalId: string) => void;
  onClose?: (terminalId: string) => void;
}

function cwdBasename(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? cwd;
}

export function TerminalSidebar({
  terminals,
  activeId,
  onCreate,
  onSelect,
  onClose,
}: TerminalSidebarProps) {
  return (
    <React.Fragment>
      <aside className="terminal-sidebar">
        <header className="sidebar-header">
          <div>
            <p className="product-mark">CODRA</p>
            <p className="workspace-label">Local workspace</p>
          </div>
          <button
            className="new-terminal-button"
            type="button"
            onClick={onCreate}
          >
            <span aria-hidden="true">＋</span>
            New terminal
          </button>
        </header>

        <nav className="terminal-registry" aria-label="Terminals">
          <p className="registry-heading">Panes</p>
          {terminals.length === 0 ? (
            <p className="empty-terminals">
              No terminals. Create one to start.
            </p>
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
                    <span className="pane-index" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
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
      </aside>
    </React.Fragment>
  );
}

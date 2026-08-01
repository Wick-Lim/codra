import type { RemoteHostStatus, TerminalDescriptor } from "@codra/protocol";
import React from "react";

export interface TerminalSidebarProps {
  terminals: readonly TerminalDescriptor[];
  activeId: string | null;
  onCreate?: () => void;
  onSelect?: (terminalId: string) => void;
  onClose?: (terminalId: string) => void;
  remoteStatus?: RemoteHostStatus;
  onRemoteLogin?: () => void;
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
  remoteStatus = { state: "idle" },
  onRemoteLogin,
}: TerminalSidebarProps) {
  const [providerMenuOpen, setProviderMenuOpen] = React.useState(false);

  function chooseGoogle(): void {
    setProviderMenuOpen(false);
    onRemoteLogin?.();
  }

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

        <nav
          className="terminal-registry"
          aria-label="Terminals"
          data-scroll-region="pane-registry"
        >
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

        <section className="remote-panel" aria-label="Remote access">
          <div className="remote-panel-heading">
            <p className="registry-heading">Remote access</p>
            <span className="remote-state" data-state={remoteStatus.state}>
              {remoteStatus.state === "online"
                ? "Online"
                : remoteStatus.state === "signing_in"
                  ? "Signing in"
                  : remoteStatus.state === "error"
                    ? "Needs attention"
                    : "Offline"}
            </span>
          </div>
          {remoteStatus.state === "signing_in" ? (
            <p className="remote-message" role="status">
              브라우저에서 Google 로그인 중…
            </p>
          ) : remoteStatus.state === "online" ? (
            <p className="remote-message" role="status">
              원격 연결됨
            </p>
          ) : remoteStatus.state === "error" ? (
            <p className="remote-message" role="alert">
              {remoteStatus.message ?? "원격 로그인에 실패했습니다."}
            </p>
          ) : null}

          <div className="remote-account-footer">
            {providerMenuOpen ? (
              <div
                className="remote-provider-menu"
                role="menu"
                aria-label="로그인 제공자"
              >
                <button
                  className="remote-provider-button"
                  type="button"
                  role="menuitem"
                  onClick={chooseGoogle}
                >
                  <span className="remote-provider-icon" aria-hidden="true">
                    G
                  </span>
                  Google
                </button>
              </div>
            ) : null}
            <button
              className="remote-avatar-button"
              type="button"
              aria-label="로그인 계정"
              aria-expanded={providerMenuOpen}
              onClick={() => setProviderMenuOpen((open) => !open)}
            >
              <span className="remote-avatar" aria-hidden="true">
                C
              </span>
              <span className="remote-avatar-copy">
                {remoteStatus.state === "online" ? "CODRA 계정" : "로그인"}
              </span>
              <span className="remote-avatar-chevron" aria-hidden="true">
                {providerMenuOpen ? "⌃" : "⌄"}
              </span>
            </button>
          </div>
        </section>
      </aside>
    </React.Fragment>
  );
}

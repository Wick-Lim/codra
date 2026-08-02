import type {
  RemoteAccountStatus,
  RemoteAuthProvider,
  RemoteHostStatus,
  TerminalDescriptor,
} from "@codra/protocol";
import React from "react";

export interface TerminalSidebarProps {
  terminals: readonly TerminalDescriptor[];
  activeId: string | null;
  onCreate?: () => void;
  onSelect?: (terminalId: string) => void;
  onClose?: (terminalId: string) => void;
  accountStatus?: RemoteAccountStatus;
  remoteStatus?: RemoteHostStatus;
  onRemoteLogin?: (provider: RemoteAuthProvider) => void;
  onRemoteActivate?: () => void;
  onRemoteDeactivate?: () => void;
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
  accountStatus = { state: "signed_out" },
  remoteStatus = { state: "idle" },
  onRemoteLogin,
  onRemoteActivate,
  onRemoteDeactivate,
}: TerminalSidebarProps) {
  const [providerDialogOpen, setProviderDialogOpen] = React.useState(false);

  function chooseProvider(provider: RemoteAuthProvider): void {
    setProviderDialogOpen(false);
    onRemoteLogin?.(provider);
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
                : remoteStatus.state === "activating"
                  ? "Activating"
                  : remoteStatus.state === "error"
                    ? "Needs attention"
                    : "Offline"}
            </span>
          </div>
          {accountStatus.state === "signing_in" ? (
            <p className="remote-message" role="status">
              브라우저에서 Google 로그인 중…
            </p>
          ) : accountStatus.state === "error" ? (
            <p className="remote-message" role="alert">
              {accountStatus.message ?? "계정 로그인에 실패했습니다."}
            </p>
          ) : remoteStatus.state === "activating" ? (
            <p className="remote-message" role="status">
              원격 호스트 활성화 중…
            </p>
          ) : remoteStatus.state === "online" ? (
            <p className="remote-message" role="status">
              원격 연결됨
            </p>
          ) : remoteStatus.state === "error" ? (
            <p className="remote-message" role="alert">
              {remoteStatus.message ?? "원격 활성화에 실패했습니다."}
            </p>
          ) : accountStatus.state === "signed_in" ? (
            <p className="remote-message" role="status">
              이 컴퓨터를 원격 호스트로 활성화할 수 있습니다.
            </p>
          ) : null}

          {accountStatus.state === "signed_in" &&
          remoteStatus.state !== "online" &&
          remoteStatus.state !== "activating" ? (
            <button
              className="remote-action-button"
              type="button"
              onClick={onRemoteActivate}
            >
              원격 활성화
            </button>
          ) : remoteStatus.state === "online" ? (
            <button
              className="remote-action-button remote-action-button-secondary"
              type="button"
              onClick={onRemoteDeactivate}
            >
              원격 비활성화
            </button>
          ) : null}

          <div className="remote-account-footer">
            {providerDialogOpen ? (
              <div
                className="remote-provider-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="로그인 방법 선택"
              >
                <div className="remote-provider-dialog-heading">
                  <span>로그인 방법</span>
                  <button
                    className="remote-provider-dialog-close"
                    type="button"
                    aria-label="로그인 방법 닫기"
                    onClick={() => setProviderDialogOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <button
                  className="remote-provider-button"
                  type="button"
                  onClick={() => chooseProvider("google")}
                >
                  <span className="remote-provider-icon" aria-hidden="true">
                    G
                  </span>
                  <span>
                    <strong>Google</strong>
                    <small>권장 로그인</small>
                  </span>
                </button>
                <button
                  className="remote-provider-button"
                  type="button"
                  disabled
                  aria-label="이메일 및 비밀번호 테스트 전용"
                >
                  <span className="remote-provider-icon" aria-hidden="true">
                    @
                  </span>
                  <span>
                    <strong>이메일 / 비밀번호</strong>
                    <small>테스트 전용</small>
                  </span>
                </button>
              </div>
            ) : null}
            <button
              className="remote-avatar-button"
              type="button"
              aria-label="로그인 계정"
              aria-expanded={providerDialogOpen}
              onClick={() => setProviderDialogOpen((open) => !open)}
            >
              <span className="remote-avatar" aria-hidden="true">
                C
              </span>
              <span className="remote-avatar-copy">
                {accountStatus.state === "signed_in" ? "CODRA 계정" : "로그인"}
              </span>
              <span className="remote-avatar-chevron" aria-hidden="true">
                {providerDialogOpen ? "⌃" : "⌄"}
              </span>
            </button>
          </div>
        </section>
      </aside>
    </React.Fragment>
  );
}

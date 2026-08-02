import React from "react";
import type {
  AgentLaunchRequest,
  AgentRuntime,
  RemoteAccountStatus,
  RemoteAuthProvider,
  RemoteHostStatus,
} from "@codra/protocol";
import { TerminalPane } from "./terminal/TerminalPane";
import { TerminalSidebar } from "./terminal/TerminalSidebar";
import { useTerminals } from "./terminal/useTerminals";
import { SignInDialog } from "./account/SignInDialog";
import { SettingsDialog } from "./settings/SettingsDialog";
import { NewAgentDialog } from "./agent/NewAgentDialog";

export default function App() {
  const {
    terminals,
    activeTerminalId,
    activeTerminal,
    createTerminal,
    createAgent,
    selectTerminal,
    closeTerminal,
  } = useTerminals();
  const [remoteStatus, setRemoteStatus] = React.useState<RemoteHostStatus>({
    state: "idle",
  });
  const [accountStatus, setAccountStatus] = React.useState<RemoteAccountStatus>(
    { state: "signed_out" },
  );
  const [signInOpen, setSignInOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = React.useState(false);
  const [agentRuntimes, setAgentRuntimes] = React.useState<AgentRuntime[]>([]);
  const [agentStarting, setAgentStarting] = React.useState(false);
  const [agentError, setAgentError] = React.useState<string>();

  React.useEffect(() => {
    const stopListening = window.codra.remote.onStateChanged(setRemoteStatus);
    const stopListeningAccount =
      window.codra.remote.onAuthStateChanged(setAccountStatus);
    void window.codra.remote
      .getState()
      .then(setRemoteStatus)
      .catch(() =>
        setRemoteStatus({
          state: "error",
          message: "REMOTE_STATUS_UNAVAILABLE",
        }),
      );
    void window.codra.agents
      .list()
      .then(setAgentRuntimes)
      .catch(() => setAgentError("Agent CLI discovery failed."));
    void window.codra.remote
      .getAuthState()
      .then(setAccountStatus)
      .catch(() =>
        setAccountStatus({
          state: "error",
          message: "REMOTE_AUTH_UNAVAILABLE",
        }),
      );
    return () => {
      stopListening();
      stopListeningAccount();
    };
  }, []);

  function openAgentDialog(): void {
    setAgentDialogOpen(true);
    setAgentError(undefined);
    void window.codra.agents
      .list()
      .then(setAgentRuntimes)
      .catch(() => setAgentError("Agent CLI discovery failed."));
  }

  async function startAgent(request: AgentLaunchRequest): Promise<void> {
    setAgentStarting(true);
    setAgentError(undefined);
    try {
      await createAgent(request);
      setAgentDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setAgentError(
        message.includes("AGENT_CLI_NOT_FOUND")
          ? "The selected agent CLI is no longer available."
          : "The agent could not be started.",
      );
    } finally {
      setAgentStarting(false);
    }
  }

  async function loginRemote(provider: RemoteAuthProvider): Promise<void> {
    setSignInOpen(false);
    setAccountStatus({ state: "signing_in" });
    try {
      setAccountStatus(await window.codra.remote.login(provider));
    } catch {
      try {
        setAccountStatus(await window.codra.remote.getAuthState());
      } catch {
        setAccountStatus({ state: "error", message: "REMOTE_AUTH_FAILED" });
      }
    }
  }

  async function logoutRemote(): Promise<void> {
    try {
      setAccountStatus(await window.codra.remote.logout());
      setRemoteStatus({ state: "idle" });
    } catch {
      setAccountStatus({ state: "error", message: "REMOTE_LOGOUT_FAILED" });
    }
  }

  async function activateRemote(): Promise<void> {
    setRemoteStatus({ state: "activating" });
    try {
      setRemoteStatus(await window.codra.remote.activate());
    } catch {
      try {
        setRemoteStatus(await window.codra.remote.getState());
      } catch {
        setRemoteStatus({
          state: "error",
          message: "REMOTE_ACTIVATION_FAILED",
        });
      }
    }
  }

  async function deactivateRemote(): Promise<void> {
    try {
      setRemoteStatus(await window.codra.remote.deactivate());
    } catch {
      setRemoteStatus({
        state: "error",
        message: "REMOTE_DEACTIVATION_FAILED",
      });
    }
  }
  function changeRemote(enabled: boolean): void {
    if (enabled) void activateRemote();
    else void deactivateRemote();
  }

  const remoteStatusLabel =
    remoteStatus.state === "online"
      ? "online"
      : remoteStatus.state === "activating"
        ? "starting"
        : remoteStatus.state === "error"
          ? "attention"
          : "offline";
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
            onCreateAgent={openAgentDialog}
            onCreateTerminal={() => void createTerminal()}
            onSelect={selectTerminal}
            onClose={(terminalId) => void closeTerminal(terminalId)}
            accountStatus={accountStatus}
            onSignIn={() => setSignInOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onLogout={() => void logoutRemote()}
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
          <button
            className="status-remote-button"
            type="button"
            data-state={remoteStatus.state}
            aria-label={`Remote ${remoteStatusLabel} — open settings`}
            onClick={() => setSettingsOpen(true)}
          >
            <span className="status-remote-dot" aria-hidden="true" />
            Remote {remoteStatusLabel}
          </button>
          <span className="status-divider" aria-hidden="true" />
          <span>
            {activeTerminal
              ? `${activeTerminal.cols} × ${activeTerminal.rows}`
              : "— × —"}
          </span>
        </footer>
      </main>
      <SignInDialog
        open={signInOpen}
        busy={accountStatus.state === "signing_in"}
        message={
          accountStatus.state === "error" ? accountStatus.message : undefined
        }
        onClose={() => setSignInOpen(false)}
        onProvider={(provider) => void loginRemote(provider)}
      />
      <NewAgentDialog
        open={agentDialogOpen}
        agents={agentRuntimes}
        busy={agentStarting}
        error={agentError}
        onClose={() => {
          if (!agentStarting) setAgentDialogOpen(false);
        }}
        onStart={(request) => void startAgent(request)}
      />
      <SettingsDialog
        open={settingsOpen}
        accountStatus={accountStatus}
        remoteStatus={remoteStatus}
        onClose={() => setSettingsOpen(false)}
        onRemoteChange={changeRemote}
        onSignIn={() => {
          setSettingsOpen(false);
          setSignInOpen(true);
        }}
      />
    </React.Fragment>
  );
}

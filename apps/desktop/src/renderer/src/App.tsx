import React from "react";
import type {
  AgentLaunchRequest,
  AgentRuntime,
  AgentSetupRequest,
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
    defaultCwd,
    createTerminal,
    createAgent,
    setupAgent,
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
  const [settingsSection, setSettingsSection] = React.useState<
    "remote" | "agents"
  >("remote");
  const [agentDialogOpen, setAgentDialogOpen] = React.useState(false);
  const [agentRuntimes, setAgentRuntimes] = React.useState<AgentRuntime[]>([]);
  const [agentStarting, setAgentStarting] = React.useState(false);
  const [agentError, setAgentError] = React.useState<string>();
  const [agentDiscoveryError, setAgentDiscoveryError] =
    React.useState<string>();
  const [agentSetupError, setAgentSetupError] = React.useState<string>();
  const [agentSetupKind, setAgentSetupKind] =
    React.useState<AgentSetupRequest["kind"]>();
  const [agentSetupTerminalId, setAgentSetupTerminalId] =
    React.useState<string>();

  const refreshAgentRuntimes = React.useCallback(async () => {
    try {
      setAgentRuntimes(await window.codra.agents.list());
      setAgentDiscoveryError(undefined);
    } catch {
      setAgentDiscoveryError("Agent CLI discovery failed.");
    }
  }, []);

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
    void refreshAgentRuntimes();
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
  }, [refreshAgentRuntimes]);

  React.useEffect(() => {
    if (!agentSetupTerminalId) return;
    const setupTerminal = terminals.find(
      ({ id }) => id === agentSetupTerminalId,
    );
    if (setupTerminal?.state !== "exited") return;
    setAgentSetupTerminalId(undefined);
    setAgentSetupKind(undefined);
    void refreshAgentRuntimes();
  }, [agentSetupTerminalId, refreshAgentRuntimes, terminals]);

  function openAgentDialog(): void {
    setAgentDialogOpen(true);
    setAgentError(undefined);
    void refreshAgentRuntimes();
  }

  function openSettings(section: "remote" | "agents"): void {
    setSettingsSection(section);
    setSettingsOpen(true);
    if (section === "agents") {
      setAgentDialogOpen(false);
      setAgentSetupError(undefined);
      void refreshAgentRuntimes();
    }
  }

  async function startAgent(
    request: AgentLaunchRequest,
    cwd: string,
  ): Promise<void> {
    setAgentStarting(true);
    setAgentError(undefined);
    try {
      await createAgent(request, cwd);
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

  async function startAgentSetup(request: AgentSetupRequest): Promise<void> {
    setAgentSetupKind(request.kind);
    setAgentSetupError(undefined);
    try {
      const result = await setupAgent(request);
      if (result.kind === "terminal") {
        setAgentSetupTerminalId(result.terminal.id);
        setSettingsOpen(false);
      } else {
        setAgentSetupKind(undefined);
        await refreshAgentRuntimes();
      }
    } catch (error) {
      setAgentSetupKind(undefined);
      const message = error instanceof Error ? error.message : "";
      setAgentSetupError(
        message.includes("AGENT_SETUP_IN_PROGRESS")
          ? "This runtime already has an active setup terminal."
          : "The runtime setup session could not be opened.",
      );
    }
  }

  async function closeWorkspaceTerminal(terminalId: string): Promise<void> {
    await closeTerminal(terminalId);
    if (terminalId === agentSetupTerminalId) {
      setAgentSetupTerminalId(undefined);
      setAgentSetupKind(undefined);
      void refreshAgentRuntimes();
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
            onClose={(terminalId) => void closeWorkspaceTerminal(terminalId)}
            accountStatus={accountStatus}
            onSignIn={() => setSignInOpen(true)}
            onOpenSettings={() => openSettings("remote")}
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
            onClick={() => openSettings("remote")}
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
        initialCwd={activeTerminal?.cwd ?? defaultCwd}
        busy={agentStarting}
        error={agentError ?? agentDiscoveryError}
        onClose={() => {
          if (!agentStarting) setAgentDialogOpen(false);
        }}
        onStart={(request, cwd) => void startAgent(request, cwd)}
        onOpenAgentSettings={() => openSettings("agents")}
      />
      <SettingsDialog
        open={settingsOpen}
        initialSection={settingsSection}
        runtimes={agentRuntimes}
        setupKind={agentSetupKind}
        agentError={agentSetupError ?? agentDiscoveryError}
        accountStatus={accountStatus}
        remoteStatus={remoteStatus}
        onClose={() => setSettingsOpen(false)}
        onRemoteChange={changeRemote}
        onSignIn={() => {
          setSettingsOpen(false);
          setSignInOpen(true);
        }}
        onAgentSetup={(request) => void startAgentSetup(request)}
      />
    </React.Fragment>
  );
}

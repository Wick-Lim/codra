import React from "react";
import type {
  AgentExecutionTarget,
  AgentLaunchRequest,
  AgentLaunchTarget,
  AgentRuntime,
  AgentSetupRequest,
  PendingRemoteSession,
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
import { SessionApprovalDialog } from "./remote/SessionApprovalDialog";

export default function App() {
  const {
    terminals,
    activeTerminalId,
    activeTerminal,
    defaultCwd,
    chooseCwd,
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
  const [pendingSessions, setPendingSessions] = React.useState<
    PendingRemoteSession[]
  >([]);
  const [approvalBusy, setApprovalBusy] = React.useState(false);
  const [approvalError, setApprovalError] = React.useState<string>();
  const [signInOpen, setSignInOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsSection, setSettingsSection] = React.useState<
    "remote" | "agents"
  >("remote");
  const [agentDialogOpen, setAgentDialogOpen] = React.useState(false);
  const [agentRuntimes, setAgentRuntimes] = React.useState<AgentRuntime[]>([]);
  const [agentTargets, setAgentTargets] = React.useState<AgentLaunchTarget[]>([
    { target: { kind: "local" }, state: "connected" },
  ]);
  const [agentStarting, setAgentStarting] = React.useState(false);
  const [agentError, setAgentError] = React.useState<string>();
  const [agentDiscoveryError, setAgentDiscoveryError] =
    React.useState<string>();
  const [agentSetupError, setAgentSetupError] = React.useState<string>();
  const [agentSetupKind, setAgentSetupKind] =
    React.useState<AgentSetupRequest["kind"]>();
  const [agentSetupTerminalId, setAgentSetupTerminalId] =
    React.useState<string>();
  const agentTargetGeneration = React.useRef(0);

  const refreshAgentRuntimes = React.useCallback(async () => {
    try {
      setAgentRuntimes(await window.codra.agents.list());
      setAgentDiscoveryError(undefined);
    } catch {
      setAgentDiscoveryError("Agent CLI discovery failed.");
    }
  }, []);

  const refreshAgentTargets = React.useCallback(async () => {
    try {
      setAgentTargets(await window.codra.agents.targets());
    } catch {
      setAgentTargets([{ target: { kind: "local" }, state: "connected" }]);
    }
  }, []);

  const remoteWorkspaceRoots = React.useCallback(
    (target: Extract<AgentExecutionTarget, { kind: "remote" }>) =>
      window.codra.agents.workspaceRoots(target),
    [],
  );
  const remoteWorkspaceList = React.useCallback(
    (target: Extract<AgentExecutionTarget, { kind: "remote" }>, path: string) =>
      window.codra.agents.workspaceList(target, path),
    [],
  );
  const remoteWorkspaceValidate = React.useCallback(
    (target: Extract<AgentExecutionTarget, { kind: "remote" }>, path: string) =>
      window.codra.agents.workspaceValidate(target, path),
    [],
  );

  React.useEffect(() => {
    const stopListening = window.codra.remote.onStateChanged(setRemoteStatus);
    const stopListeningAccount =
      window.codra.remote.onAuthStateChanged(setAccountStatus);
    const stopListeningTargets =
      window.codra.agents.onTargetsChanged(setAgentTargets);
    let pendingPushReceived = false;
    const stopListeningPending = window.codra.remote.onPendingSessionsChanged(
      (sessions) => {
        pendingPushReceived = true;
        setPendingSessions(sessions);
      },
    );
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
    void window.codra.remote
      .getPendingSessions()
      .then((sessions) => {
        if (!pendingPushReceived) setPendingSessions(sessions);
      })
      .catch(() => {
        if (!pendingPushReceived) setPendingSessions([]);
      });
    return () => {
      stopListening();
      stopListeningAccount();
      stopListeningTargets();
      stopListeningPending();
    };
  }, [refreshAgentRuntimes, refreshAgentTargets]);

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
    void refreshAgentTargets();
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
    target: AgentExecutionTarget,
  ): Promise<void> {
    setAgentStarting(true);
    setAgentError(undefined);
    try {
      await createAgent(request, cwd, target);
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

  async function changeAgentTarget(
    requested: AgentLaunchTarget,
  ): Promise<void> {
    const generation = ++agentTargetGeneration.current;
    setAgentError(undefined);
    try {
      const connected =
        requested.target.kind === "remote" && requested.state !== "connected"
          ? await window.codra.agents.connectTarget(requested.target)
          : requested;
      if (generation !== agentTargetGeneration.current) return;
      setAgentTargets((current) =>
        current.map((candidate) =>
          candidate.target.kind === "remote" &&
          connected.target.kind === "remote" &&
          candidate.target.deviceId === connected.target.deviceId
            ? connected
            : candidate,
        ),
      );
      const runtimes = await window.codra.agents.listForTarget(
        connected.target,
      );
      if (generation === agentTargetGeneration.current) {
        setAgentRuntimes(runtimes);
      }
    } catch (error) {
      if (generation !== agentTargetGeneration.current) return;
      setAgentError("The selected device could not be connected.");
      throw error;
    }
  }

  async function chooseAgentCwd(currentCwd: string): Promise<string | null> {
    try {
      const selectedCwd = await chooseCwd(currentCwd);
      setAgentError(undefined);
      return selectedCwd;
    } catch {
      setAgentError("The working directory picker could not be opened.");
      return null;
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

  async function approveSession(
    sessionId: string,
    approvedScopes: string[],
  ): Promise<void> {
    setApprovalBusy(true);
    setApprovalError(undefined);
    try {
      await window.codra.remote.approveSession({ sessionId, approvedScopes });
      setPendingSessions((current) =>
        current.filter((session) => session.sessionId !== sessionId),
      );
    } catch {
      setApprovalError("The remote connection could not be approved.");
    } finally {
      setApprovalBusy(false);
    }
  }

  async function denySession(sessionId: string): Promise<void> {
    setApprovalBusy(true);
    setApprovalError(undefined);
    try {
      await window.codra.remote.rejectSession({ sessionId });
      setPendingSessions((current) =>
        current.filter((session) => session.sessionId !== sessionId),
      );
    } catch {
      setApprovalError("The remote connection could not be denied.");
    } finally {
      setApprovalBusy(false);
    }
  }

  const pendingSession = pendingSessions.at(0);

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
        open={signInOpen && !pendingSession}
        busy={accountStatus.state === "signing_in"}
        message={
          accountStatus.state === "error" ? accountStatus.message : undefined
        }
        onClose={() => setSignInOpen(false)}
        onProvider={(provider) => void loginRemote(provider)}
      />
      <NewAgentDialog
        open={agentDialogOpen && !pendingSession}
        agents={agentRuntimes}
        targets={agentTargets}
        initialCwd={activeTerminal?.cwd ?? defaultCwd}
        busy={agentStarting}
        error={agentError ?? agentDiscoveryError}
        onClose={() => {
          if (!agentStarting) setAgentDialogOpen(false);
        }}
        onStart={(request, cwd, target) =>
          void startAgent(request, cwd, target)
        }
        onChooseCwd={chooseAgentCwd}
        onTargetChange={changeAgentTarget}
        workspaceRoots={remoteWorkspaceRoots}
        workspaceList={remoteWorkspaceList}
        workspaceValidate={remoteWorkspaceValidate}
        onOpenAgentSettings={() => openSettings("agents")}
      />
      <SettingsDialog
        open={settingsOpen && !pendingSession}
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
      {pendingSession ? (
        <SessionApprovalDialog
          session={pendingSession}
          busy={approvalBusy}
          error={approvalError}
          onApprove={(approvedScopes) =>
            void approveSession(pendingSession.sessionId, approvedScopes)
          }
          onDeny={() => void denySession(pendingSession.sessionId)}
        />
      ) : null}
    </React.Fragment>
  );
}

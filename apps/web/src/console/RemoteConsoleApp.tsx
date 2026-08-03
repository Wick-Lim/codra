import { useEffect, useMemo, useState, type ReactElement } from "react";
import { subscribeClientSessions } from "@codra/firebase";
import type {
  AgentLaunchRequest,
  AgentLaunchTargetState,
  AgentRuntime,
  RemoteDevice,
  RemoteSession,
  TerminalDescriptor,
  WorkspaceSelection,
} from "@codra/protocol";
import { webAccountBootstrap } from "@codra/web-account-bootstrap";
import {
  BrowserRemoteController,
  type BrowserRemoteState,
} from "../remote/controller";
import { BrowserPeerConnector } from "../remote/browser-peer-connector";
import { ConsoleTerminalSession } from "./console-session";
import { WorkspacePicker } from "./WorkspacePicker";
import { RuntimePicker } from "./RuntimePicker";
import { WebTerminalPane } from "./WebTerminalPane";
import { t } from "../i18n/messages";

// Console copy, in the default locale. See `src/i18n/messages.ts`.
const copy = t.console;

function LoginScreen({
  busy,
  message,
  onLogin,
}: {
  busy: boolean;
  message: string;
  onLogin: () => void;
}): ReactElement {
  const testOnly = webAccountBootstrap === "password-test-only";
  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-mark">{copy.brandMark}</div>
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1 id="login-title">{copy.signIn.title}</h1>
        <p className="muted">{copy.signIn.lead}</p>
        <button
          className="primary-button login-button"
          onClick={onLogin}
          disabled={busy}
        >
          {busy
            ? copy.signIn.busy
            : testOnly
              ? copy.signIn.testOnly
              : copy.signIn.google}
        </button>
        <p className="login-hint">
          {testOnly ? copy.signIn.hintTestOnly : copy.signIn.hintGoogle}
        </p>
        <p className="message" role="alert">
          {message}
        </p>
      </section>
    </main>
  );
}

function sessionLabel(session: RemoteSession): string {
  if (session.status === "requested") return copy.session.requested;
  if (session.status === "approved" || session.status === "signaling")
    return copy.session.ready;
  if (session.status === "connected") return copy.session.connected;
  if (session.status === "failed")
    return copy.session.failed(session.failureCode ?? "INTERNAL_ERROR");
  return session.status;
}

/**
 * The signed-in remote console.
 *
 * Lives in its own module so `App.tsx` can reach it through `React.lazy`. The
 * import chain below is what makes that necessary: `../remote/controller` pulls
 * in `firebase/auth` and `@codra/firebase` (Firestore), which together are
 * roughly two thirds of the bundle. A visitor to the public landing page must
 * not pay for any of it.
 */
function RemoteConsoleApp(): ReactElement {
  const controller = useMemo(() => new BrowserRemoteController(), []);
  const [state, setState] = useState<BrowserRemoteState>();
  const [hosts, setHosts] = useState<RemoteDevice[]>([]);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(copy.status.initial);

  // Steps 3 to 7 of the flow. `connector` is kept only so the peer connection
  // can be torn down; `channel` is what every operation below goes through.
  const [connector, setConnector] = useState<BrowserPeerConnector>();
  const [channel, setChannel] = useState<ConsoleTerminalSession>();
  const [workspace, setWorkspace] = useState<WorkspaceSelection>();
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>([]);
  const [terminal, setTerminal] = useState<TerminalDescriptor | null>(null);

  // A peer connection outlives React's render loop, so an unmount that left it
  // open would keep a WebRTC session and its Firestore signal subscription
  // alive with nothing to receive them.
  useEffect(() => () => connector?.close(), [connector]);

  // The host reports a terminal's exit through `terminal.changed`, which the
  // router turns into a descriptor change. Without this the pane would keep
  // rendering an exited agent as running.
  useEffect(() => {
    if (!channel) return;
    return channel.router.onChanged((descriptor) =>
      setTerminal((current) =>
        current && current.id === descriptor.id ? descriptor : current,
      ),
    );
  }, [channel]);

  useEffect(() => {
    if (!state) return;
    const unsubscribe = subscribeClientSessions({
      firestore: state.runtime.firestore,
      uid: state.device.ownerUid,
      deviceId: state.device.deviceId,
      keyThumbprint: state.device.keyThumbprint,
      generation: state.device.generation,
      onChange: setSessions,
      onError: (error) => setMessage(error.message),
    });
    return unsubscribe;
  }, [state]);

  async function connect(): Promise<void> {
    setBusy(true);
    try {
      const connected = await controller.connect();
      setState(connected);
      setHosts(await controller.listHosts());
      setMessage(copy.status.hostsLoaded);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : copy.status.signInFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Steps 2 and 3: request the session with the scopes `controller.ts:52-60`
   * fixes, wait for the host user to approve it in the desktop modal, then
   * negotiate and hand shake.
   */
  async function request(host: RemoteDevice): Promise<void> {
    if (!state || busy) return;
    setBusy(true);
    try {
      const requested = await controller.requestSession(host);
      const peer = new BrowserPeerConnector({
        runtime: state.runtime,
        identity: state.identity,
        device: state.device,
        reportError: (error) =>
          setMessage(
            error instanceof Error ? error.message : copy.flow.connectFailed,
          ),
      });
      setConnector(peer);
      const client = await peer.connect(
        host,
        requested,
        (progress: AgentLaunchTargetState) => {
          if (progress === "waiting_for_approval") {
            setMessage(copy.status.requestSent(host.displayName));
          } else if (progress === "connecting") {
            setMessage(copy.flow.connecting);
          }
        },
      );
      client.onDisconnected(() => {
        setChannel(undefined);
        setTerminal(null);
        setRuntimes([]);
        setWorkspace(undefined);
        setMessage(copy.flow.disconnected);
      });
      setChannel(new ConsoleTerminalSession({ client, host }));
      setMessage(copy.flow.connected);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : copy.flow.connectFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  /** Step 4 has produced a validated workspace; step 5 fills the picker. */
  async function chooseWorkspace(selection: WorkspaceSelection): Promise<void> {
    if (!channel) return;
    setWorkspace(selection);
    setBusy(true);
    setMessage(copy.flow.workspaceChosen);
    try {
      setRuntimes(await channel.runtimes());
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : copy.flow.runtimesFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  /** Step 6. The host auto-attaches; the router already holds the frames. */
  async function launch(agent: AgentLaunchRequest): Promise<void> {
    if (!channel || !workspace) return;
    setBusy(true);
    setMessage(copy.flow.launching);
    try {
      const descriptor = await channel.launch(workspace.path, agent);
      setTerminal(descriptor);
      setMessage(copy.flow.launched(descriptor.title));
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : copy.flow.launchFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  async function endSession(): Promise<void> {
    const closing = channel;
    setChannel(undefined);
    setConnector(undefined);
    setWorkspace(undefined);
    setRuntimes([]);
    setTerminal(null);
    setMessage(copy.flow.disconnected);
    await closing?.close();
  }

  async function logout(): Promise<void> {
    setBusy(true);
    try {
      await endSession();
      await controller.signOut();
      setState(undefined);
      setHosts([]);
      setSessions([]);
      setMessage(copy.status.signedOut);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : copy.status.signOutFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <LoginScreen
        busy={busy}
        message={message}
        onLogin={() => void connect()}
      />
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.header.title}</h1>
        </div>
        <div className="account-actions">
          <div className="status-pill">
            <span className="status-dot" />
            {copy.header.accountConnected}
          </div>
          <div className="account-menu">
            <span>
              {state.account.email ??
                state.account.displayName ??
                copy.header.accountFallback}
            </span>
            <button
              className="text-button"
              onClick={() => void logout()}
              disabled={busy}
            >
              {copy.header.signOut}
            </button>
          </div>
        </div>
      </header>

      <section className="hero-card">
        <div>
          <p className="card-kicker">{copy.hero.kicker}</p>
          <h2>{copy.hero.title}</h2>
          <p className="muted">{copy.hero.body}</p>
        </div>
        {channel ? (
          <button
            className="secondary-button"
            onClick={() => void endSession()}
            disabled={busy}
          >
            {copy.flow.disconnect}
          </button>
        ) : (
          <button
            className="primary-button"
            onClick={() => void connect()}
            disabled={busy}
          >
            {busy ? copy.hero.refreshBusy : copy.hero.refresh}
          </button>
        )}
      </section>

      {channel ? (
        <section className="console-stage">
          {terminal ? (
            // The router, not the channel client: it owns the frame queue and
            // the acknowledgement cursor, and nothing else may touch either.
            <WebTerminalPane terminal={terminal} port={channel.router} />
          ) : workspace ? (
            <>
              <RuntimePicker
                runtimes={runtimes}
                busy={busy}
                onLaunch={(agent) => void launch(agent)}
              />
              <button
                className="text-button"
                onClick={() => {
                  setWorkspace(undefined);
                  setRuntimes([]);
                }}
                disabled={busy}
              >
                {copy.flow.back}
              </button>
            </>
          ) : (
            <WorkspacePicker
              roots={() => channel.workspaceRoots()}
              list={(path) => channel.workspaceList(path)}
              validate={(path) => channel.workspaceValidate(path)}
              onSelect={(selection) => void chooseWorkspace(selection)}
              disabled={busy}
            />
          )}
        </section>
      ) : (
        <section className="content-grid">
          <div className="panel">
            <div className="panel-heading">
              <div>
                <p className="card-kicker">{copy.hosts.kicker}</p>
                <h3>{copy.hosts.title}</h3>
              </div>
              <span className="count">{hosts.length}</span>
            </div>
            {hosts.length === 0 ? (
              <div className="empty">
                {copy.hosts.emptyTitle}
                <br />
                {copy.hosts.emptyBody}
              </div>
            ) : (
              <div className="host-list">
                {hosts.map((host) => (
                  <article className="host-row" key={host.deviceId}>
                    <div className="host-icon">⌘</div>
                    <div className="host-info">
                      <strong>{host.displayName}</strong>
                      <span>{host.capabilities.join(" · ")}</span>
                    </div>
                    <button
                      className="secondary-button"
                      onClick={() => void request(host)}
                      disabled={busy}
                    >
                      {copy.hosts.request}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
          <div className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <p className="card-kicker">{copy.sessions.kicker}</p>
                <h3>{copy.sessions.title}</h3>
              </div>
              <span className="count">{sessions.length}</span>
            </div>
            {sessions.length === 0 ? (
              <div className="empty">{copy.sessions.empty}</div>
            ) : (
              <div className="session-list">
                {sessions.map((session) => (
                  <div className="session-row" key={session.sessionId}>
                    <div>
                      <strong>{session.hostDeviceId.slice(0, 8)}…</strong>
                      <span>
                        {new Date(session.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <span className="session-status">
                      {sessionLabel(session)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
      <p className="message" role="status">
        {message}
      </p>
    </main>
  );
}

export default RemoteConsoleApp;

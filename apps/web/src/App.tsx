import { useEffect, useMemo, useState, type ReactElement } from "react";
import { subscribeClientSessions } from "@codra/firebase";
import type { RemoteDevice, RemoteSession } from "@codra/protocol";
import { webAccountBootstrap } from "@codra/web-account-bootstrap";
import {
  BrowserRemoteController,
  type BrowserRemoteState,
} from "./remote/controller";
import DesktopAuthBridge from "./remote/DesktopAuthBridge";
import "./styles.css";

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
        <div className="brand-mark">C</div>
        <p className="eyebrow">CODRA / REMOTE CONSOLE</p>
        <h1 id="login-title">내 터미널에 안전하게 접속하세요.</h1>
        <p className="muted">
          로그인하면 같은 계정으로 등록된 CODRA 데스크톱 호스트를 확인하고,
          승인된 연결만 WebRTC로 시작할 수 있습니다.
        </p>
        <button
          className="primary-button login-button"
          onClick={onLogin}
          disabled={busy}
        >
          {busy
            ? "로그인 중…"
            : testOnly
              ? "테스트 계정으로 로그인"
              : "Google로 로그인"}
        </button>
        <p className="login-hint">
          {testOnly
            ? "이 빌드는 로컬 Firebase Emulator 전용입니다."
            : "Google 계정으로 로그인하며 비밀번호는 CODRA가 보관하지 않습니다."}
        </p>
        <p className="message" role="alert">
          {message}
        </p>
      </section>
    </main>
  );
}

function sessionLabel(session: RemoteSession): string {
  if (session.status === "requested") return "승인 대기 중";
  if (session.status === "approved" || session.status === "signaling")
    return "연결 준비됨";
  if (session.status === "connected") return "연결됨";
  if (session.status === "failed")
    return `실패: ${session.failureCode ?? "INTERNAL_ERROR"}`;
  return session.status;
}

function RemoteConsoleApp(): ReactElement {
  const controller = useMemo(() => new BrowserRemoteController(), []);
  const [path, setPath] = useState(() => window.location.pathname);
  const [state, setState] = useState<BrowserRemoteState>();
  const [hosts, setHosts] = useState<RemoteDevice[]>([]);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "로그인하면 같은 계정의 CODRA 호스트를 찾습니다.",
  );

  useEffect(() => {
    const onPopState = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (state || path === "/login") return;
    window.history.replaceState({}, "", "/login");
    setPath("/login");
  }, [path, state]);

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
      setMessage("호스트 목록을 불러왔습니다.");
      window.history.replaceState({}, "", "/");
      setPath("/");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "로그인에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function request(host: RemoteDevice): Promise<void> {
    setBusy(true);
    try {
      await controller.requestSession(host);
      setMessage(
        `${host.displayName}에 연결 요청을 보냈습니다. 데스크톱에서 승인해 주세요.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "연결 요청에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function logout(): Promise<void> {
    setBusy(true);
    try {
      await controller.signOut();
      setState(undefined);
      setHosts([]);
      setSessions([]);
      setMessage("로그아웃했습니다.");
      window.history.replaceState({}, "", "/login");
      setPath("/login");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "로그아웃에 실패했습니다.",
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
          <p className="eyebrow">CODRA / REMOTE CONSOLE</p>
          <h1>작업 중인 터미널에 안전하게 접속하세요.</h1>
        </div>
        <div className="account-actions">
          <div className="status-pill">
            <span className="status-dot" />
            계정 연결됨
          </div>
          <div className="account-menu">
            <span>
              {state.account.email ?? state.account.displayName ?? "CODRA 계정"}
            </span>
            <button
              className="text-button"
              onClick={() => void logout()}
              disabled={busy}
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>

      <section className="hero-card">
        <div>
          <p className="card-kicker">FIREBASE CONTROL PLANE</p>
          <h2>내 호스트를 선택하고, 데스크톱에서 승인합니다.</h2>
          <p className="muted">
            터미널 데이터는 Firebase에 저장하지 않습니다. 연결이 승인되면 WebRTC
            데이터 채널로 직접 전달됩니다.
          </p>
        </div>
        <button
          className="primary-button"
          onClick={() => void connect()}
          disabled={busy}
        >
          {busy ? "처리 중…" : "호스트 새로고침"}
        </button>
      </section>

      <section className="content-grid">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <p className="card-kicker">AVAILABLE HOSTS</p>
              <h3>내 호스트</h3>
            </div>
            <span className="count">{hosts.length}</span>
          </div>
          {hosts.length === 0 ? (
            <div className="empty">
              온라인 상태인 호스트가 없습니다.
              <br />
              CODRA 데스크톱을 켜고 원격 모드를 활성화해 주세요.
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
                    연결 요청
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
        <div className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <p className="card-kicker">SESSION ACTIVITY</p>
              <h3>연결 상태</h3>
            </div>
            <span className="count">{sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="empty">아직 요청한 세션이 없습니다.</div>
          ) : (
            <div className="session-list">
              {sessions.map((session) => (
                <div className="session-row" key={session.sessionId}>
                  <div>
                    <strong>{session.hostDeviceId.slice(0, 8)}…</strong>
                    <span>{new Date(session.createdAt).toLocaleString()}</span>
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
      <p className="message" role="status">
        {message}
      </p>
    </main>
  );
}

function App(): ReactElement {
  if (window.location.pathname === "/desktop-auth")
    return <DesktopAuthBridge />;
  return <RemoteConsoleApp />;
}

export default App;

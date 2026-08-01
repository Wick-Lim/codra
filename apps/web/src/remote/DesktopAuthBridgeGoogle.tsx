import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  GoogleAuthProvider,
  getRedirectResult,
  signInWithRedirect,
  signOut,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import {
  DesktopLoginAllowResponseSchema,
  DesktopLoginInspectResponseSchema,
} from "@codra/protocol";
import { bridgeAuth, bridgeFunctions } from "./firebase-bridge";
import {
  createDesktopCallbackNavigation,
  parseDesktopAuthQuery,
  type DesktopAuthQuery,
} from "./desktop-auth-contract";

export { createDesktopCallbackNavigation, parseDesktopAuthQuery } from "./desktop-auth-contract";

const REDIRECT_STATE_KEY = "codra.desktop-auth.redirect.v1";
const REDIRECT_MAX_AGE_MS = 5 * 60 * 1000;

interface RedirectState extends DesktopAuthQuery {
  createdAt: number;
}

function clearRedirectState(): void {
  sessionStorage.removeItem(REDIRECT_STATE_KEY);
}

function readRedirectState(): RedirectState | undefined {
  const raw = sessionStorage.getItem(REDIRECT_STATE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.attempt !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.createdAt !== "number" ||
      !Number.isSafeInteger(parsed.createdAt) ||
      !parseDesktopAuthQuery(`?attempt=${parsed.attempt}&state=${parsed.state}`)
    ) {
      return undefined;
    }
    return {
      attempt: parsed.attempt,
      state: parsed.state,
      createdAt: parsed.createdAt,
    };
  } catch {
    return undefined;
  }
}

function actionLabel(action: "register" | "resume" | "reenable"): string {
  if (action === "register") return "새 호스트 등록";
  if (action === "reenable") return "호스트 다시 활성화";
  return "기존 호스트 다시 연결";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "DESKTOP_AUTH_FAILED";
}

export interface DesktopAuthBridgeGoogleProps {
  onNavigate?: (url: string) => void;
}

export default function DesktopAuthBridgeGoogle({
  onNavigate = (url) => window.location.replace(url),
}: DesktopAuthBridgeGoogleProps = {}): ReactElement {
  const query = parseDesktopAuthQuery(window.location.search);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [inspection, setInspection] = useState<
    | {
        attemptId: string;
        action: "register" | "resume" | "reenable";
        displayName: string;
        fingerprintSuffix: string;
      }
    | undefined
  >();
  const callbackNavigated = useRef(false);

  useEffect(() => {
    let active = true;
    const fail = async (error: unknown): Promise<void> => {
      clearRedirectState();
      await signOut(bridgeAuth).catch(() => undefined);
      if (active) {
        setInspection(undefined);
        setMessage(errorMessage(error));
        setBusy(false);
      }
    };
    const inspect = async (): Promise<void> => {
      if (!query) {
        await fail(new Error("DESKTOP_AUTH_QUERY_INVALID"));
        return;
      }
      const redirectResult = await getRedirectResult(bridgeAuth);
      if (!redirectResult) {
        if (active) {
          setMessage("");
          setBusy(false);
        }
        return;
      }
      const saved = readRedirectState();
      if (
        !saved ||
        saved.attempt !== query.attempt ||
        saved.state !== query.state ||
        Date.now() - saved.createdAt > REDIRECT_MAX_AGE_MS ||
        Date.now() < saved.createdAt
      ) {
        await fail(new Error("DESKTOP_AUTH_REDIRECT_STATE_INVALID"));
        return;
      }
      const googleAccount = redirectResult.user.providerData.some(
        (provider) => provider.providerId === "google.com",
      );
      if (!googleAccount) {
        await fail(new Error("GOOGLE_ACCOUNT_REQUIRED"));
        return;
      }
      try {
        const authorize = httpsCallable(bridgeFunctions, "authorizeDesktopLogin");
        const response = DesktopLoginInspectResponseSchema.parse(
          (await authorize({
            action: "inspect",
            attemptId: query.attempt,
            state: query.state,
          })).data,
        );
        if (response.attemptId !== query.attempt) throw new Error("DESKTOP_AUTH_ATTEMPT_INVALID");
        if (active) {
          setInspection(response);
          setMessage("");
          setBusy(false);
        }
      } catch (error) {
        await fail(error);
      }
    };
    void inspect().catch(fail);
    return () => {
      active = false;
    };
  }, [query?.attempt, query?.state]);

  async function startGoogleSignIn(): Promise<void> {
    if (!query) return;
    setBusy(true);
    setMessage("");
    sessionStorage.setItem(
      REDIRECT_STATE_KEY,
      JSON.stringify({
        attempt: query.attempt,
        state: query.state,
        createdAt: Date.now(),
      }),
    );
    try {
      await signInWithRedirect(bridgeAuth, new GoogleAuthProvider());
    } catch (error) {
      clearRedirectState();
      await signOut(bridgeAuth).catch(() => undefined);
      setMessage(errorMessage(error));
      setBusy(false);
    }
  }

  async function allow(): Promise<void> {
    if (!query || !inspection || callbackNavigated.current) return;
    setBusy(true);
    setMessage("");
    try {
      const authorize = httpsCallable(bridgeFunctions, "authorizeDesktopLogin");
      const response = DesktopLoginAllowResponseSchema.parse(
        (await authorize({
          action: "allow",
          attemptId: query.attempt,
          state: query.state,
        })).data,
      );
      if (response.attemptId !== query.attempt || response.state !== query.state)
        throw new Error("DESKTOP_AUTH_ALLOW_RESPONSE_INVALID");
      const navigation = createDesktopCallbackNavigation(response.callbackUrl, {
        attempt: response.attemptId,
        code: response.code,
        state: response.state,
      });
      callbackNavigated.current = true;
      clearRedirectState();
      await signOut(bridgeAuth);
      onNavigate(navigation);
    } catch (error) {
      clearRedirectState();
      await signOut(bridgeAuth).catch(() => undefined);
      setInspection(undefined);
      setMessage(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="desktop-auth-title">
        <div className="brand-mark">C</div>
        <p className="eyebrow">CODRA / DESKTOP AUTHORIZATION</p>
        <h1 id="desktop-auth-title">데스크톱 호스트 연결</h1>
        {!query ? (
          <p className="message" role="alert">
            이 로그인 요청은 유효하지 않습니다. CODRA 데스크톱에서 다시 시작해 주세요.
          </p>
        ) : inspection ? (
          <>
            <p className="muted">
              <strong>{inspection.displayName}</strong> ({inspection.fingerprintSuffix})을
              {" "}{actionLabel(inspection.action)}합니다.
            </p>
            <button className="primary-button login-button" onClick={() => void allow()} disabled={busy}>
              {busy ? "승인 중…" : "이 호스트 허용"}
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              Google 계정으로 로그인한 뒤, 요청된 데스크톱 호스트를 확인하고 허용하세요.
            </p>
            <button className="primary-button login-button" onClick={() => void startGoogleSignIn()} disabled={busy}>
              {busy ? "확인 중…" : "Google로 계속"}
            </button>
          </>
        )}
        {message ? (
          <p className="message" role="alert">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}

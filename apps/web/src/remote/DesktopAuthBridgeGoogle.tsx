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
import { t } from "../i18n/messages";

// Authorization copy, in the default locale. See `src/i18n/messages.ts`.
const copy = t.desktopAuth;

export {
  createDesktopCallbackNavigation,
  parseDesktopAuthQuery,
} from "./desktop-auth-contract";

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

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("auth/api-key-not-valid") ||
    message.includes("API key not valid")
  ) {
    return copy.apiKeyInvalid;
  }
  return message || "DESKTOP_AUTH_FAILED";
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
  const signInStarted = useRef(false);

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
        if (!active || signInStarted.current) return;
        signInStarted.current = true;
        setMessage("");
        void startGoogleSignIn();
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
        const authorize = httpsCallable(
          bridgeFunctions,
          "authorizeDesktopLogin",
        );
        const response = DesktopLoginInspectResponseSchema.parse(
          (
            await authorize({
              action: "inspect",
              attemptId: query.attempt,
              state: query.state,
            })
          ).data,
        );
        if (response.attemptId !== query.attempt)
          throw new Error("DESKTOP_AUTH_ATTEMPT_INVALID");
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
        (
          await authorize({
            action: "allow",
            attemptId: query.attempt,
            state: query.state,
          })
        ).data,
      );
      if (
        response.attemptId !== query.attempt ||
        response.state !== query.state
      )
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
        <div className="brand-mark">{copy.brandMark}</div>
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1 id="desktop-auth-title">{copy.title}</h1>
        {!query ? (
          <p className="message" role="alert">
            {copy.queryInvalid}
          </p>
        ) : inspection ? (
          <>
            {/*
              The host's identity is its own line and the action is a whole
              sentence about it. The Korean original instead spelled the
              sentence out across these JSX children — name, then a case
              particle, then the action as a noun, then a verb ending — which
              only ever parsed as Korean.
            */}
            <p className="muted">
              <strong>{inspection.displayName}</strong> (
              {inspection.fingerprintSuffix})
              <br />
              {copy.action[inspection.action]}
            </p>
            <button
              className="primary-button login-button"
              data-testid="desktop-auth-allow"
              onClick={() => void allow()}
              disabled={busy}
            >
              {busy ? copy.allowBusy : copy.allow}
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              {busy ? copy.redirecting : copy.signInFailed}
            </p>
            {!busy ? (
              <button
                className="primary-button login-button"
                onClick={() => {
                  signInStarted.current = true;
                  void startGoogleSignIn();
                }}
              >
                {copy.retry}
              </button>
            ) : null}
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

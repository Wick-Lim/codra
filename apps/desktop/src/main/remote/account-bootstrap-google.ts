import type { FirebaseRuntime } from "@codra/firebase";
import {
  bootstrapProductionDesktopAuth,
  bootstrapProductionDesktopLogin,
  type DesktopLoginBootstrapOptions,
  type DesktopLoginBootstrapResult,
} from "./desktop-login";
import { openDesktopAuthWindow } from "./auth-window";
import type { DesktopAuthParentWindowLike } from "./auth-window";

export const remoteAccountBootstrapBinding = "google-main" as const;

export async function bootstrapRemoteAuth(
  runtime: FirebaseRuntime,
  provider: "google" | "email_password",
  signal?: AbortSignal,
  parentWindow?: DesktopAuthParentWindowLike,
): Promise<void> {
  if (provider !== "google") throw new Error("AUTH_PROVIDER_UNAVAILABLE");
  if (runtime.deployment.mode !== "production")
    throw new Error("DESKTOP_GOOGLE_LOGIN_REQUIRES_PRODUCTION");
  const authHandlerUrl = runtime.deployment.firebaseAuthHandlerUrl;
  await bootstrapProductionDesktopAuth(
    runtime,
    {
      openExternal: (url, callbackUrl, deadlineSignal) => {
        if (!callbackUrl) throw new Error("DESKTOP_LOGIN_CALLBACK_URL_MISSING");
        return openDesktopAuthWindow(url, callbackUrl, {
          authHandlerUrl,
          parent: parentWindow,
          signal: deadlineSignal,
        });
      },
    },
    signal,
  );
}

export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
): Promise<DesktopLoginBootstrapResult> {
  if (runtime.deployment.mode !== "production")
    throw new Error("DESKTOP_GOOGLE_LOGIN_REQUIRES_PRODUCTION");
  const authHandlerUrl = runtime.deployment.firebaseAuthHandlerUrl;
  return bootstrapProductionDesktopLogin(runtime, options, {
    openExternal: (url, callbackUrl, signal) => {
      if (!callbackUrl) throw new Error("DESKTOP_LOGIN_CALLBACK_URL_MISSING");
      return openDesktopAuthWindow(url, callbackUrl, {
        authHandlerUrl,
        signal,
      });
    },
  });
}

import type { FirebaseRuntime } from "@codra/firebase";
import { app, shell } from "electron";
import {
  bootstrapProductionDesktopAuth,
  bootstrapProductionDesktopLogin,
  type DesktopLoginBootstrapOptions,
  type DesktopLoginBootstrapResult,
} from "./desktop-login";
import type { DesktopAuthParentWindowLike } from "./auth-window";

export const remoteAccountBootstrapBinding = "google-main" as const;

function revealParentWindow(
  parentWindow: DesktopAuthParentWindowLike | undefined,
): void {
  app.focus({ steal: true });
  if (!parentWindow || parentWindow.isDestroyed()) return;
  if (parentWindow.isMinimized()) parentWindow.restore();
  if (!parentWindow.isVisible()) parentWindow.show();
  parentWindow.focus();
}

export async function bootstrapRemoteAuth(
  runtime: FirebaseRuntime,
  provider: "google" | "email_password",
  signal?: AbortSignal,
  parentWindow?: DesktopAuthParentWindowLike,
): Promise<void> {
  if (provider !== "google") throw new Error("AUTH_PROVIDER_UNAVAILABLE");
  if (runtime.deployment.mode !== "production")
    throw new Error("DESKTOP_GOOGLE_LOGIN_REQUIRES_PRODUCTION");
  try {
    await bootstrapProductionDesktopAuth(
      runtime,
      {
        openExternal: (url, callbackUrl) => {
          if (!callbackUrl)
            throw new Error("DESKTOP_LOGIN_CALLBACK_URL_MISSING");
          return shell.openExternal(url);
        },
      },
      signal,
    );
  } finally {
    revealParentWindow(parentWindow);
  }
}

export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
  parentWindow?: DesktopAuthParentWindowLike,
): Promise<DesktopLoginBootstrapResult> {
  if (runtime.deployment.mode !== "production")
    throw new Error("DESKTOP_GOOGLE_LOGIN_REQUIRES_PRODUCTION");
  try {
    return await bootstrapProductionDesktopLogin(runtime, options, {
      openExternal: (url, callbackUrl) => {
        if (!callbackUrl) throw new Error("DESKTOP_LOGIN_CALLBACK_URL_MISSING");
        return shell.openExternal(url);
      },
    });
  } finally {
    revealParentWindow(parentWindow);
  }
}

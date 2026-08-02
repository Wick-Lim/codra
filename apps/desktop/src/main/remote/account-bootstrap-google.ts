import type { FirebaseRuntime } from "@codra/firebase";
import {
  bootstrapProductionDesktopAuth,
  bootstrapProductionDesktopLogin,
  type DesktopLoginBootstrapOptions,
  type DesktopLoginBootstrapResult,
} from "./desktop-login";
import { shell } from "electron";

export const remoteAccountBootstrapBinding = "google-main" as const;

export async function bootstrapRemoteAuth(
  runtime: FirebaseRuntime,
  provider: "google" | "email_password",
): Promise<void> {
  if (provider !== "google") throw new Error("AUTH_PROVIDER_UNAVAILABLE");
  await bootstrapProductionDesktopAuth(runtime, {
    openExternal: (url) => shell.openExternal(url),
  });
}

export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
): Promise<DesktopLoginBootstrapResult> {
  return bootstrapProductionDesktopLogin(runtime, options, {
    openExternal: (url) => shell.openExternal(url),
  });
}

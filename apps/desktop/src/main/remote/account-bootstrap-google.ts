import type { FirebaseRuntime } from "@codra/firebase";
import {
  bootstrapProductionDesktopLogin,
  type DesktopLoginBootstrapOptions,
  type DesktopLoginBootstrapResult,
} from "./desktop-login";
import { shell } from "electron";

export const remoteAccountBootstrapBinding = "google-main" as const;

export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
): Promise<DesktopLoginBootstrapResult> {
  return bootstrapProductionDesktopLogin(runtime, options, {
    openExternal: (url) => shell.openExternal(url),
  });
}

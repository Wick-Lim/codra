declare module "@codra/remote-account-bootstrap" {
  import type { FirebaseRuntime } from "@codra/firebase";
  import type {
    DesktopLoginBootstrapOptions,
    DesktopLoginBootstrapResult,
  } from "./desktop-login";

  export const remoteAccountBootstrapBinding: string;
  export function bootstrapRemoteAuth(
    runtime: FirebaseRuntime,
    provider: "google" | "email_password",
  ): Promise<void>;
  export function bootstrapRemoteAccount(
    runtime: FirebaseRuntime,
    options: DesktopLoginBootstrapOptions,
  ): Promise<DesktopLoginBootstrapResult | undefined>;
}

declare module "@codra/remote-firebase-config" {
  import type { FirebaseRuntime } from "@codra/firebase";

  export const remoteFirebaseConfigBinding: string;
  export function createRemoteFirebaseRuntime(appName?: string): FirebaseRuntime;
}

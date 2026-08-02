declare module "@codra/remote-account-bootstrap" {
  import type { FirebaseRuntime } from "@codra/firebase";
  import type {
    DesktopLoginBootstrapOptions,
    DesktopLoginBootstrapResult,
  } from "./desktop-login";
  import type { DesktopAuthParentWindowLike } from "./auth-window";

  export const remoteAccountBootstrapBinding: string;
  export function bootstrapRemoteAuth(
    runtime: FirebaseRuntime,
    provider: "google" | "email_password",
    signal?: AbortSignal,
    parentWindow?: DesktopAuthParentWindowLike,
  ): Promise<void>;
  export function bootstrapRemoteAccount(
    runtime: FirebaseRuntime,
    options: DesktopLoginBootstrapOptions,
    parentWindow?: DesktopAuthParentWindowLike,
  ): Promise<DesktopLoginBootstrapResult | undefined>;
}

declare module "@codra/remote-firebase-config" {
  import type { FirebaseRuntime } from "@codra/firebase";

  export const remoteFirebaseConfigBinding: string;
  export function createRemoteFirebaseRuntime(
    appName?: string,
  ): FirebaseRuntime;
}

declare module "@codra/remote-session-auto-approve" {
  import type { SessionApprovalRegistry } from "./session-approval";

  export const remoteSessionAutoApproveBinding: string;
  export function installSessionAutoApprove(
    registry: SessionApprovalRegistry,
    reportError: (error: unknown) => void,
  ): () => void;
}

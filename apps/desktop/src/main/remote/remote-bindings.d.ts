declare module "@codra/remote-account-bootstrap" {
  import type { FirebaseRuntime } from "@codra/firebase";

  export const remoteAccountBootstrapBinding: string;
  export function bootstrapRemoteAccount(
    runtime: FirebaseRuntime,
  ): Promise<unknown>;
}

declare module "@codra/remote-firebase-config" {
  import type { FirebaseRuntime } from "@codra/firebase";

  export const remoteFirebaseConfigBinding: string;
  export function createRemoteFirebaseRuntime(): FirebaseRuntime;
}

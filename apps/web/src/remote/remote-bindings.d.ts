declare module "@codra/web-account-bootstrap" {
  import type { FirebaseRuntime } from "@codra/firebase";
  import type { UserCredential } from "firebase/auth";

  export const webAccountBootstrap: string;
  export function bootstrapRemoteAccount(
    runtime: FirebaseRuntime,
  ): Promise<UserCredential>;
}

declare module "@codra/web-firebase-config" {
  import type { FirebaseRuntime } from "@codra/firebase";

  export const webFirebaseConfigBinding: string;
  export function createRemoteFirebaseRuntime(): FirebaseRuntime;
}

declare module "@codra/web-desktop-auth-bridge" {
  import type { ComponentType } from "react";

  const DesktopAuthBridge: ComponentType;
  export default DesktopAuthBridge;
}

import { createFirebaseRuntime, DEMO_FIREBASE_OPTIONS } from "@codra/firebase";
import type { FirebaseRuntime } from "@codra/firebase";

export const remoteFirebaseConfigBinding = "emulator-main" as const;
export const remoteFirebaseConfig = DEMO_FIREBASE_OPTIONS;
export function createRemoteFirebaseRuntime(
  appName = "codra-host",
): FirebaseRuntime {
  return createFirebaseRuntime({ mode: "emulator", appName });
}

import { createFirebaseRuntime, DEMO_FIREBASE_OPTIONS } from "@codra/firebase";
import type { FirebaseRuntime } from "@codra/firebase";

export const webFirebaseConfigBinding = "emulator" as const;
export const webFirebaseConfig = DEMO_FIREBASE_OPTIONS;
export function createRemoteFirebaseRuntime(): FirebaseRuntime {
  return createFirebaseRuntime({ mode: "emulator", appName: "codra-browser" });
}

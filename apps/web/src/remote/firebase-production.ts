import {
  DESKTOP_APPCHECK_FIREBASE_APP_ID,
  productionPublicConfig,
} from "@codra/protocol/production";
import { createFirebaseRuntime } from "@codra/firebase";
import type { FirebaseRuntime } from "@codra/firebase";

export const webFirebaseConfigBinding = "production" as const;
export const webFirebaseConfig = productionPublicConfig;
export function createRemoteFirebaseRuntime(): FirebaseRuntime {
  return createFirebaseRuntime({
    mode: "production",
    desktopAppCheckFirebaseAppId: DESKTOP_APPCHECK_FIREBASE_APP_ID,
    appName: "codra-browser",
  });
}

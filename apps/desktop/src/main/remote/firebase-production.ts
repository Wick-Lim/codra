import {
  DESKTOP_APPCHECK_FIREBASE_APP_ID,
  productionPublicConfig,
} from "@codra/protocol/production";
import { createFirebaseRuntime } from "@codra/firebase";
import type { FirebaseRuntime } from "@codra/firebase";

export const remoteFirebaseConfigBinding = "production-main" as const;
export const remoteFirebaseConfig = productionPublicConfig;
export function createRemoteFirebaseRuntime(): FirebaseRuntime {
  return createFirebaseRuntime({
    mode: "production",
    desktopAppCheckFirebaseAppId:
      process.env.CODRA_DESKTOP_APPCHECK_APP_ID ??
      DESKTOP_APPCHECK_FIREBASE_APP_ID,
    appName: "codra-host",
  });
}

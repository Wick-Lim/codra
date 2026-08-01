import {
  browserPopupRedirectResolver,
  browserSessionPersistence,
  getAuth,
  initializeAuth,
  type Auth,
} from "firebase/auth";
import { getApps, initializeApp } from "firebase/app";
import { getFunctions } from "firebase/functions";
import { FUNCTION_REGION, productionPublicConfig } from "@codra/protocol/production";

const BRIDGE_APP_NAME = "codra-desktop-auth-bridge";

const existingBridgeApp = getApps().find((app) => app.name === BRIDGE_APP_NAME);
export const bridgeApp =
  existingBridgeApp ?? initializeApp(productionPublicConfig, BRIDGE_APP_NAME);

function createBridgeAuth(): Auth {
  if (existingBridgeApp) return getAuth(bridgeApp);
  return initializeAuth(bridgeApp, {
    // Redirect completion crosses a full-page navigation, so this isolated
    // named Auth instance needs session-scoped persistence.
    persistence: browserSessionPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
}

export const bridgeAuth = createBridgeAuth();
export const bridgeFunctions = getFunctions(bridgeApp, FUNCTION_REGION);

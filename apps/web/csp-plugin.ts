/**
 * The web document, unlike the desktop renderer, talks to Firebase itself, so
 * it cannot ship the renderer's `connect-src 'none'; frame-src 'none'` policy
 * (apps/desktop/src/renderer/index.html). Only the build-time substitution
 * pattern is shared with apps/desktop/renderer-csp-plugin.ts.
 *
 * Two things are deliberately absent from every policy built here:
 * - No `turn:`/`turns:` URL and no relay vendor constant. WebRTC ICE and relay
 *   traffic is not governed by `connect-src` at all, and index.html lands in
 *   apps/web/dist, which scan-client-artifacts denies on rules `turn-url` and
 *   `turn-vendor-constant`.
 * - No CSP3 `webrtc` directive. Absent, WebRTC is allowed; it does not fall
 *   back to `default-src`. If one is ever added it must be `webrtc 'allow'`,
 *   because `webrtc 'block'` would kill the console's data channel.
 */
import type { ConfigEnv, Plugin } from "vite";
// Imported by relative path, not by the `@codra/protocol` specifier: vite
// bundles a config file with esbuild and externalises every *bare* import to
// its resolved path, which would hand Node a `.ts` file it cannot load. A
// relative import is inlined into the config bundle instead.
import {
  CODRA_PROJECT_ID,
  FUNCTION_REGION,
  emulatorDeployment,
  productionPublicConfig,
} from "../../packages/protocol/src/deployment";

/** Which vite config is building: `vite.config.ts` or the remote-test one. */
export type CodraWebCspFlavor = "production" | "emulator";

export const CODRA_WEB_CSP_PLACEHOLDER = "__CODRA_WEB_CSP__";

/** `httpsCallable` targets the regional Cloud Functions origin. */
const CALLABLE_ORIGIN = `https://${FUNCTION_REGION}-${CODRA_PROJECT_ID}.cloudfunctions.net`;

/** `browserPopupRedirectResolver` mounts `${authDomain}/__/auth/iframe`. */
const AUTH_HELPER_ORIGIN = `https://${productionPublicConfig.authDomain}`;

const PRODUCTION_CONNECT_SRC = [
  "'self'",
  // sign-in
  "https://identitytoolkit.googleapis.com",
  // ID token refresh
  "https://securetoken.googleapis.com",
  // onSnapshot over the Firestore REST/WebChannel transport
  "https://firestore.googleapis.com",
  CALLABLE_ORIGIN,
].join(" ");

/** Derived from packages/protocol/src/deployment.ts (emulatorDeployment). */
const EMULATOR_CONNECT_SRC = [
  "'self'",
  emulatorDeployment.authOrigin,
  emulatorDeployment.firestoreOrigin,
  emulatorDeployment.functionsOrigin,
].join(" ");

export function codraWebContentSecurityPolicy(
  flavor: CodraWebCspFlavor,
): string {
  const production = flavor === "production";
  const directives: ReadonlyArray<readonly [string, string]> = [
    ["default-src", "'self'"],
    ["base-uri", "'none'"],
    ["object-src", "'none'"],
    ["form-action", "'none'"],
    // Ignored inside <meta http-equiv>; firebase.json serves it as a header.
    ["frame-ancestors", "'none'"],
    // apis.google.com/js/api.js backs the popup/redirect resolver. The
    // emulator flavour signs in with email and password and never loads it.
    ["script-src", production ? "'self' https://apis.google.com" : "'self'"],
    // xterm.js sets inline styles on every row it renders.
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", "'self' data: https://*.googleusercontent.com"],
    ["font-src", "'self' data:"],
    ["connect-src", production ? PRODUCTION_CONNECT_SRC : EMULATOR_CONNECT_SRC],
    ["frame-src", production ? AUTH_HELPER_ORIGIN : "'none'"],
  ];
  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

export function applyCodraWebCsp(
  html: string,
  flavor: CodraWebCspFlavor,
): string {
  return html.replaceAll(
    CODRA_WEB_CSP_PLACEHOLDER,
    codraWebContentSecurityPolicy(flavor),
  );
}

const CSP_META_ELEMENT =
  /[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n?/gu;

/**
 * `vite dev` is not covered by any policy: @vitejs/plugin-react injects its
 * react-refresh preamble as an *inline* module script, which `script-src
 * 'self'` would block, and relaxing the shipped policy with `'unsafe-inline'`
 * to accommodate the dev server is exactly how a relaxation reaches
 * production. The meta element is dropped instead, so the served document has
 * no policy at all rather than a weakened one.
 */
export function stripCodraWebCsp(html: string): string {
  return html.replace(CSP_META_ELEMENT, "");
}

export function codraWebCspPlugin(flavor: CodraWebCspFlavor): Plugin {
  let command: ConfigEnv["command"] = "build";
  return {
    name: "codra-web-csp",
    config(_userConfig, env) {
      command = env.command;
    },
    transformIndexHtml(html) {
      return command === "serve"
        ? stripCodraWebCsp(html)
        : applyCodraWebCsp(html, flavor);
    },
  };
}

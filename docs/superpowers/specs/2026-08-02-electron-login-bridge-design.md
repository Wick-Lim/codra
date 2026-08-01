# CODRA Electron System-Browser Login Bridge Design

**Date:** 2026-08-02

## Goal

Allow a production CODRA Electron host to authenticate through the Firebase Hosting Google login page without embedding Google OAuth in Electron and without sending Google credentials through Electron IPC or the loopback callback.

## Approved flow

1. Electron main creates or loads its P-256 host identity, binds an HTTP listener to `127.0.0.1` on an ephemeral port, and generates a fresh attempt ID, state, nonce, and PKCE verifier.
2. Electron signs the start binding with the host key and calls the regional `desktopLoginStart` HTTP Function. The Function stores a short-lived pending transaction containing the device public key, thumbprint, PKCE challenge, state hash, callback port/path, and Electron-generated nonce, then returns that nonce as the server-confirmed transaction nonce.
3. Electron opens only `https://codra-1b3bb.firebaseapp.com/desktop-auth?attempt=...&state=...` with `shell.openExternal`.
4. The hosted bridge uses a dedicated Firebase Auth instance to sign the user in with Google. It calls `authorizeDesktopLogin` first in inspect mode, shows the requested device name/fingerprint and action, and requires an explicit Allow click.
5. Allow consumes the transaction exactly once and returns a one-time code plus the server-approved loopback callback URL. The bridge performs one top-level navigation to that callback with only `attempt`, `code`, and `state`.
6. Electron validates the exact callback host/path/query and exchanges the code with `desktopLoginRedeem`, providing the PKCE verifier, nonce, and a fresh device-key signature. The Function atomically consumes the code, creates/resumes the same UID device, and returns a device-scoped Firebase custom token and device record.
7. Electron signs in with the returned custom token in main-process memory and continues the existing host registration/presence flow. On timeout, cancellation, malformed callback, or failure, the attempt is discarded and a future action starts with entirely new values.

## Boundaries

- Production Electron never imports password auth, opens a BrowserWindow for OAuth, or follows a Google redirect to loopback.
- The loopback listener accepts only `GET /auth/callback` with Host exactly `127.0.0.1:<port>`, and only the three expected query keys.
- Login transaction documents are Admin-only and expire quickly. Codes are stored as hashes and are single-use.
- Google credentials remain in the hosted bridge Auth session and are signed out after Allow. Device custom tokens remain only in Electron main memory.
- The existing remote-test alias keeps its email/password bootstrap and emulator flow; production and remote-test bindings remain compile-time separated.
- App Check is not enforced on the initial login endpoint in the current MVP. The approved Desktop Web App ID is registered in deployment metadata and reserved for the later custom App Check seed/refresh path.

## Components

- `packages/protocol`: Zod schemas and canonical payload builders for desktop login start/redeem/authorize contracts.
- `functions/src/desktop-login.ts`: raw HTTP start/redeem/cancel and callable inspect/allow handlers, transaction persistence, Google provider validation, device creation/resume, and custom-token minting.
- `apps/desktop/src/main/remote/account-bootstrap-google.ts`: PKCE generation, loopback listener, system-browser launch, Function calls, callback validation, and custom-token result.
- `apps/desktop/src/main/remote/host-controller.ts`: consume the bootstrap result and skip duplicate account registration.
- `apps/web/src/remote/DesktopAuthBridge.tsx`: hosted Google login/inspect/Allow/callback UI at `/desktop-auth`.
- `apps/web/src/remote/firebase-bridge.ts`: dedicated Firebase Auth instance and callable URL wiring for the bridge.
- `firebase.json`: preserve exact `/desktop-auth` and `/login` SPA rewrites.

## Error handling

Every boundary returns a safe error code without credentials, private keys, SDP, terminal data, or TURN data. A failed or expired transaction cannot be reused. Electron reports a bounded user-facing error and keeps local terminal startup independent.

## Verification

- Protocol tests cover canonical schemas and PKCE/state binding.
- Functions tests cover Google-provider rejection, transaction one-time consume, callback/nonce/PKCE mismatch, resume key mismatch, and custom-token claim shape.
- Electron tests cover exact loopback callback acceptance/rejection, first-valid callback race, timeout/cancel cleanup, and no embedded OAuth.
- Web build and remote-test build confirm the production bridge is absent from the remote-test artifact and the hosted bridge route renders.

# Electron System-Browser Login Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production Electron Google-login stub with a PKCE/state-bound Firebase Hosting bridge that returns only a one-time device custom-token exchange result to Electron main.

**Architecture:** Freeze desktop-login request/response schemas and canonical signing payloads in `@codra/protocol`. Firebase Functions persist short-lived Admin-only login transactions, authorize Google users through a callable inspect/allow step, and redeem one-time codes into a device-scoped custom token. Electron main owns the loopback listener, PKCE verifier, host key signature, system-browser launch, and in-memory Auth session. The hosted `/desktop-auth` route owns Google Auth and explicit Allow UI, then navigates once to the validated loopback callback.

**Tech Stack:** Node.js 22, TypeScript 5.9, Firebase Functions v2, Firebase Auth/Firestore, Electron 43, React 19, Zod 4, Vitest.

## Global Constraints

- Production Electron uses `shell.openExternal` and never embeds Google OAuth in BrowserWindow, BrowserView, webview, iframe, or renderer IPC.
- Only `GET /auth/callback` on `127.0.0.1:<ephemeral-port>` with exactly `attempt`, `code`, and `state` query keys is accepted.
- PKCE uses exactly 32 random bytes, unpadded base64url verifier length 43, and S256 challenge.
- Google credentials never enter Electron, the loopback URL, logs, disk, or renderer IPC. Device custom tokens remain in Electron main memory only.
- Email/password remains reachable only through the existing remote-test alias.
- Login transactions are Admin-only, short-lived, state/nonce/PKCE bound, and one-time consumable.
- Local terminal startup remains independent of all remote login failures.
- New Desktop Firebase App ID is `1:92715578857:web:f955949d45ca300ed3c778`; existing bridge Web App ID remains unchanged.
- Every task ends with focused tests and a commit; use `git diff --check` before each commit.

---

### Task 1: Freeze desktop login protocol contracts

**Files:**

- Modify: `packages/protocol/src/remote.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/desktop-login.test.ts`

**Interfaces:**

- Produce `DesktopLoginActionSchema`, `DesktopLoginStartRequestSchema`, `DesktopLoginAuthorizeRequestSchema`, `DesktopLoginRedeemRequestSchema`, `DesktopLoginCancelRequestSchema`.
- Produce response schemas for inspect, allow, redeem, and cancel.
- Produce `buildDesktopLoginStartSigningPayload` and `buildDesktopLoginRedeemSigningPayload`.
- Reuse `createPkceVerifier`, `createPkceChallenge`, `sha256Base64Url`, `PublicEcJwkSchema`, `ThumbprintSchema`, and `P256SignatureSchema`.

- [ ] **Step 1: Add schemas and builders**

Use strict objects with these exact fields:

```ts
type DesktopLoginAction = "register" | "resume" | "reenable";

DesktopLoginStartRequest = {
  attemptId: string; action: DesktopLoginAction; deviceId: string;
  displayName: string; publicKeyJwk: PublicEcJwk; keyThumbprint: string;
  pkceChallenge: string; stateHash: string; nonce: string;
  callbackPort: number; callbackPath: "/auth/callback";
  startSignature: string;
};

DesktopLoginAuthorizeRequest = {
  action: "inspect" | "allow"; attemptId: string; state: string;
};

DesktopLoginRedeemRequest = {
  attemptId: string; code: string; state: string; nonce: string;
  pkceVerifier: string; deviceSignature: string;
};

DesktopLoginCancelRequest = {
  attemptId: string; state: string;
};
```

Responses:

```ts
DesktopLoginInspectResponse = {
  attemptId: string; action: DesktopLoginAction;
  displayName: string; fingerprintSuffix: string;
};
DesktopLoginAllowResponse = {
  attemptId: string; callbackUrl: string; state: string; code: string;
};
DesktopLoginRedeemResponse = {
  token: string; serverTimeMillis: number; device: RemoteDevice;
};
DesktopLoginCancelResponse = { cancelled: boolean };
```

- [ ] **Step 2: Add canonical payload builders**

`buildDesktopLoginStartSigningPayload` removes `startSignature` from the start request. `buildDesktopLoginRedeemSigningPayload` returns exactly `{domain: "codra.desktop-login.redeem.v1", attemptId, code, state, nonce, deviceId, keyThumbprint}`.

- [ ] **Step 3: Add RED tests**

Test malformed UUIDs, callback ports outside 1–65535, noncanonical PKCE/state/nonce values, extra object keys, invalid public keys/thumbprints/signatures, and exact builder output.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @codra/protocol test -- desktop-login.test.ts`
Expected: all desktop-login tests pass.

- [ ] **Step 5: Commit**

```sh
git add packages/protocol/src packages/protocol/test/desktop-login.test.ts
git commit -m "feat: freeze desktop login contracts"
```

---

### Task 2: Implement Firebase desktop-login transaction Functions

**Files:**

- Create: `functions/src/desktop-login.ts`
- Modify: `functions/src/index.ts`
- Create: `functions/test/desktop-login.test.ts`

**Interfaces:**

- Export `desktopLoginStart`, `authorizeDesktopLogin`, `desktopLoginRedeem`, and `desktopLoginCancel`.
- `desktopLoginStart` and `desktopLoginRedeem` are regional `onRequest` handlers with manual POST/JSON/no-store/no-Origin validation.
- `authorizeDesktopLogin` is a regional callable accepting only Google Auth.
- `desktopLoginCancel` is a regional `onRequest` handler.
- Store transactions under `serverDesktopLoginTransactions/{attemptId}`; Firestore rules already deny client access.

- [ ] **Step 1: Add failing transaction tests**

Cover:

- start rejects non-POST, present Origin, wrong content type, malformed input, bad start signature, and duplicate attempt IDs;
- start stores only bounded device/login metadata, state hash, callback port/path, PKCE challenge, and the Electron-generated nonce; the returned `serverNonce` is the server-confirmed echo of that transaction-bound nonce;
- inspect rejects absent/non-Google Auth, wrong state, missing transaction, expired/cancelled/consumed transaction;
- allow writes owner UID and a hashed one-time code exactly once and returns the callback URL;
- redeem rejects wrong code/state/nonce/verifier/signature and consumes a valid code exactly once;
- redeem register creates a device and custom token with exact `codraDeviceId`, `codraKeyThumbprint`, `codraDeviceKind: "host"`, and `codraDeviceGeneration` claims;
- resume requires the existing device key/thumbprint and active state;
- cancel is idempotent only for the same pending attempt.

- [ ] **Step 2: Implement bounded HTTP parsing**

Require:

- `POST`;
- `Content-Type: application/json`;
- no `Origin` header;
- body at most 32 KiB;
- `Cache-Control: no-store`;
- safe JSON error codes without secrets.

Use `crypto.randomBytes(32)` for codes/nonces and `sha256Base64Url` for code/state hashes.

- [ ] **Step 3: Implement start and authorization**

Start verifies the device public key thumbprint and `startSignature`, stores a five-minute pending transaction, and returns `{attemptId, serverNonce, expiresAt, callbackUrl}`. `serverNonce` equals the validated Electron-generated nonce from the start request; it is not a second caller-visible nonce.

Authorization calls `requireGoogleAccount`, validates recent `auth_time` (five minutes, 30-second future skew), verifies state hash, and returns inspect metadata. Allow uses a transaction to write owner UID, code hash, code expiry, and authorized status before returning plaintext code exactly once.

- [ ] **Step 4: Implement redemption and cancellation**

Redeem transactionally validates pending-authorized state, code hash, state hash, nonce, PKCE S256 challenge, callback binding, and device signature before creating/resuming the host device and consuming the transaction. Use `adminAuth.createCustomToken` with the four device-scoped claims. Cancel marks only a still-pending/authorized transaction cancelled and never deletes it.

- [ ] **Step 5: Add Functions tests and metadata**

Assert all four exports use `FUNCTION_REGION`, raw handlers omit callable App Check options, and the public export list includes the four exact names.

- [ ] **Step 6: Run focused Functions verification**

Run:

```sh
pnpm --filter @codra/functions test
pnpm --filter @codra/functions typecheck
pnpm --filter @codra/functions build
git diff --check
```

- [ ] **Step 7: Commit**

```sh
git add functions/src functions/test
git commit -m "feat: add Electron desktop login Functions"
```

---

### Task 3: Implement Electron main system-browser bootstrap

**Files:**

- Create: `apps/desktop/src/main/remote/desktop-login.ts`
- Modify: `apps/desktop/src/main/remote/account-bootstrap-google.ts`
- Modify: `apps/desktop/src/main/remote/account-bootstrap-test-only.ts`
- Modify: `apps/desktop/src/main/remote/remote-bindings.d.ts`
- Modify: `apps/desktop/src/main/remote/host-controller.ts`
- Create: `apps/desktop/src/main/remote/desktop-login.test.ts`

**Interfaces:**

- `bootstrapRemoteAccount(runtime, options): Promise<DesktopLoginBootstrapResult | undefined>`.
- `DesktopLoginBootstrapResult = { token: string; serverTimeMillis: number; device: RemoteDevice }`.
- `options = { identity: HostIdentity; action: "register" | "resume" | "reenable" }`.
- Test-only bootstrap signs in with emulator email/password and returns `undefined`.
- Production bootstrap creates a listener with `listen(127.0.0.1, 0)`, calls start, opens the canonical bridge URL with `shell.openExternal`, waits for the first valid callback, calls redeem, and closes/cancels on timeout/error.

- [ ] **Step 1: Add RED tests for pure URL/PKCE/callback behavior**

Cover:

- exact 43-character verifier/challenge;
- canonical bridge URL only;
- exact Host/path/method/query acceptance;
- extra query keys, wrong host/path, bad state, duplicate callbacks, and oversized requests rejected;
- first valid callback wins;
- timeout closes listener and calls cancel;
- no BrowserWindow/webview/OAuth imports.

- [ ] **Step 2: Implement Function URL and signed request helpers**

Build production URLs as:
`https://asia-northeast3-codra-1b3bb.cloudfunctions.net/<name>`.
Build emulator URLs from `runtime.deployment.functionsOrigin`.
Use `signCanonicalPayload(identity.privateKey, buildDesktopLoginStartSigningPayload(...))` and the exact redeem signing payload.

- [ ] **Step 3: Implement loopback listener**

Bind only `127.0.0.1`, port `0`, path `/auth/callback`. Reject all invalid traffic without consuming the attempt. On first valid callback return static no-store HTML and close the listener. Discard verifier/state/nonce/code after the bootstrap promise settles.

- [ ] **Step 4: Implement production bootstrap and host-controller handoff**

Production bootstrap returns the redeem response. Move host identity loading before bootstrap, sign in with the returned custom token when present, and skip duplicate `registerDevice`; retain the existing register path for remote-test.

- [ ] **Step 5: Run desktop focused tests**

Run:

```sh
pnpm --filter @codra/desktop test -- desktop-login.test.ts
pnpm --filter @codra/desktop typecheck
```

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src/main/remote
git commit -m "feat: add Electron system-browser login bootstrap"
```

---

### Task 4: Implement hosted Firebase Google bridge UI

**Files:**

- Create: `apps/web/src/remote/DesktopAuthBridge.tsx`
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/remote/firebase-bridge.ts`
- Modify: `apps/web/src/remote/remote-bindings.d.ts`
- Create: `apps/web/src/remote/DesktopAuthBridge.test.tsx`

**Interfaces:**

- Route `/desktop-auth` renders `DesktopAuthBridge`; all other routes retain current login/workspace behavior.
- Bridge uses the existing production Firebase config and a dedicated named Auth instance.
- It performs Google `signInWithRedirect`, explicit `getRedirectResult`, callable inspect, explicit Allow, then exactly one top-level callback navigation.
- Remote-test build renders a safe unsupported message and never imports production Google bridge code.

- [ ] **Step 1: Add RED bridge state tests**

Cover initial missing query, sign-in button, redirect result handling, inspect metadata display, Allow-only code issuance, and one callback navigation with exactly attempt/code/state.

- [ ] **Step 2: Implement dedicated bridge Firebase runtime**

Initialize a named Firebase app/Auth instance for the hosted bridge and regional Functions. Do not reuse the browser workspace Auth session. Sign out the bridge Auth after Allow/error.

- [ ] **Step 3: Implement bridge state machine**

Parse exactly `attempt` and `state` from the URL. Use `signInWithRedirect(auth, new GoogleAuthProvider())`; after return call `getRedirectResult(auth)`, then inspect. Display device name, fingerprint suffix, and register/resume action. Only an explicit Allow calls allow. Navigate once to the server-returned callback URL with three query values.

- [ ] **Step 4: Add route and production/remote-test separation**

Place the route check before normal App auth state. Keep `/login` and `/` behavior unchanged. Add a remote-test-safe branch that cannot import or call Google production code.

- [ ] **Step 5: Run web verification**

Run:

```sh
pnpm --filter @codra/web test
pnpm --filter @codra/web typecheck
pnpm --filter @codra/web build
pnpm --filter @codra/web build:remote-test
```

- [ ] **Step 6: Commit**

```sh
git add apps/web/src
git commit -m "feat: add hosted Electron login bridge"
```

---

### Task 5: Integrate, emulator-test, deploy, and verify

**Files:**

- Modify: `scripts/verify-remote-build-config.mjs`
- Modify: `docs/runbooks/remote-access.md` (create if absent)
- Modify: `README.md` only for user-facing login instructions

- [ ] **Step 1: Update build/config assertions**

Require the four Function exports, `/desktop-auth` and `/login` rewrites, production Google binding, remote-test password binding, and the new Desktop App ID constant.

- [ ] **Step 2: Run the full verification suite**

Run:

```sh
pnpm typecheck
pnpm test
node scripts/verify-remote-build-config.mjs
pnpm --filter @codra/web build
pnpm --filter @codra/desktop build
pnpm --filter @codra/web build:remote-test
pnpm --filter @codra/desktop build:remote-test
git diff --check
```

- [ ] **Step 3: Run emulator convergence checks**

Start the existing `demo-codra` emulators and verify:

- a remote-test host starts local terminal immediately;
- malformed login callbacks do not terminate the process;
- valid remote-test account bootstrap still registers a host;
- production bridge modules are absent from remote-test output.

- [ ] **Step 4: Deploy only after verification**

Deploy Functions and Hosting to `codra-1b3bb` using the already configured TURN secret. Never print or pass the TURN bearer in output.

- [ ] **Step 5: Commit documentation and final integration**

```sh
git add scripts docs README.md
git commit -m "docs: document Electron login bridge"
git push origin main
```

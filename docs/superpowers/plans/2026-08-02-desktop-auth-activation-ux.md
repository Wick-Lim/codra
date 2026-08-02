# Desktop Auth and Remote Activation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Google account authentication from remote-host activation in the Electron app, while providing a provider-selection dialog and a working Firestore session listener.

**Architecture:** The main process will maintain independent account and host state. Account login uses the direct Firebase/Identity Toolkit Google loopback flow without creating a desktop-device transaction; host activation reuses the signed-in Firebase session to register/resume the local host and start heartbeat/session subscriptions. The renderer receives separate IPC state streams and renders account-provider login plus an explicit activate/deactivate control.

**Tech Stack:** Electron main/preload, React renderer, Firebase Auth/Firestore/Functions, Zod protocol schemas, Vitest, Firebase CLI.

## Global Constraints

- Production desktop authentication uses the configured Firebase Web app and Google provider; no embedded BrowserWindow OAuth.
- Email/password remains test-only and must not be enabled in the production Google binding.
- Remote host activation is opt-in; app startup must not open a browser or start Firestore listeners.
- Local terminal functionality remains available while account authentication or remote activation is idle/error.
- Firestore query indexes and rules are deployed from `firestore.indexes.json` and `firestore.rules`.

---

### Task 1: Extend protocol and IPC contracts for independent account/host state

**Files:**

- Modify: `packages/protocol/src/desktop-api.ts`
- Modify: `packages/protocol/test/desktop-api.test.ts`
- Modify: `apps/desktop/src/main/ipc/remote-ipc.ts`
- Modify: `apps/desktop/src/main/ipc/remote-ipc.test.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/desktop-api.test.ts`

**Interfaces:**

- Produce `RemoteAccountStatusSchema` with states `signed_out`, `signing_in`, `signed_in`, and `error`.
- Produce `RemoteAuthProviderSchema` with `google` and `email_password` values.
- Keep `RemoteHostStatusSchema`, adding host state `activating` while retaining `idle`, `online`, and `error`.
- Expose `remote.getAuthState()`, `remote.login(provider)`, `remote.onAuthStateChanged(listener)`, `remote.getState()`, `remote.activate()`, `remote.deactivate()`, and `remote.onStateChanged(listener)`.

- [ ] **Step 1: Add failing schema and API contract tests** for account states/providers, host activation state, and all new IPC channels.
- [ ] **Step 2: Run focused protocol/preload tests** and verify the new symbols fail before implementation.
- [ ] **Step 3: Implement schemas, channel names, IPC port methods, and preload validation wrappers.** Preserve terminal IPC behavior and validate provider input before invoking main IPC.
- [ ] **Step 4: Run focused protocol/preload/IPC tests** and confirm all pass.
- [ ] **Step 5: Commit** with `feat: split remote auth and host activation contracts`.

### Task 2: Add direct desktop account-auth bootstrap and existing-session activation

**Files:**

- Modify: `apps/desktop/src/main/remote/desktop-login.ts`
- Modify: `apps/desktop/src/main/remote/desktop-login.test.ts`
- Modify: `apps/desktop/src/main/remote/account-bootstrap-google.ts`
- Modify: `apps/desktop/src/main/remote/account-bootstrap-test-only.ts`
- Modify: `apps/desktop/src/main/remote/remote-bindings.d.ts`

**Interfaces:**

- Produce `bootstrapProductionDesktopAuth(runtime, overrides?)`: direct Google loopback authentication with no `desktopLoginStart` transaction.
- Extend `DesktopLoginBootstrapOptions` with `useExistingAuth?: boolean`; activation skips the Google browser flow only when this flag is true and uses the already signed-in Firebase Auth session.
- Produce `bootstrapRemoteAuth(runtime, provider)` through the compile-time Google/test-only bindings.

- [ ] **Step 1: Add RED tests** for direct auth callback exchange, no transaction endpoint call, and existing-auth activation path.
- [ ] **Step 2: Run the focused desktop-login tests** and verify the new tests fail.
- [ ] **Step 3: Extract/reuse loopback Google auth helpers** so account login opens Identity Toolkit’s direct Google URI and signs in with the returned OAuth credential.
- [ ] **Step 4: Implement `useExistingAuth` activation** with a fixed valid callback-port binding, skipping browser auth only after a current Firebase user exists; preserve cancel/redeem cleanup.
- [ ] **Step 5: Add Google and test-only provider adapters** and reject unavailable production email/password with a bounded error code.
- [ ] **Step 6: Run desktop login tests, typecheck, and build**; commit as `feat: separate desktop account auth from activation`.

### Task 3: Refactor `RemoteHostController` lifecycle and IPC wiring

**Files:**

- Modify: `apps/desktop/src/main/remote/host-controller.ts`
- Modify: `apps/desktop/src/main/remote/remote-state.ts`
- Modify: `apps/desktop/src/main/ipc/remote-ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/bootstrap.ts`
- Modify: `apps/desktop/src/main/remote/remote-state.test.ts`
- Add/Modify: `apps/desktop/src/main/remote/host-controller.test.ts`

**Interfaces:**

- `login(provider)` authenticates the account only and publishes account state.
- `activate()` requires a signed-in account, registers/resumes the host, starts heartbeat and session listeners, and publishes host state.
- `deactivate()` stops host heartbeat/listeners while preserving account authentication.
- `stop()` remains full process cleanup for app shutdown and signs out/clears both layers.

- [ ] **Step 1: Add RED controller tests** proving startup is idle, login does not subscribe sessions, activation does, deactivation preserves auth, and auth errors do not break local terminal state.
- [ ] **Step 2: Implement independent controller state/listeners** and map errors through the existing bounded error-code helper.
- [ ] **Step 3: Remove `startRemoteHost` from normal app startup** while retaining shutdown cleanup.
- [ ] **Step 4: Register account and host IPC handlers** and broadcast each state stream independently.
- [ ] **Step 5: Run main-process tests/typecheck/build**; commit as `feat: make remote activation explicit`.

### Task 4: Implement provider dialog and explicit remote activation UI

**Files:**

- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`

**Interfaces:**

- Account avatar opens a modal dialog with Google and email/password test-provider entries; unavailable providers are visibly disabled rather than silently executing another flow.
- Account status is shown independently from remote host status.
- A signed-in account with an idle host shows an explicit `원격 활성화` action; an online host shows `원격 비활성화`.

- [ ] **Step 1: Add RED renderer tests** for opening/closing the provider dialog, selecting Google, disabled test provider, separate account/host labels, and activation/deactivation buttons.
- [ ] **Step 2: Implement renderer state subscriptions and callbacks** using the new preload API; keep local terminal actions unchanged.
- [ ] **Step 3: Replace the current provider dropdown with an accessible dialog** (`role="dialog"`, escape/close button, focus-safe buttons) and add activation copy/state styling.
- [ ] **Step 4: Run renderer tests and build**; commit as `feat: add separate auth and activation controls`.

### Task 5: Verify and deploy Firestore query infrastructure

**Files:**

- Verify: `firestore.indexes.json`
- Verify: `firestore.rules`
- Modify if needed: `scripts/verify-firebase-indexes.mjs`

- [ ] **Step 1: Add/adjust an offline assertion** for the host pending-session composite index matching `hostDeviceId`, `hostKeyThumbprint`, `hostDeviceGeneration`, `status`, and ascending `createdAt`.
- [ ] **Step 2: Run index/rules verification and the full workspace test suite.**
- [ ] **Step 3: Deploy `firestore:rules` and `firestore:indexes` to project `codra-1b3bb`; verify successful release output.**
- [ ] **Step 4: Run `git diff --check`, `pnpm typecheck`, `pnpm test`, and `pnpm --filter @codra/desktop build`.**
- [ ] **Step 5: Commit/push any source changes as `fix: provision remote session listener indexes` and record deployment verification in the handoff.**

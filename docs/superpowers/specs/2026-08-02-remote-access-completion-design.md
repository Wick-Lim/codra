# CODRA Remote Access Completion Design

**Date:** 2026-08-02
**Status:** Approved interaction direction; implementation plan pending
**Supersedes:** Tasks 8 and 9 of `docs/superpowers/plans/2026-08-02-agent-target-workspace.md`

## Goal

Move remote access from "code exists but nothing has ever exercised it end to end" to "proven on two devices and deployed live." When this spec is implemented, the remote layer is a finished, verified feature and the next phase (agent orchestration) can proceed without leaving a half-built subsystem behind.

Tasks 1 through 7 of the agent-target-workspace plan are complete and committed through `4142a1c`. Task 8 is carried forward unchanged. Task 9 is replaced, because as written it cannot execute: its gate invokes `pnpm scan:client-artifacts` and its first step invokes `pnpm test:remote-direct` and `pnpm test:remote-reconnect`, and none of those scripts or specs exist.

## Product framing

CODRA's core value is parallel agent control. Remote access is a supporting layer, not the product. This spec exists to finish that layer cleanly rather than to expand it. No new remote capability is added beyond what is required to make the existing capability verifiable and safe to deploy.

## Non-goals

- Agent orchestration (root agent directing sub-agents). That is the next spec.
- A browser remote terminal client. `apps/web` is confirmed as a login bridge and read-only session list. The terminal client is not built.
- The release pipeline (`build:release-candidate`, `verify:release-candidate`, `verify:remote-release`) and `tests/e2e/release-remote-disabled.spec.ts`. These are residue from the abandoned remote-access plan and are not part of the Task 9 gate. They are deleted, not implemented.
- Scrollback performance, storage GC, logging/telemetry, and the upgrade path. Real issues, tracked separately.
- TURN relay verification. See "Deliberate limitations."

## Scope

| Piece | Content                                                             |
| ----- | ------------------------------------------------------------------- |
| A     | Browser sign-in completion and return to CODRA                      |
| B     | Move remote session approval from a native dialog into the renderer |
| C     | Two-device end-to-end harness                                       |
| D     | Three end-to-end specs                                              |
| E     | `scripts/scan-client-artifacts.mjs`                                 |
| F     | Configuration debt cleanup                                          |
| G     | Live Firebase rollout and runbook                                   |

## A. Browser sign-in completion

`apps/desktop/src/main/remote/desktop-login.ts:37-38` currently serves a single-line callback body: `<p>You can return to CODRA.</p>`. There is no CSP, no script, no button, and no parent-window refocus.

The replacement callback page, generated for both the success and cancellation paths, provides:

- a clear completion state;
- an automatic `window.close()` attempt after the CODRA window is focused;
- a visible `Return to CODRA` fallback button that retries close and focus;
- a concise instruction when browser policy prevents programmatic closing;
- a restrictive CSP with inline local CSS and script only, and no remote assets;
- Electron parent `restore()`, `show()`, `focus()`, plus application focus after completion.

The page is nonce-bound and static. No token, session identifier, or account detail is rendered into it.

**Constraint:** `desktop-login.test.ts:515-517` runs `/BrowserWindow|BrowserView|webview|signInWithPopup|signInWithRedirect/u` as a raw substring scan over the entire file text, **including the HTML**. The loopback system-browser flow must be preserved, and the new page must avoid those tokens incidentally — a CSS class named `webview` or a comment mentioning `BrowserWindow` fails the test with no obvious connection to the change.

### Constraints discovered in the existing code

The body is served on **two** paths with **duplicated, not shared, header objects**: `desktop-login.ts:303-308` (cancellation) and `327-332` (success). Both currently set exactly `Cache-Control: no-store`, `Content-Type: text/html; charset=utf-8`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. The CSP goes into both, and changing only one produces an inconsistently protected page. The error path (`sendLoopbackError`, `:242-249`) has a different header set and no `Referrer-Policy`.

The page must reference **no subresource at all** — not even a favicon. Once `settled` is true every subsequent request receives `409` (`:296-299`) and the server is closing, so any same-origin fetch fails. This is the concrete reason the CSP forbids subresources rather than merely restricting their origin.

`createDesktopLoginCallbackListener` receives **no** `DesktopLoginDependencies`; its options are exactly `{ attemptId, state, timeoutMs?, port? }` (`:262-267`). A per-response CSP nonce therefore uses the `randomBytes` already imported from `node:crypto` at `:1`, rather than the injected `dependencies.randomBytes` that exists only in the two bootstrap functions.

Response teardown destroys sockets before closing (`closeServer`, `:251-260`). The existing `response.once("finish", ...)` → `void close()` ordering is what prevents truncation; a larger body that needs multiple writes will truncate in the browser while still passing a status-code-only assertion if that ordering is disturbed.

**No existing test asserts anything about the served body or its headers** — only status codes. A new HTTP helper that captures headers and body chunks must be written; there is nothing to copy.

### Refocus plumbing

Parent-window refocus does not exist in `desktop-login.ts`. It lives in `account-bootstrap-google.ts:13-20` as `revealParentWindow`, called only from the `finally` of `bootstrapRemoteAuth` (`:44`). `bootstrapRemoteAccount` (`:48-51`) has no `parentWindow` parameter at all, so the device-registration path never refocuses CODRA. Threading one in requires a signature change to `RemoteHostControllerPort.activate` (`remote-ipc.ts:44`), whose handler (`remote-ipc.ts:255-261`) currently calls `authorize(event)` and discards the returned window.

Any such signature change must be applied in **three** places or typecheck breaks: `remote-bindings.d.ts:10-19` (the frozen contract for the `@codra/remote-account-bootstrap` Vite alias), `account-bootstrap-google.ts`, and `account-bootstrap-test-only.ts`.

There is **no `app.focus(...)` call anywhere** in `apps/` or `packages/`, so "application focus after completion" is entirely new. `account-bootstrap-google.ts:2` imports only `{ shell }` from `electron`; adding `app` requires extending the `vi.mock("electron", ...)` factory at `account-bootstrap-google.test.ts:19-21` or the test throws on the missing export. Two existing assertions — `expect(parentWindow.focus).toHaveBeenCalledOnce()` at `:77` and `:125` — require exactly one refocus, so a second refocus path fails them.

Files: `apps/desktop/src/main/remote/desktop-login.ts`, `account-bootstrap-google.ts`, `remote-bindings.d.ts`, `account-bootstrap-test-only.ts`, and their tests.

## B. Renderer-owned session approval

### Why this moves

`apps/desktop/src/main/index.ts:113-129` presents pending sessions through `dialog.showMessageBox`, a native macOS modal. Playwright cannot interact with native modals, so the single most security-critical step of the remote flow cannot be automated. Automating it is a precondition for D.

The move also closes three defects in the current prompt:

1. It identifies the requester only as `session.clientDeviceId.slice(0, 8)`. `RemoteDevice` carries a `displayName`, and `getSessionPeerDevice` can retrieve it, but the prompt fires from the Firestore session snapshot before any device lookup. A user with two Macs cannot tell which one is asking.
2. It is the only Korean string in the entire desktop application, and it is the security prompt. Every other desktop surface is English.
3. Approval is all-or-nothing. `host-controller.ts:444-447` defaults `approvedScopes` to `session.requestedScopes`, and the dialog only lists the raw scope strings. The scope-narrowing machinery already exists end to end — signing, `requireScope` enforcement in `host-control-gateway.ts` — but no surface drives it.

The severity of (3) is concrete: a peer granted `agent.launch` can run an unsandboxed agent anywhere on the host, because `host-control-gateway.ts:412-436` forwards the peer-supplied `agent` object including `yolo: true`, which resolves to `--dangerously-bypass-approvals-and-sandbox` for codex and `--dangerously-skip-permissions` for claude.

### Design

Pending sessions are pushed to the renderer and presented in a modal built on the existing `ModalDialog.tsx` (portal plus native `<dialog>`, already used for sign-in and agent launch).

The modal presents:

- the requesting device's `displayName`, with the truncated device id as secondary detail and as the fallback when the lookup fails;
- one row per requested scope, each independently deniable, defaulting to granted;
- an explicit statement that `agent.launch` permits running an agent on this Mac;
- `Approve` and `Deny` actions, with `Deny` as the default focus.

#### Resolving the requester name

`getSessionPeerDevice` cannot be used for this. `functions/src/index.ts:550-556` rejects any session whose status is not `approved`, `signaling`, or `connected` with `failed-precondition SESSION_NOT_CONNECTABLE`, and a pending session is `requested`. Every pre-approval lookup would fail and the modal would always render the fallback.

The name is resolved through `listHostDevices` instead, matching on `session.clientDeviceId`. The host device is permitted to call it (`assertRemoteClientKind`, `functions/src/auth.ts:53-59`, accepts `kind === "host"`), it needs no Functions change, and in the desktop-to-desktop flow the requester is by construction an online host device on the same account — `createRemoteSession` already rejects offline hosts. When the requester is absent from the listing, the modal falls back to the truncated device id.

Plumbing alone does not make the name useful: `host-controller.ts:379` and `desktop-login.ts:702` both register the hardcoded literal `"CODRA host"`, so two Macs are indistinguishable. Device registration must supply a real name derived from `os.hostname()`. Note that `DesktopLoginStartRequestSchema.displayName` (`remote.ts:111`) is part of `buildDesktopLoginStartSigningPayload`, so this changes a signed payload and both registration sites must change together.

#### Scope validation

`RemoteHostController.approveSession` already accepts and signs an `approvedScopes` value distinct from `requestedScopes`, but it performs no subset validation — it signs whatever array it is handed (`host-controller.ts:462, 476`). The subset rule lives only in `RemoteSessionSchema.superRefine` (`remote.ts:323-334`), which runs server-side. With the renderer now supplying the array, the main process validates `approvedScopes ⊆ session.requestedScopes` before signing; otherwise a bad value produces an opaque server-side Zod failure instead of a clear denial.

An empty `approvedScopes` must never be sent. `functions/src/index.ts:57` accepts it (`.max(16)` with no `.min(1)`), but `SessionApprovalSchema.approvedScopes` (`remote.ts:675`) is `.min(1)`, so `buildSessionApprovalSigningPayload` throws an unhandled `ZodError` and the callable returns a generic `internal`. Denying every scope routes to `rejectSession`, and the approve request schema enforces `.min(1).max(16)`.

#### Session retention

`approveSession` and `rejectSession` take a full `RemoteSession`, but IPC can only carry an id. `promptedSessions` is a bare `Set<string>` (`host-controller.ts:76`) and nothing retains the session object, so a `Map<string, RemoteSession>` is added and cleared in `stopHostResources` alongside the existing `clear()` at `:332`.

The existing de-duplication has a bug that the new map must not inherit: `promptedSessions.delete(...)` runs only after the awaited callable succeeds (`:480`, `:523`), so a transient network failure strands the id in the set and `onPendingSession` never fires again for that session until `deactivate()`. Cleanup moves to the error path as well.

### Contract additions

Following the established checklist in `packages/protocol/src/desktop-api.ts`:

- `codra:remote:pending-sessions` (push) — the current pending set, each entry carrying session id, requester display name, requester device id, requested scopes, and expiry.
- `codra:remote:approve-session` (invoke) — session id plus the approved scope subset.
- `codra:remote:reject-session` (invoke) — session id.

A fourth channel, `codra:remote:get-pending-sessions` (invoke), is required and is not optional — see "Windowless case".

All four are strict Zod schemas validated in both directions by the preload bridge, registered inside the `registrations` array of `main/ipc/remote-ipc.ts` with `authorize(event)` as the first statement of every handler.

Two facts about the existing tests shape this work. Nothing currently fails when a key is added to `IPC_CHANNELS` — `Object.keys/values/entries(IPC_CHANNELS)` appear nowhere in the repo, and `packages/protocol/test/desktop-api.test.ts:68-79` is a hand-maintained list of individual equality assertions. The freezing assertions must therefore be _written_, not inherited. The real forcing function is `pnpm typecheck`: adding members to `CodraDesktopApi` breaks the object literal in `apps/desktop/src/preload/desktop-api.ts`, and adding members to `RemoteHostControllerPort` breaks the hand-written fake at `apps/desktop/src/main/ipc/remote-ipc.test.ts:47-134`. Both `pnpm test` and `pnpm typecheck` belong in every verification step.

The push subscription must be folded into the composed unsubscribe closure at `remote-ipc.ts:297-301`. A subscription missing from that closure leaks across teardown and no existing test catches it, because `remote-ipc.test.ts` never asserts that a push stops firing after cleanup.

### Windowless case

On macOS, closing the CODRA window leaves the process running; the native dialog worked in that state. A renderer modal does not.

Push alone cannot cover this. `createWindow` resolving does not mean the renderer is listening — `apps/desktop/src/main/index.ts:57-65` has `ready-to-show` and `loadTrustedRenderer` as its only synchronization points and there is no renderer-ready handshake anywhere in the codebase, so pushing immediately after `await createWindow()` races. A renderer that mounts after the session arrived would also never learn about it.

The contract is therefore pull-on-mount plus push-on-change, matching how `remoteGetState` and `remoteGetAuthState` already bootstrap at `remote-ipc.ts:222-235`. When a pending session arrives with no live window, CODRA creates and shows the window; the renderer pulls the pending set on mount. If window creation fails — including the synchronous `"Renderer URL policy is not initialized"` throw at `index.ts:47-49` — the session is rejected rather than left hanging until expiry. Rejection can itself throw `REMOTE_HOST_NOT_STARTED` (`host-controller.ts:493-494`) and that must not escape.

Sessions expire silently. `subscribeSessions` (`packages/firebase/src/index.ts:262-277`) filters expired sessions out of the emitted array but emits no removal event, and the requester gives up after `APPROVAL_WAIT_MAX_MS = 2 * 60 * 1000` (`desktop-peer-connector.ts:44-45`). The push therefore carries the complete current set rather than appending, the renderer renders it idempotently, and each entry carries `expiresAt` so the modal can close itself.

### Where the logic lives

`apps/desktop/src/main/index.ts` imports `electron` at module scope, has no test file, and no electron mock is installed in `apps/desktop/test/setup.ts`. Nothing in it can have a failing test written first. All new approval logic — session retention, subset validation, window-ensure, reject-on-failure, and the auto-response seam — lives in a separate electron-free module with injected dependencies, following the pattern of `remote/auth-window.ts:49-65`. `index.ts` keeps only the wiring.

### Test seam

The remote-test build additionally exposes an auto-response seam so that `remote-reconnect` and `remote-agent-workspace` reach their subject matter without re-driving approval UI. `remote-direct` does not use the seam; it clicks the real modal.

## C. Two-device end-to-end harness

```
Playwright (workers: 1, fullyParallel: false)
  |
  +- emulator lifecycle
  |    build @codra/protocol, @codra/functions
  |    stage functions-deploy-build
  |    firebase emulators:start --only auth,firestore,functions
  |      (the --only is mandatory: hosting is skipped only when the
  |       firebase.json `hosting` key is absent, and it is present)
  |    probe readiness, tear down on exit
  |
  +- seed
  |    one email/password account in the Auth emulator
  |    both devices sign in as that account (remote requires same account)
  |
  +- Device A   electron out-remote-test/main/index.js
  |               env CODRA_USER_DATA_DIR=<tmpA>
  |                   CODRA_REMOTE_TEST_EMAIL / CODRA_REMOTE_TEST_PASSWORD
  |
  +- Device B   electron out-remote-test/main/index.js
                 env CODRA_USER_DATA_DIR=<tmpB>
```

The remote-test build variant already provides the necessary substitutions through Vite aliases in `apps/desktop/electron.remote-test.vite.config.ts`: `safe-storage-test-only` bypasses the Keychain, `account-bootstrap-test-only` signs in with email and password, and `firebase-emulator` points at `demo-codra`.

### Instance isolation

`startSingleInstanceApplication` (`single-instance.ts:39`) exits when `requestSingleInstanceLock()` fails, and the lock is keyed on the user-data directory. The isolation mechanism already exists: `CODRA_USER_DATA_DIR` (`apps/desktop/src/main/index.ts:38-44`) is applied at module scope, before the lock is requested, and three existing E2E tests already use it. `--user-data-dir` is _not_ used anywhere in this repository and must not be introduced.

**This was verified empirically before the spec was accepted**: two Electron processes launched against `apps/desktop/out/main/index.js` with distinct `CODRA_USER_DATA_DIR` values both remained alive. The harness rests on a measured fact, not an assumption.

Two constraints follow. The override is gated behind `(!app.isPackaged || process.env.CODRA_PACKAGED_SMOKE === "1")`, so a harness that launches a packaged build must also set `CODRA_PACKAGED_SMOKE=1` or both devices silently share the real userData directory. And `app.exit(0)` on lock failure is silent and returns success, so a failure to isolate manifests only as `firstWindow()` hanging until timeout — the harness asserts process liveness explicitly rather than waiting.

The launch environment also deletes `ELECTRON_RENDERER_URL`. `apps/desktop/src/main/index.ts:101` forwards it into the renderer URL policy, and the established launch pattern spreads `...process.env`, so a stale `electron-vite dev` shell would silently point both devices at a dev server.

### Process cleanup

`tests/e2e/process-cleanup.ts` handles exactly one root: its options are `{ rootPid?, knownDescendantPids: Set<number>, knownShellPid? }`, and `descendants` is computed as `[...knownDescendantPids].filter((pid) => pid !== rootPid)`. Two devices require two calls with two separate sets; sharing one set would make device A's root a SIGTERM target of device B's teardown and render failures unattributable.

`terminateCapturedProcessTree` throws when anything survives, from inside a `finally`, which masks the original test failure. With two devices this doubles the risk, so the harness catches per device and rethrows an aggregate after both have been attempted.

The harness is a Playwright fixture, not a shell script, so that emulator teardown is tied to test lifecycle and a crashed spec cannot leave orphaned emulator or Electron processes.

### Driving sign-in

The email/password button in `apps/desktop/src/renderer/src/account/SignInDialog.tsx:73-90` is hard-disabled and has no `onClick` — it never calls `onProvider("email_password")`, and the remote-test renderer build is byte-identical here. Sign-in cannot be driven through the UI in either flavor. The specs call `window.codra.remote.login("email_password")` through `page.evaluate`, which the protocol accepts (`packages/protocol/src/desktop-api.ts:74, 190`).

### TURN in the emulator

`functions/src/turn.ts:20` requires the `CLOUDFLARE_TURN_CONFIG` secret, and `packages/webrtc/src/ice.ts` rejects any TURN host that is not `cloudflare.com` or a subdomain (`TURN_HOST_UNSUPPORTED`). A local TURN server therefore cannot be substituted.

Two loopback peers connect on host candidates, so the harness skips TURN issuance in emulator mode rather than stubbing it. `normalizeHostIceServers` is called without `relayOnly`, avoiding `HOST_TURN_UDP_UNAVAILABLE`.

## D. End-to-end specs

Each becomes a project in `playwright.config.ts`. The config uses per-project `testMatch` with no default filter, so a spec file that is not registered as a project never runs.

| Spec                     | Proves                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote-direct`          | A signs in and activates, discovers B as an online host, requests a session; B's renderer approval modal appears, names the requester, and is clicked; the WebRTC session establishes and the in-band hello handshake passes. |
| `remote-reconnect`       | After connection, the transport is forcibly dropped; renegotiation succeeds and cursor continuity holds — no lost and no duplicated output across the break.                                                                  |
| `remote-agent-workspace` | A browses B's workspace, launches an agent on B, exchanges input, resize, and output; and no path, prompt, or terminal byte appears in any emulator Firestore document.                                                       |

The Firestore assertion in `remote-agent-workspace` is the one that protects the architecture's central privacy claim, and it is written as an exhaustive scan of the emulator's documents for the known prompt and path strings, not as a spot check of expected fields.

Each new project sets its own `timeout`. The global `timeout: 60_000` (`playwright.config.ts:9`) cannot cover a test that starts emulators, launches two Electron apps, signs both in, registers two devices, and negotiates WebRTC.

Each project is invoked by name. `package.json:26-27` currently defines `test:remote-direct` and `test:remote-reconnect` as positional path filters, which loads and evaluates every other project; they are rewritten to `--project=` to match the convention already used at `package.json:20-21`. `test:remote-agent-workspace` does not exist at all and is added.

## E. Client artifact scan

`scripts/scan-client-artifacts.mjs` is a standalone `node:assert` script matching the convention of the other five verification scripts. The `scan:client-artifacts` entry already exists at `package.json:33`; only the file is missing.

The rules must be written against measured reality, not intuition. The release bundles today already contain `demo-codra`, `http://127.0.0.1:9099`, `password-test-only`, and `remote-test` — in the desktop main, preload, and renderer output and in `apps/web/dist` — because `packages/protocol/src/deployment.ts` exports `emulatorDeployment` and its Zod literal schemas through the package barrel and neither bundler tree-shakes string literals out. A scanner that bans those tokens lands red on day one and gets disabled.

Rules that hold today, verified against current build output:

- absent everywhere: `CLOUDFLARE_TURN_CONFIG`, `CLOUDFLARE`, `private_key`, `BEGIN_PRIVATE_KEY`, `safe-storage-test-only`, `account-bootstrap-test-only`, `signInWithEmailAndPassword`, `CODRA_REMOTE_TEST_EMAIL`, `com.codra.desktop.remote-test`, `CODRA Remote Test`, `bearerToken`, `keyId`, `node-datachannel`, the developer home path, and `sourceMappingURL`;
- path-scoped: the public Firebase `apiKey` and bridge app id are legitimate in `apps/web/dist` and in the desktop **main** bundle, but must be absent from the desktop **renderer** and **preload**.

Two mechanical hazards. Substring matching produces false positives — `grep "turn:"` matches the token sequence `return: async () =>` in the renderer bundle, so TURN URL rules anchor on `/\bturns?:\/\//`. And the desktop renderer bundle is unminified while the web bundle is minified (`const DEMO_PROJECT_ID = "demo-codra"` versus `Fd="demo-codra"`), so a scanner that assumes one shape misses the other.

Scanner inputs are gitignored build output, so the scanner requires a prior `pnpm build` and fails with an explicit instruction rather than `ENOENT`, following `stage-functions-deploy.mjs:144-147`. Note that `pnpm build:remote-test` filters to `@codra/desktop` and does not build `apps/web`.

`docs/security/remote-baseline.json` is the intended rule input and is currently unused.

Adding `scan:client-artifacts` to the frozen script list in `scripts/verify-remote-build-config.mjs:146-162` is part of this piece; it is not there today.

## F. Configuration debt

| Item                                                                                                           | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build:release-candidate`, `verify:release-candidate`, `verify:remote-release`, `test:release-remote-disabled` | Delete from `package.json`. They reference files that do not exist and are not in this gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `__CODRA_BUILD_FLAVOR__`, `__CODRA_FIREBASE_PROJECT_ID__`, `__CODRA_FIREBASE_AUTH_EMULATOR_ORIGIN__`           | Declared in `apps/desktop/electron.remote-test.vite.config.ts:54-57` and `apps/web/vite.remote-test.config.ts:8-9`; no source reads any of them. The auth origin is additionally wrong — `http://127.0.0.1:5000` is the hosting port, while `deployment.ts:137` gives auth as `9099`. Remove all three. **Coupling:** `scripts/verify-remote-build-config.mjs` greps the config source text, and lines 76, 77, and 92 match _only_ these `define` values. Removing the defines without deleting those three assertions makes `pnpm verify:remote-build-config` fail — and it runs under `pnpm test` via `tests/remote-build-config.test.mjs`. The emulator project is already asserted through the `firebase-emulator.ts` alias at lines 75 and 88-91, so the three lines are deleted, not rewritten. This is a grep-based coupling; no type check will catch it.                                                            |
| `firebase.json` `auth.providers.emailPassword: true`                                                           | **Resolved: delete the `auth` block outright.** The empirical question the earlier draft posed has been answered. Two live `emulators:exec` runs, with and without the block, produced identical successful `accounts:signUp` responses, and `AgentProjectState.allowPasswordSignup` is a hardcoded `return true` at `node_modules/firebase-tools/lib/emulator/auth/state.js:461-463`. The Auth emulator does not read this configuration. The block only affects the production project, where `functions/src/auth.ts:28-34` rejects the `password` provider anyway, so it is pure exposed surface. Production provider configuration is recorded in the runbook (G) instead of in a deployable file. The separate-emulator-config fallback is struck. `scripts/verify-remote-build-config.mjs:125-144` reads only `firebaseConfig.emulators` and `firebaseConfig.hosting`, never `firebaseConfig.auth`, so nothing breaks. |
| `firebase.json` `hosting.public: apps/web/dist`                                                                | The remote-test web build emits to `dist-remote-test` (`apps/web/vite.remote-test.config.ts:6`), so the hosting emulator would serve the production bundle during remote testing. **Not fixed here.** The two-device harness is desktop-to-desktop and never loads the web app: both devices authenticate through `account-bootstrap-test-only` directly against the Auth emulator, and the hosting emulator is not started (see C). This is recorded as a known mismatch that must be resolved before any web-bridge test exists.                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/superpowers/specs/2026-08-02-agent-target-workspace-design.md:91-92`                                     | **Already done** in commit `17987db`. `pnpm format:check` now exits 0. Recorded so nobody hunts for a failure that no longer exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `.worktrees/`                                                                                                  | Not in `eslint.config.mjs` ignores, and flat config does not read `.gitignore`. Measured: `npx eslint . -f json` reports 307 files, 126 of them under `.worktrees/`. Add `"**/.worktrees/**"` to the ignores array at `eslint.config.mjs:6-13`. Prettier is unaffected — it reads `.gitignore`, which lists `.worktrees/` at line 9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/desktop/electron.remote-test.vite.config.ts:60`                                                          | The remote-test renderer build registers `plugins: [react()]` only, skipping the `codra-renderer-csp` plugin that `electron.vite.config.ts:46-56` uses to substitute `__CODRA_CONNECT_SRC__`. Confirmed on disk: `out-remote-test/renderer/index.html` ships the placeholder verbatim while `out/renderer/index.html` ships `connect-src 'none'`. An unparseable source expression matches nothing, so behavior is likely unchanged, but the tested build and the shipped build differ in their CSP. Fix the divergence so the harness exercises the real header.                                                                                                                                                                                                                                                                                                                                                            |

## G. Rollout

Deploy only the Firebase surfaces this work changes, to the explicit project, after the full local and emulator gate passes. Then write `docs/runbooks/remote-access.md` covering desktop login, host activation, device registration, session approval, and the operational checks that the emulator cannot cover.

`README.md` is corrected in the same change. It currently states that CODRA "does not require an account or login" and that Firebase and WebRTC are "deferred to a future phase," which has been false for roughly seventy commits.

## Deliberate limitations

These are recorded rather than fixed, so that the next person does not mistake them for oversights:

- **TURN relay is not covered by the harness.** Loopback peers use host candidates, and `ice.ts` will not accept a non-Cloudflare TURN host. Relay behavior is verified manually after live deployment.
- **App Check remains disabled.** `deployment.ts` pins `authAppCheckEnforcement` to `false` and no `initializeAppCheck` call exists. Every callable remains reachable by any client holding a valid token.
- **Firestore rules remain untested.** `packages/firebase`'s `test:rules` is `vitest run --passWithNoTests` with no rules test importing `@firebase/rules-unit-testing`, which is installed. Closing this is worthwhile and cheap, but it is a separate piece of work with its own CI requirement (a JDK step).
- **`desktop-peer-connector.ts` has no unit tests** despite being 468 lines and owning session creation, approval verification, peer binding, and both negotiation paths. The end-to-end specs will exercise it, which is weaker than unit coverage but better than the current zero.

## Verification gate

Every command must exit zero. Commands that do not exist yet are created by this work; no command in this list is aspirational.

```bash
# repository
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:e2e

# remote
pnpm build:remote-test
pnpm test:remote-direct
pnpm test:remote-reconnect
pnpm test:remote-agent-workspace

# artifacts and configuration
pnpm verify:native-package
pnpm verify:remote-build-config
pnpm verify:firebase-indexes
pnpm scan:client-artifacts
```

Prerequisites: macOS for the Electron and packaging steps; a JDK for the Firestore emulator; `pnpm install --frozen-lockfile` for the `node-pty` helper mode fix applied by `postinstall`.

Note for anyone capturing exit codes in this repository's shell: zsh does not populate `${PIPESTATUS[0]}`. Redirect to a file and read `$?`, or use `$pipestatus[1]`.

## Self-review checklist

- Every file path referenced above exists, or is explicitly created by this design.
- Every behavior change begins with a failing test.
- Protocol additions are strict and size-bounded.
- The renderer receives no privileged object.
- Remote failures never fall back to local execution.
- Firebase carries signaling only.
- The callback page exposes no token and loads no remote asset.
- Scope narrowing is driven by a real surface, not defaulted.
- Deliberate limitations are recorded rather than silently carried.

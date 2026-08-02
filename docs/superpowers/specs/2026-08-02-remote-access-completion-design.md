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

**Constraint:** `desktop-login.test.ts:510` asserts by grep that `desktop-login.ts` contains neither `BrowserWindow` nor `signInWithPopup`. The loopback system-browser flow must be preserved; no embedded user-agent may be introduced.

Files: `apps/desktop/src/main/remote/desktop-login.ts`, `account-bootstrap-google.ts`, and their tests.

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

- the requesting device's `displayName`, resolved through `getSessionPeerDevice`, with the truncated device id as secondary detail and as the fallback when the lookup fails;
- one row per requested scope, each independently deniable, defaulting to granted;
- an explicit statement that `agent.launch` permits running an agent on this Mac;
- `Approve` and `Deny` actions, with `Deny` as the default focus.

Approval sends the selected scope subset. `RemoteHostController.approveSession` already accepts and signs an `approvedScopes` value distinct from `requestedScopes`; only the caller changes.

### Contract additions

Following the established checklist in `packages/protocol/src/desktop-api.ts`:

- `codra:remote:pending-sessions` (push) — the current pending set, each entry carrying session id, requester display name, requester device id, requested scopes, and expiry.
- `codra:remote:approve-session` (invoke) — session id plus the approved scope subset.
- `codra:remote:reject-session` (invoke) — session id.

All three are strict Zod schemas validated in both directions by the preload bridge, registered in `main/ipc/remote-ipc.ts` with `authorize(event)` as the first statement of every handler, and frozen by an assertion in `packages/protocol/test/desktop-api.test.ts`.

### Windowless case

On macOS, closing the CODRA window leaves the process running; the native dialog worked in that state. A renderer modal does not. When a pending session arrives with no live window, CODRA creates and shows the window before presenting the modal. If window creation fails, the session is rejected rather than silently approved or left hanging until expiry.

### Test seam

The remote-test build additionally exposes an auto-response seam so that `remote-reconnect` and `remote-agent-workspace` reach their subject matter without re-driving approval UI. `remote-direct` does not use the seam; it clicks the real modal.

## C. Two-device end-to-end harness

```
Playwright (workers: 1, fullyParallel: false)
  |
  +- emulator lifecycle
  |    build @codra/protocol, @codra/functions
  |    stage functions-deploy-build
  |    start Auth (9099), Firestore (8080), Functions (5001) on demo-codra
  |    hosting is NOT started: the harness is desktop-to-desktop
  |    probe readiness, tear down on exit
  |
  +- seed
  |    one email/password account in the Auth emulator
  |    both devices sign in as that account (remote requires same account)
  |
  +- Device A   electron out-remote-test/main --user-data-dir=<tmpA>
  |               env CODRA_REMOTE_TEST_EMAIL / CODRA_REMOTE_TEST_PASSWORD
  |
  +- Device B   electron out-remote-test/main --user-data-dir=<tmpB>
```

The remote-test build variant already provides the necessary substitutions through Vite aliases in `apps/desktop/electron.remote-test.vite.config.ts`: `safe-storage-test-only` bypasses the Keychain, `account-bootstrap-test-only` signs in with email and password, and `firebase-emulator` points at `demo-codra`.

`startSingleInstanceApplication` (`single-instance.ts:39`) exits when `requestSingleInstanceLock()` fails. The lock is keyed on the user-data directory, so distinct `--user-data-dir` values allow two concurrent instances. This is verified as the first step of the harness work, before any spec is written against it, because the harness has no fallback if it does not hold.

The harness is a Playwright fixture, not a shell script, so that emulator teardown is tied to test lifecycle and a crashed spec cannot leave orphaned emulator or Electron processes.

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

## E. Client artifact scan

`scripts/scan-client-artifacts.mjs` is a standalone `node:assert` script matching the convention of the other five verification scripts. It asserts that shipped client bundles — the desktop renderer and preload output and the web `dist` — contain no Cloudflare credential, no Firebase private material, no workspace path constant, and no prompt or terminal payload. `docs/security/remote-baseline.json` exists as an input for exactly this scanner and is currently unused.

It is added to `package.json` as `scan:client-artifacts` and is part of the completion gate.

## F. Configuration debt

| Item                                                                                                           | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build:release-candidate`, `verify:release-candidate`, `verify:remote-release`, `test:release-remote-disabled` | Delete from `package.json`. They reference files that do not exist and are not in this gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `__CODRA_BUILD_FLAVOR__`, `__CODRA_FIREBASE_PROJECT_ID__`, `__CODRA_FIREBASE_AUTH_EMULATOR_ORIGIN__`           | Declared in `apps/desktop/electron.remote-test.vite.config.ts:54-57` and `apps/web/vite.remote-test.config.ts:8-9`; no source reads any of them. The auth origin is additionally wrong — `http://127.0.0.1:5000` is the hosting port, while `deployment.ts:137` gives auth as `9099`. Remove all three.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `firebase.json` `auth.providers.emailPassword: true`                                                           | The remote-test harness signs in with email and password against the Auth emulator (`deployment.ts:141`), but `auth` is Identity Platform _deploy_ configuration, so the same flag enables self-signup on the production project — where `functions/src/auth.ts:28-34` rejects the `password` provider outright. **Resolution procedure:** first determine empirically whether the Auth emulator reads this block at all. The expected answer is that it does not, since the emulator accepts email/password signups regardless of deploy configuration. If confirmed, delete the `auth` block from `firebase.json` and record production provider configuration in the runbook (G) instead of in a deployable file. Only if the emulator turns out to depend on it, move the block into a separate emulator-only config passed through the existing `--config` argument of `pnpm firebase:emulators`. |
| `firebase.json` `hosting.public: apps/web/dist`                                                                | The remote-test web build emits to `dist-remote-test` (`apps/web/vite.remote-test.config.ts:6`), so the hosting emulator would serve the production bundle during remote testing. **Not fixed here.** The two-device harness is desktop-to-desktop and never loads the web app: both devices authenticate through `account-bootstrap-test-only` directly against the Auth emulator, and the hosting emulator is not started (see C). This is recorded as a known mismatch that must be resolved before any web-bridge test exists.                                                                                                                                                                                                                                                                                                                                                                     |
| `docs/superpowers/specs/2026-08-02-agent-target-workspace-design.md:91-92`                                     | `pnpm format:check` fails on this file, which makes CI red at its sixth step. Fix first; it costs one command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `.worktrees/`                                                                                                  | Not in `eslint.config.mjs` ignores, and flat config does not read `.gitignore`. 126 of 307 linted files come from three abandoned branch checkouts. Add the ignore.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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

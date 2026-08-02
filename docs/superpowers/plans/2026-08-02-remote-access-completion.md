# CODRA Remote Access Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take remote access from "code exists but nothing has ever exercised it end to end" to "proven on two devices and deployed live," so the next phase — agent orchestration — does not leave a half-built subsystem behind.

**Architecture:** Session approval moves out of a native `dialog.showMessageBox` and into the renderer, which is what makes the flow automatable and simultaneously fixes three defects in the prompt (it cannot identify the requester, it is the app's only Korean string, and it cannot narrow scopes although the machinery exists end to end). A two-device Playwright harness then drives two isolated Electron instances against Firebase emulators and proves discovery, approval, negotiation, reconnection, remote agent launch, and the privacy claim that no path, prompt, or terminal byte reaches Firestore.

**Tech Stack:** Electron 43, React 19, TypeScript 5.9, Zod 4, Firebase 12, node-datachannel 0.32, Vitest, Testing Library, Playwright 1.62, pnpm 11.5.2, Node 22.

**Design:** `docs/superpowers/specs/2026-08-02-remote-access-completion-design.md`

**Supersedes:** Tasks 8 and 9 of `docs/superpowers/plans/2026-08-02-agent-target-workspace.md`. Tasks 1–7 of that plan are complete through commit `4142a1c`.

## Design coverage

Every piece of the design maps to at least one task. Checked by walking the design section by section.

| Design piece                        | Tasks               |
| ----------------------------------- | ------------------- |
| A — Browser sign-in completion      | 2, 16               |
| B — Renderer-owned session approval | 3, 4, 5, 6, 7, 8, 9 |
| C — Two-device end-to-end harness   | 11                  |
| D — End-to-end specs                | 12, 13, 14          |
| E — Client artifact scan            | 10                  |
| F — Configuration debt              | 1                   |
| G — Rollout, runbook, README        | 15                  |

Two design items inside Piece F are already done and are not tasks: the Prettier failure was fixed in commit `17987db`, and the `firebase.json` `auth` question was answered empirically before the design was finalized (the Auth emulator never reads that block), so Task 1 deletes it outright rather than running a decision procedure.

## Global Constraints

Every task's requirements implicitly include this section.

- **Platform:** macOS for anything launching Electron. Node `>=22.22.0`, pnpm exactly `11.5.2` (`packageManager`). A JDK is required for the Firestore emulator; Auth and Functions do not need one.
- **Every behavior change starts with a failing test.** Write the test, run it, watch it fail with the expected message, then implement.
- **Run `pnpm typecheck` as well as `pnpm test`.** `apps/desktop/tsconfig.json` covers `src/main/**/*.ts` and `src/preload/**/*.ts`, which includes co-located `.test.ts` files, but `apps/desktop`'s `test` script is bare `vitest run`. Several changes in this plan break only the type check — extending `CodraDesktopApi` breaks the preload object literal, and extending `RemoteHostControllerPort` breaks the hand-written fake at `remote-ipc.test.ts:47-134`.
- **Every new Zod schema is `.strict()`, every string `.max(...)`, every array `.max(...)`.** Precedent: `packages/protocol/test/desktop-api.test.ts:36-38`.
- **`authorize(event)` is the first statement of every IPC handler**, before any payload parsing. All 12 existing handlers do this. The thrown message is literally `"Unauthorized terminal IPC sender"` even on remote channels (`renderer-authorization.ts:39`) — do not "fix" the wording; `remote-ipc.test.ts:274` asserts the string.
- **New IPC handlers go inside the `registrations` array** of `remote-ipc.ts`; the disposer at `:309` iterates it. **New push subscriptions go into the composed unsubscribe closure at `remote-ipc.ts:297-301`** or they leak across teardown, and no existing test catches that.
- **The renderer never receives a privileged object.** No Firebase, WebRTC, Node, or filesystem module is importable from `apps/desktop/src/renderer`.
- **Remote failures never fall back to local execution.**
- **Firebase carries signaling only.** No path, prompt, runtime catalog, or terminal byte is ever written to Firestore.
- **`CODRA_USER_DATA_DIR`, never `--user-data-dir`.** The env var exists (`apps/desktop/src/main/index.ts:38-44`), is applied before the single-instance lock is requested, and is already used by three E2E tests. Two concurrent instances with distinct values were verified empirically to both survive. `--user-data-dir` appears nowhere in this repository and must not be introduced.
- **Prettier settles formatting.** Config is `{ trailingComma: "all" }` with the default 80-column width. Run `pnpm format:check` before every commit; it currently passes and must keep passing.
- **zsh does not populate `${PIPESTATUS[0]}`.** To capture an exit code through a pipe, redirect to a file and read `$?`, or use `$pipestatus[1]`.

## Execution order

Tasks are numbered in dependency order with two exceptions worth stating.

**Task 16 completes design Piece A** and depends only on Task 2. It carries a high number because Task 2's drafter scoped it out, not because it comes last; execute it directly after Task 2 if you prefer to finish the sign-in surface in one sitting. It also touches `RemoteHostControllerPort` and the `remote-ipc.test.ts` fake, so if you defer it past Task 7 you will edit those two files twice.

**Tasks 1 and 10 are independent** of everything else and can be done at any point.

The natural sequence:

```
1  config debt          (no dependencies)
2  callback page        (no dependencies)
16 refocus plumbing     (needs 2)
3  protocol contracts
4  preload bridge       (needs 3)
5  approval registry    (needs 3)
6  host-controller      (needs 5)
7  remote-ipc           (needs 3, 6)
8  approval dialog      (needs 3)
9  App wiring           (needs 4, 7, 8)
10 artifact scanner     (no dependencies)
11 two-device harness   (needs 9)
12 remote-direct        (needs 11)
13 remote-reconnect     (needs 11)
14 remote-agent-workspace (needs 11)
15 rollout and runbook  (needs everything)
```

## Completion gate

Every command must exit zero. No command in this list is aspirational — each either exists today or is created by a task in this plan.

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:e2e

pnpm build:remote-test
pnpm test:remote-direct
pnpm test:remote-reconnect
pnpm test:remote-agent-workspace

pnpm verify:native-package
pnpm verify:remote-build-config
pnpm verify:firebase-indexes
pnpm scan:client-artifacts
```

## Deliberate limitations

Recorded so a later reader does not mistake them for oversights. All four are carried forward from the design.

- **TURN relay is not covered.** Loopback peers use host candidates, and `packages/webrtc/src/ice.ts` rejects any TURN host that is not `cloudflare.com` or a subdomain, so a local TURN server cannot be substituted. Relay behavior is verified manually after live deployment.
- **App Check stays disabled.** `deployment.ts` pins `authAppCheckEnforcement` to `false` and no `initializeAppCheck` call exists.
- **Firestore rules stay untested.** `packages/firebase`'s `test:rules` is `vitest run --passWithNoTests` and nothing imports the installed `@firebase/rules-unit-testing`. Worth closing, but it is separate work needing its own CI JDK step.
- **`desktop-peer-connector.ts` gets no unit tests** despite being 468 lines and owning session creation, approval verification, peer binding, and both negotiation paths. Tasks 12–14 exercise it end to end, which is weaker than unit coverage but better than the current zero.

---

### Task 1: Configuration debt cleanup (design Piece F)

**Files:**

- Modify: `eslint.config.mjs:6-13`
- Modify: `package.json:21-22`, `package.json:34-35`
- Modify: `apps/desktop/electron.remote-test.vite.config.ts:1-63`
- Modify: `apps/web/vite.remote-test.config.ts:7-10`
- Modify: `scripts/verify-remote-build-config.mjs:76-77`, `scripts/verify-remote-build-config.mjs:92`
- Modify: `firebase.json:2-15`
- Modify: `apps/desktop/electron.vite.config.ts:47-60`
- Modify: `apps/desktop/tsconfig.node.json:6-10`
- Create: `apps/desktop/renderer-csp-plugin.ts`
- Test: none — this task changes no behavior. Its forcing functions are `pnpm verify:remote-build-config` (grep-based, no type check catches it), `pnpm typecheck`, and the byte content of `out-remote-test/renderer/index.html`.

**Interfaces:**

- Consumes: nothing from earlier tasks. This is the first task and touches no source that later tasks depend on for types.
- Produces:
  - `export function codraRendererCspPlugin(command: ConfigEnv["command"]): Plugin` in `apps/desktop/renderer-csp-plugin.ts` — the single definition of the `codra-renderer-csp` plugin, imported by both `electron.vite.config.ts` and `electron.remote-test.vite.config.ts`. The two-device harness (Piece C) relies on `out-remote-test/renderer/index.html` shipping `connect-src 'none'`, identical to `out/renderer/index.html`.
  - `apps/desktop/electron.remote-test.vite.config.ts` becomes the **function form** `defineConfig(({ command }) => ({ ... }))`. Any later task editing that file must preserve the arrow-function wrapper and the closing `}));`.
  - `scripts/verify-remote-build-config.mjs` loses three `requireText` lines. The frozen-script array at `:146-162` is **not** touched by this task — adding `scan:client-artifacts` to it belongs to Piece E.
  - `package.json` loses four scripts. It does **not** gain `test:remote-agent-workspace` and the `test:remote-direct` / `test:remote-reconnect` entries are **not** rewritten to `--project=` here; both belong to the Piece D task.

---

- [ ] **Step 1: Record the baseline so every edit has a measurable before**

Run all four, in the repo root:

```bash
npx eslint . -f json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('total',r.length,'worktrees',r.filter(x=>x.filePath.includes('/.worktrees/')).length)})"
grep -o "connect-src [^;]*" apps/desktop/out-remote-test/renderer/index.html
grep -o "connect-src [^;]*" apps/desktop/out/renderer/index.html
node scripts/verify-remote-build-config.mjs; echo "exit=$?"
```

Expected, exactly:

```
total 307 worktrees 126
connect-src __CODRA_CONNECT_SRC__
connect-src 'none'
exit=0
```

If `out-remote-test/renderer/index.html` does not exist, run `pnpm build:remote-test` first. That divergence — placeholder in the tested build, substituted value in the shipped build — is the defect Step 7 fixes.

---

- [ ] **Step 2: Add `.worktrees` to the ESLint ignores**

`eslint.config.mjs:6-13` before:

```js
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/out-remote-test/**",
      "**/dist/**",
      "**/dist-remote-test/**",
      "**/functions-deploy-build/**",
    ],
```

after:

```js
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/out-remote-test/**",
      "**/dist/**",
      "**/dist-remote-test/**",
      "**/functions-deploy-build/**",
      "**/.worktrees/**",
    ],
```

ESLint flat config does not read `.gitignore`, which is why this entry is needed. Prettier is unaffected — it reads `.gitignore`, and `.gitignore:9` already lists `.worktrees/`.

---

- [ ] **Step 3: Delete the four ghost scripts from root `package.json`**

Delete `package.json:21-22`:

```json
    "build:release-candidate": "node scripts/build-codra-release-candidate.mjs",
    "verify:release-candidate": "node scripts/verify-codra-release-candidate.mjs",
```

and `package.json:34-35`:

```json
    "test:release-remote-disabled": "playwright test tests/e2e/release-remote-disabled.spec.ts",
    "verify:remote-release": "node scripts/verify-remote-release.mjs",
```

All four reference files that do not exist on disk (`scripts/build-codra-release-candidate.mjs`, `scripts/verify-codra-release-candidate.mjs`, `tests/e2e/release-remote-disabled.spec.ts`, `scripts/verify-remote-release.mjs`). None of the four appears in the frozen script list at `scripts/verify-remote-build-config.mjs:146-162`, which freezes exactly nine names — verified — so this deletion is safe on its own. Do not touch `scan:client-artifacts` at `package.json:33`; it is already wired and only its script file is missing.

---

- [ ] **Step 4: Delete the three dead defines from the desktop remote-test Vite config**

`apps/desktop/electron.remote-test.vite.config.ts:51-62` before:

```ts
  renderer: {
    build: { outDir: `${remoteTestOutput}/renderer` },
    define: {
      __CODRA_BUILD_FLAVOR__: JSON.stringify("remote-test"),
      __CODRA_FIREBASE_PROJECT_ID__: JSON.stringify("demo-codra"),
      __CODRA_FIREBASE_AUTH_EMULATOR_ORIGIN__: JSON.stringify(
        "http://127.0.0.1:5000",
      ),
    },
    plugins: [react()],
    resolve: { alias: {} },
  },
```

after:

```ts
  renderer: {
    build: { outDir: `${remoteTestOutput}/renderer` },
    plugins: [react()],
    resolve: { alias: {} },
  },
```

A repo-wide grep of `apps packages functions scripts tests` for all three identifiers returns only the two config files — five hits, all definition sites, zero reads. `__CODRA_FIREBASE_AUTH_EMULATOR_ORIGIN__` is additionally wrong: `http://127.0.0.1:5000` is the hosting origin (`packages/protocol/src/deployment.ts:140`), while auth is `9099` (`deployment.ts:137`).

Do not run any verification yet — the repo is knowingly broken until Step 6.

---

- [ ] **Step 5: Delete the two dead defines from the web remote-test Vite config**

`apps/web/vite.remote-test.config.ts:5-11` before:

```ts
export default defineConfig({
  build: { outDir: "dist-remote-test" },
  define: {
    __CODRA_BUILD_FLAVOR__: JSON.stringify("remote-test"),
    __CODRA_FIREBASE_PROJECT_ID__: JSON.stringify("demo-codra"),
  },
  plugins: [react()],
```

after:

```ts
export default defineConfig({
  build: { outDir: "dist-remote-test" },
  plugins: [react()],
```

---

- [ ] **Step 6: Delete the three now-orphaned grep assertions that matched only those defines**

This is the grep-based coupling the design calls out; nothing in the type system catches it. `scripts/verify-remote-build-config.mjs:75-78` before:

```js
requireText(remoteVite, "firebase-emulator.ts", "remote-test Vite config");
requireText(remoteVite, '"demo-codra"', "remote-test Vite config");
requireText(remoteVite, '"http://127.0.0.1:5000"', "remote-test Vite config");
requireText(remoteVite, "out-remote-test", "remote-test Vite config");
```

after:

```js
requireText(remoteVite, "firebase-emulator.ts", "remote-test Vite config");
requireText(remoteVite, "out-remote-test", "remote-test Vite config");
```

`scripts/verify-remote-build-config.mjs:87-92` before:

```js
requireText(
  webRemoteVite,
  "firebase-emulator.ts",
  "web remote-test Vite config",
);
requireText(webRemoteVite, '"demo-codra"', "web remote-test Vite config");
```

after:

```js
requireText(
  webRemoteVite,
  "firebase-emulator.ts",
  "web remote-test Vite config",
);
```

The three deleted lines are not rewritten. The emulator project is already asserted through the `firebase-emulator.ts` alias at `:75` and `:87-91`, which survives.

Run: `node scripts/verify-remote-build-config.mjs; echo "exit=$?"`
Expected: `exit=0` (this is the first point since Step 4 at which it can pass).

---

- [ ] **Step 7: Delete the `auth` block from `firebase.json`**

`firebase.json:1-16` before:

```json
{
  "auth": {
    "providers": {
      "emailPassword": true,
      "googleSignIn": {
        "oAuthBrandDisplayName": "CODRA",
        "supportEmail": "wicklim90@gmail.com",
        "authorizedRedirectUris": [
          "http://127.0.0.1",
          "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
          "https://codra-1b3bb.web.app/__/auth/handler"
        ]
      }
    }
  },
  "functions": {
```

after:

```json
{
  "functions": {
```

The Auth emulator never reads this block — `AgentProjectState.allowPasswordSignup` is a hardcoded `return true` at `node_modules/firebase-tools/lib/emulator/auth/state.js:461-463`, and the only `AuthEmulator` construction site (`node_modules/firebase-tools/lib/emulator/controller.js:559-569`) passes four arguments, none of them `options.config.src.auth`. `node_modules/firebase-tools/lib/filterTargets.js:6-9` picks deploy targets purely by key presence, so leaving it means a bare `firebase deploy` provisions email/password self-signup on `codra-1b3bb`. `scripts/verify-remote-build-config.mjs:125-144` reads only `firebaseConfig.emulators` and `firebaseConfig.hosting`, never `firebaseConfig.auth` — verified — so nothing breaks. Production provider configuration is recorded in the runbook (Piece G) instead.

---

- [ ] **Step 8: Extract the renderer CSP plugin into one shared definition**

Create `apps/desktop/renderer-csp-plugin.ts`:

```ts
import type { ConfigEnv, Plugin } from "vite";

export function codraRendererCspPlugin(command: ConfigEnv["command"]): Plugin {
  return {
    name: "codra-renderer-csp",
    transformIndexHtml(html) {
      const connectSource = command === "serve" ? "'self' ws: wss:" : "'none'";
      return html.replace("__CODRA_CONNECT_SRC__", connectSource);
    },
  };
}
```

Add it to `apps/desktop/tsconfig.node.json:6-10` so it is a checked root, not merely a transitively-imported file. Before:

```json
  "include": [
    "electron.vite.config.ts",
    "electron.remote-test.vite.config.ts",
    "vitest.config.ts"
  ]
```

after:

```json
  "include": [
    "electron.vite.config.ts",
    "renderer-csp-plugin.ts",
    "electron.remote-test.vite.config.ts",
    "vitest.config.ts"
  ]
```

---

- [ ] **Step 9: Point both renderer builds at the shared plugin**

`apps/desktop/electron.vite.config.ts:1-3` before:

```ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
```

after:

```ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { codraRendererCspPlugin } from "./renderer-csp-plugin";
```

`apps/desktop/electron.vite.config.ts:47-60` before:

```ts
  renderer: {
    resolve: { alias: {} },
    plugins: [
      react(),
      {
        name: "codra-renderer-csp",
        transformIndexHtml(html) {
          const connectSource =
            command === "serve" ? "'self' ws: wss:" : "'none'";
          return html.replace("__CODRA_CONNECT_SRC__", connectSource);
        },
      },
    ],
  },
```

after:

```ts
  renderer: {
    resolve: { alias: {} },
    plugins: [react(), codraRendererCspPlugin(command)],
  },
```

`apps/desktop/electron.remote-test.vite.config.ts:1-3` before:

```ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
```

after:

```ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { codraRendererCspPlugin } from "./renderer-csp-plugin";
```

`apps/desktop/electron.remote-test.vite.config.ts:7` before:

```ts
export default defineConfig({
```

after:

```ts
export default defineConfig(({ command }) => ({
```

`apps/desktop/electron.remote-test.vite.config.ts:51-63` (post–Step 4 state) before:

```ts
  renderer: {
    build: { outDir: `${remoteTestOutput}/renderer` },
    plugins: [react()],
    resolve: { alias: {} },
  },
});
```

after:

```ts
  renderer: {
    build: { outDir: `${remoteTestOutput}/renderer` },
    plugins: [react(), codraRendererCspPlugin(command)],
    resolve: { alias: {} },
  },
}));
```

`electron-vite@5`'s `defineConfig` accepts `ElectronViteConfigFnObject = (env: ConfigEnv) => UserConfig` (`node_modules/.pnpm/electron-vite@5.0.0_*/node_modules/electron-vite/dist/index.d.ts:104,116`), so the function form is a supported overload; `ConfigEnv` is re-exported from `vite`, which is why `codraRendererCspPlugin` takes `ConfigEnv["command"]` and not a hand-written union.

---

- [ ] **Step 10: Run the full verification for this task**

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm verify:remote-build-config
pnpm build:remote-test
grep -o "connect-src [^;]*" apps/desktop/out-remote-test/renderer/index.html
npx eslint . -f json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('worktrees',r.filter(x=>x.filePath.includes('/.worktrees/')).length)})"
```

Expected: every command exits 0; the grep prints `connect-src 'none'` (it printed `connect-src __CODRA_CONNECT_SRC__` in Step 1); the eslint probe prints `worktrees 0` (it printed `126` in Step 1).

`pnpm test` is not a forcing function for this task — the root package is not a pnpm workspace member (`pnpm-workspace.yaml` lists `apps/*`, `packages/*`, `functions`), so `pnpm -r --if-present test` never reaches `tests/remote-build-config.test.mjs`. `pnpm verify:remote-build-config` must therefore be run explicitly, which is why it appears above.

---

- [ ] **Step 11: Commit**

```bash
git add eslint.config.mjs package.json firebase.json \
  apps/desktop/electron.vite.config.ts \
  apps/desktop/electron.remote-test.vite.config.ts \
  apps/desktop/renderer-csp-plugin.ts \
  apps/desktop/tsconfig.node.json \
  apps/web/vite.remote-test.config.ts \
  scripts/verify-remote-build-config.mjs
git commit -m "chore: retire remote build configuration debt"
```

The Vite `define` deletions and the three `verify-remote-build-config.mjs` assertion deletions must land in this one commit; splitting them leaves `pnpm verify:remote-build-config` red at an intermediate commit.

---

---

### Task 2: Loopback sign-in completion page (design Piece A)

**Files:**

- Modify: `apps/desktop/src/main/remote/desktop-login.ts:37-38` (replace the two HTML constants), `apps/desktop/src/main/remote/desktop-login.ts:294-338` (both 200 paths)
- Test: `apps/desktop/src/main/remote/desktop-login.test.ts:2` (import), `:34-53` (new helpers after `request`), `:359` (new tests after the cancellation test)

**Interfaces:**

- Consumes:
  - `export async function createDesktopLoginCallbackListener(options: { attemptId: string; state: string; timeoutMs?: number; port?: number }): Promise<DesktopLoginCallbackListener>` — `desktop-login.ts:262-267`. **This signature is unchanged by this task.** The listener receives no `DesktopLoginDependencies`, so the nonce uses the `randomBytes` already imported from `node:crypto` at `desktop-login.ts:1`, not `dependencies.randomBytes`.
  - `export function encodeBase64Url(value: Uint8Array): string` — already imported at `desktop-login.ts:21` from `@codra/protocol`. `encodeBase64Url(randomBytes(16))` yields exactly 22 unpadded base64url characters (verified: `packages/protocol/src/remote-signing.ts:26-32` strips `=`), all within the CSP `base64-value` grammar.
  - `export interface DesktopLoginCallbackListener { port: number; waitForCallback(): Promise<DesktopLoginCallback>; close(): Promise<void>; }` — `desktop-login.ts:100-104`, unchanged.
- Produces (module-private to `desktop-login.ts`; nothing new is exported, so no other file's types move):
  - `type CallbackPageVariant = "complete" | "cancelled"`
  - `function callbackContentSecurityPolicy(nonce: string): string`
  - `function renderCallbackPage(variant: CallbackPageVariant, nonce: string): string`
  - `function sendCallbackPage(response: ServerResponse, variant: CallbackPageVariant, onFinish: () => void): void` — the single serving path for **both** 200 responses, which is what makes "served identically" structural rather than a copy that can drift.
  - In the test file: `interface CapturedPage { status: number; headers: IncomingHttpHeaders; body: string }`, `function requestPage(url: string): Promise<CapturedPage>`, and `async function captureCallbackPage(query: string): Promise<CapturedPage>`. These are the HTTP helpers the design says do not exist; the existing `request` helper at `:34-53` calls `response.resume()` and returns only a status code, so it cannot express any of these assertions. A later task needing header or body assertions on this server reuses `requestPage`.
- **Explicitly left to the separate refocus-plumbing task** (owned by another drafter — do not implement any of it here):
  - extending `revealParentWindow` (`account-bootstrap-google.ts:13-20`) with application-level `app.focus(...)`, including widening the `vi.mock("electron", ...)` factory at `account-bootstrap-google.test.ts:19-21`;
  - adding a `parentWindow` parameter to `bootstrapRemoteAccount` (`account-bootstrap-google.ts:48-51`), which requires the same change in `remote-bindings.d.ts:16-19` and `account-bootstrap-test-only.ts:25-28` or typecheck breaks;
  - the `RemoteHostControllerPort.activate` signature change at `remote-ipc.ts:44` plus its handler at `remote-ipc.ts:255-261`, and threading the window through `host-controller.ts` `startInternal` (`:341`, calls at `:354` and `:364`).

  Consequence for this task, stated so it is not mistaken for an oversight: the page's `window.close()` attempt fires on load and is not sequenced after CODRA regains focus. The design's "after the CODRA window is focused" ordering becomes true once the refocus task lands; nothing in this task's page needs to change for that, because the two happen in different processes.

---

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/main/remote/desktop-login.test.ts`, change line 2 from:

```ts
import { request as httpRequest } from "node:http";
```

to:

```ts
import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
```

Add these two module-scope constants immediately after line 28 (`const code = ...`):

```ts
const CALLBACK_CSP_PATTERN =
  /^default-src 'none'; style-src 'nonce-[\w-]{22}'; script-src 'nonce-[\w-]{22}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'$/u;
const CALLBACK_NONCE_PATTERN = /style-src 'nonce-([\w-]{22})'/u;
```

Add these three declarations immediately after the existing `request` helper (after line 53):

```ts
interface CapturedPage {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function requestPage(url: string): Promise<CapturedPage> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const call = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    call.once("error", reject);
    call.end();
  });
}

async function captureCallbackPage(query: string): Promise<CapturedPage> {
  const listener = await createDesktopLoginCallbackListener({
    attemptId,
    state,
    port: 0,
    timeoutMs: 2_000,
  });
  try {
    const page = requestPage(callbackTarget(listener.port, query));
    await listener.waitForCallback().catch(() => undefined);
    return await page;
  } finally {
    await listener.close();
  }
}
```

Add these two tests immediately after the existing `"settles a Google access-denied callback as an immediate cancellation"` test (after line 359):

```ts
it("serves a nonce-bound completion page that loads no subresource", async () => {
  const page = await captureCallbackPage(`?code=${code}&state=${state}`);

  expect(page.status).toBe(200);
  const csp = String(page.headers["content-security-policy"]);
  expect(csp).toMatch(CALLBACK_CSP_PATTERN);
  const nonce = CALLBACK_NONCE_PATTERN.exec(csp)?.[1];
  expect(nonce).toBeDefined();
  expect(page.body).toContain(`<style nonce="${nonce}">`);
  expect(page.body).toContain(`<script nonce="${nonce}">`);
  expect(page.body).toContain("Return to CODRA");
  expect(page.body).not.toMatch(/<link|\ssrc=|\shref=|@import/u);
  expect(page.body).not.toContain(code);
  expect(page.body).not.toContain(state);
  expect(page.body).not.toContain(attemptId);
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(page.headers["referrer-policy"]).toBe("no-referrer");
  expect(page.headers["x-content-type-options"]).toBe("nosniff");
});

it("protects the cancellation page identically with a per-response nonce", async () => {
  const cancelled = await captureCallbackPage(
    "?error=access_denied&state=opaque-google-state",
  );
  const completed = await captureCallbackPage(`?code=${code}&state=${state}`);

  expect(cancelled.status).toBe(200);
  expect(cancelled.body).toContain("Sign-in was cancelled.");
  expect(cancelled.body).toContain("Return to CODRA");
  expect(String(cancelled.headers["content-security-policy"])).toMatch(
    CALLBACK_CSP_PATTERN,
  );
  expect(cancelled.headers["cache-control"]).toBe("no-store");
  expect(cancelled.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(cancelled.headers["referrer-policy"]).toBe("no-referrer");
  expect(cancelled.headers["x-content-type-options"]).toBe("nosniff");
  expect(cancelled.headers["content-security-policy"]).not.toBe(
    completed.headers["content-security-policy"],
  );
});
```

Three details that are load-bearing. `String(page.headers[...])` rather than a raw assertion keeps this typecheck-clean against `IncomingHttpHeaders`' `string | string[] | undefined` and still fails loudly (`"undefined"` does not match the pattern). `captureCallbackPage` fires `requestPage` before awaiting `waitForCallback`, mirroring the existing test at `:324-333`, because the callback promise only settles from the response's `finish` event. The `.catch(() => undefined)` is required for the cancellation query, which rejects with `DESKTOP_LOGIN_CANCELLED`.

---

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/desktop-login.test.ts`

Expected: FAIL — 2 failed, 18 passed. The first failure is in `"serves a nonce-bound completion page that loads no subresource"`:

```
AssertionError: expected 'undefined' to match /^default-src 'none'; style-src 'nonce…/
```

because `desktop-login.ts:327-332` sets exactly four headers and no `Content-Security-Policy`.

---

- [ ] **Step 3: Implement the page**

Replace `apps/desktop/src/main/remote/desktop-login.ts:37-38`. Before:

```ts
const CALLBACK_SUCCESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>CODRA sign-in complete</title></head><body><p>You can return to CODRA.</p></body></html>`;
const CALLBACK_CANCELLED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>CODRA sign-in cancelled</title></head><body><p>Sign-in was cancelled. You can return to CODRA.</p></body></html>`;
```

after:

```ts
const CALLBACK_PAGE_TEXT = {
  complete: {
    title: "CODRA sign-in complete",
    heading: "Signed in",
    detail: "You can return to CODRA.",
  },
  cancelled: {
    title: "CODRA sign-in cancelled",
    heading: "Sign-in cancelled",
    detail: "Sign-in was cancelled. You can return to CODRA.",
  },
} as const;

type CallbackPageVariant = keyof typeof CALLBACK_PAGE_TEXT;

const CALLBACK_PAGE_STYLE = `:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 -apple-system,system-ui,sans-serif}main{max-width:26rem;padding:2rem;text-align:center}h1{margin:0 0 .5rem;font-size:1.25rem}p{margin:0 0 1.5rem;opacity:.8}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.5rem;background:#2f6feb;color:#fff;cursor:pointer}#hint{margin:1rem 0 0;font-size:.875rem}#hint[hidden]{display:none}`;

const CALLBACK_PAGE_SCRIPT = `(function(){var button=document.getElementById("return");var hint=document.getElementById("hint");function finish(){window.close();window.setTimeout(function(){if(!window.closed)hint.hidden=false;},400);}button.addEventListener("click",finish);finish();})();`;

function callbackContentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
}

function renderCallbackPage(
  variant: CallbackPageVariant,
  nonce: string,
): string {
  const text = CALLBACK_PAGE_TEXT[variant];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text.title}</title><style nonce="${nonce}">${CALLBACK_PAGE_STYLE}</style></head><body><main><h1>${text.heading}</h1><p>${text.detail}</p><button id="return" type="button">Return to CODRA</button><p id="hint" hidden>Close this tab manually if it stays open.</p></main><script nonce="${nonce}">${CALLBACK_PAGE_SCRIPT}</script></body></html>`;
}
```

Only fixed literals reach the page — no token, session identifier, or account detail. `default-src 'none'` plus the absence of `img-src` and `connect-src` grants is deliberate: once `settled` is true every further request gets `409` (`desktop-login.ts:296-299`) and the server is tearing down, so any same-origin subresource would fail anyway. The rendered page is 1239 bytes and references nothing external. Verified against the grep assertion at `desktop-login.test.ts:510-518`: none of `BrowserWindow`, `BrowserView`, `webview`, `signInWithPopup`, `signInWithRedirect` appears in this text — note the hint string deliberately says "tab", not any of those tokens.

---

- [ ] **Step 4: Implement the shared 200 response path**

Add this function to `apps/desktop/src/main/remote/desktop-login.ts` immediately after `sendLoopbackError` (after line 249):

```ts
function sendCallbackPage(
  response: ServerResponse,
  variant: CallbackPageVariant,
  onFinish: () => void,
): void {
  const nonce = encodeBase64Url(randomBytes(16));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": callbackContentSecurityPolicy(nonce),
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.once("finish", onFinish);
  response.end(renderCallbackPage(variant, nonce));
}
```

Then rewrite the two 200 branches. `desktop-login.ts:300-315` before:

```ts
if (isDesktopLoginCancellation(request, { port })) {
  settled = true;
  if (timeoutRef.current) clearTimeout(timeoutRef.current);
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.once("finish", () => {
    rejectCallback(new Error("DESKTOP_LOGIN_CANCELLED"));
    void close();
  });
  response.end(CALLBACK_CANCELLED_HTML);
  return;
}
```

after:

```ts
if (isDesktopLoginCancellation(request, { port })) {
  settled = true;
  if (timeoutRef.current) clearTimeout(timeoutRef.current);
  sendCallbackPage(response, "cancelled", () => {
    rejectCallback(new Error("DESKTOP_LOGIN_CANCELLED"));
    void close();
  });
  return;
}
```

`desktop-login.ts:325-337` before:

```ts
settled = true;
if (timeoutRef.current) clearTimeout(timeoutRef.current);
response.writeHead(200, {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
response.once("finish", () => {
  resolveCallback(accepted);
  void close();
});
response.end(CALLBACK_SUCCESS_HTML);
```

after:

```ts
settled = true;
if (timeoutRef.current) clearTimeout(timeoutRef.current);
sendCallbackPage(response, "complete", () => {
  resolveCallback(accepted);
  void close();
});
```

The `settled = true` → `clearTimeout` → `writeHead` → `once("finish")` → `end` ordering is preserved exactly; `sendCallbackPage` only relocates the last three, and the caller still owns the first two. That ordering is what keeps `closeServer` (`:251-260`, which calls `socket.destroy()` on every tracked socket before `server.close()`) from truncating the response. Do not move `void close()` out of the `finish` callback. `sendLoopbackError` (`:242-249`) is untouched — the 400/405/409 paths keep their `text/plain` header set.

---

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/desktop-login.test.ts`
Expected: PASS — 20 passed (18 pre-existing plus the 2 new). The pre-existing grep test `"has no embedded browser or Firebase web redirect implementation"` must still be among the passes; it is the one that reads the raw source text including the new HTML.

---

- [ ] **Step 6: Run the repository gates**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: all four exit 0. `pnpm typecheck` matters independently of `pnpm test` here: `apps/desktop/tsconfig.json` sets `noUnusedLocals` via `tsconfig.base.json`, so a leftover `CALLBACK_SUCCESS_HTML` or `CALLBACK_CANCELLED_HTML` after Step 3 fails typecheck while the tests still pass.

---

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/remote/desktop-login.ts \
  apps/desktop/src/main/remote/desktop-login.test.ts
git commit -m "feat(remote): complete browser sign-in with a nonce-bound callback page"
```

---

### Task 3: Protocol contracts for pending-session approval

**Files:**

- Modify: `packages/protocol/src/desktop-api.ts:110-199`
- Test: `packages/protocol/test/desktop-api.test.ts:2-79`

**Interfaces:**

- Consumes: nothing — this is the root of the dependency chain.
- Produces (all VERBATIM from CONTRACT.md §1-3):
  - `IPC_CHANNELS.remoteGetPendingSessions = "codra:remote:get-pending-sessions"`
  - `IPC_CHANNELS.remoteApproveSession = "codra:remote:approve-session"`
  - `IPC_CHANNELS.remoteRejectSession = "codra:remote:reject-session"`
  - `IPC_CHANNELS.remotePendingSessions = "codra:remote:pending-sessions"`
  - `PendingRemoteSessionSchema` / `type PendingRemoteSession`
  - `PendingRemoteSessionListSchema`
  - `ApproveRemoteSessionRequestSchema` / `type ApproveRemoteSessionRequest`
  - `RejectRemoteSessionRequestSchema` / `type RejectRemoteSessionRequest`
  - `CodraDesktopApi["remote"]`: `getPendingSessions(): Promise<PendingRemoteSession[]>`, `approveSession(request: ApproveRemoteSessionRequest): Promise<void>`, `rejectSession(request: RejectRemoteSessionRequest): Promise<void>`, `onPendingSessionsChanged(listener: (sessions: PendingRemoteSession[]) => void): () => void`

> **Why the tests must be written, not inherited.** `Object.keys/values/entries(IPC_CHANNELS)` appear nowhere in the repo. `packages/protocol/test/desktop-api.test.ts:68-79` — the `it("freezes remote action and event channel names")` block — is a hand-maintained list of individual equality assertions. Adding a key to `IPC_CHANNELS` breaks nothing on its own. Steps 1 and 5 below write the assertions that make it break.

- [ ] **Step 1: Write the failing channel-freeze assertions**

Extend the existing `it("freezes remote action and event channel names", ...)` block. Insert these four assertions immediately after `expect(IPC_CHANNELS.remoteLogout).toBe("codra:remote:logout");` at `packages/protocol/test/desktop-api.test.ts:78`, before the closing `});` at line 79. Do not create a new `it` block — extend this one, so the remote group stays frozen in one place.

```ts
expect(IPC_CHANNELS.remoteGetPendingSessions).toBe(
  "codra:remote:get-pending-sessions",
);
expect(IPC_CHANNELS.remoteApproveSession).toBe("codra:remote:approve-session");
expect(IPC_CHANNELS.remoteRejectSession).toBe("codra:remote:reject-session");
expect(IPC_CHANNELS.remotePendingSessions).toBe(
  "codra:remote:pending-sessions",
);
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @codra/protocol test`

Expected: FAIL with

```
FAIL  test/desktop-api.test.ts > desktop remote IPC contract > freezes remote action and event channel names
AssertionError: expected undefined to be 'codra:remote:get-pending-sessions' // Object.is equality
```

- [ ] **Step 3: Add the four channel keys**

In `packages/protocol/src/desktop-api.ts`, append to `IPC_CHANNELS` after `remoteAuthState: "codra:remote:auth-state",` (line 139) and before `} as const;` (line 140). Order is fixed by CONTRACT.md §2: the three invoke channels first, the push channel last.

```ts
  remoteGetPendingSessions: "codra:remote:get-pending-sessions",
  remoteApproveSession: "codra:remote:approve-session",
  remoteRejectSession: "codra:remote:reject-session",
  remotePendingSessions: "codra:remote:pending-sessions",
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @codra/protocol test`

Expected: PASS

- [ ] **Step 5: Write the failing schema test**

Two edits to `packages/protocol/test/desktop-api.test.ts`.

First, extend the import block at lines 2-16 (imports are alphabetised):

```ts
import {
  AgentTargetConnectRequestSchema,
  AgentTargetRuntimeRequestSchema,
  AgentSetupResultSchema,
  ApproveRemoteSessionRequestSchema,
  IPC_CHANNELS,
  PendingRemoteSessionListSchema,
  PendingRemoteSessionSchema,
  RejectRemoteSessionRequestSchema,
  RemoteAccountProfileSchema,
  RemoteAccountStateSchema,
  RemoteAccountStatusSchema,
  RemoteAuthProviderSchema,
  RemoteHostStateSchema,
  RemoteHostStatusSchema,
  WorkspaceListRequestSchema,
  WorkspaceTargetRequestSchema,
  WorkspaceValidateRequestSchema,
} from "../src/desktop-api";
```

Second, add a new `it` block directly after the freeze block's closing `});` (which is line 79 before Step 1, line 95 after it), mirroring the happy-path-then-`.toThrow()` template at `packages/protocol/test/desktop-api.test.ts:106-135`:

```ts
it("bounds the pending session approval payloads", () => {
  const pending = {
    sessionId: "3f5f0a02-27b0-4a04-9a2f-6cb2f5d6a111",
    clientDeviceId: "7c9f1d33-4b62-4f0e-9f4c-1c0b7d2a2222",
    requesterDisplayName: "Studio Mac",
    requestedScopes: ["workspace.read", "agent.launch"],
    expiresAt: 1_785_000_000_000,
  };

  expect(PendingRemoteSessionSchema.parse(pending)).toEqual(pending);
  expect(PendingRemoteSessionListSchema.parse([pending])).toEqual([pending]);
  expect(
    ApproveRemoteSessionRequestSchema.parse({
      sessionId: pending.sessionId,
      approvedScopes: ["workspace.read"],
    }),
  ).toEqual({
    sessionId: pending.sessionId,
    approvedScopes: ["workspace.read"],
  });
  expect(
    RejectRemoteSessionRequestSchema.parse({ sessionId: pending.sessionId }),
  ).toEqual({ sessionId: pending.sessionId });
  expect(() =>
    PendingRemoteSessionSchema.parse({ ...pending, ownerUid: "leak" }),
  ).toThrow();
  expect(() =>
    PendingRemoteSessionSchema.parse({ ...pending, requestedScopes: [] }),
  ).toThrow();
  expect(() =>
    PendingRemoteSessionListSchema.parse(
      Array.from({ length: 51 }, () => pending),
    ),
  ).toThrow();
  expect(() =>
    ApproveRemoteSessionRequestSchema.parse({
      sessionId: pending.sessionId,
      approvedScopes: [],
    }),
  ).toThrow();
  expect(() =>
    RejectRemoteSessionRequestSchema.parse({
      sessionId: pending.sessionId,
      rejectionReason: "USER_REJECTED",
    }),
  ).toThrow();
});
```

The five `.toThrow()` cases are the security-load-bearing ones: `.strict()` rejects an `ownerUid` leak, `requestedScopes` cannot be empty, the list is capped at 50, `approvedScopes` cannot be empty (an empty array reaches `SessionApprovalSchema.approvedScopes` at `packages/protocol/src/remote.ts:675`, which is `.min(1)`, and throws an unhandled `ZodError` server-side), and the reject request carries nothing but a session id.

- [ ] **Step 6: Run the test and watch it fail**

Run: `pnpm --filter @codra/protocol test`

Expected: FAIL with

```
FAIL  test/desktop-api.test.ts > desktop remote IPC contract > bounds the pending session approval payloads
TypeError: Cannot read properties of undefined (reading 'parse')
```

- [ ] **Step 7: Add the three schemas**

In `packages/protocol/src/desktop-api.ts`, insert after `export type RemoteAccountStatus = z.infer<typeof RemoteAccountStatusSchema>;` (line 110) and before `export const IPC_CHANNELS = {` (line 112). Bounds are inlined because the helpers in `packages/protocol/src/remote.ts:39-45` are module-private and not exported.

```ts
export const PendingRemoteSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    clientDeviceId: z.string().uuid(),
    requesterDisplayName: z.string().min(1).max(200).optional(),
    requestedScopes: z.array(z.string().min(1).max(80)).min(1).max(16),
    expiresAt: z.number().int().nonnegative().safe(),
  })
  .strict();
export type PendingRemoteSession = z.infer<typeof PendingRemoteSessionSchema>;

export const PendingRemoteSessionListSchema = z
  .array(PendingRemoteSessionSchema)
  .max(50);

export const ApproveRemoteSessionRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    approvedScopes: z.array(z.string().min(1).max(80)).min(1).max(16),
  })
  .strict();
export type ApproveRemoteSessionRequest = z.infer<
  typeof ApproveRemoteSessionRequestSchema
>;

export const RejectRemoteSessionRequestSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type RejectRemoteSessionRequest = z.infer<
  typeof RejectRemoteSessionRequestSchema
>;
```

`.max(50)` is written inline rather than importing `PENDING_SESSION_LIMIT` from `packages/protocol/src/remote.ts:35`, per CONTRACT.md §1 — importing it would create a `desktop-api.ts` → `remote.ts` edge that has not been reviewed.

- [ ] **Step 8: Run the test and watch it pass**

Run: `pnpm --filter @codra/protocol test`

Expected: PASS — `Test Files 5 passed (5)`, `Tests 36 passed (36)`

- [ ] **Step 9: Add the four `CodraDesktopApi.remote` members**

In `packages/protocol/src/desktop-api.ts`, insert into the `remote` namespace after `onAuthStateChanged` (lines 195-197) and before the closing `};` at line 198:

```ts
    getPendingSessions(): Promise<PendingRemoteSession[]>;
    approveSession(request: ApproveRemoteSessionRequest): Promise<void>;
    rejectSession(request: RejectRemoteSessionRequest): Promise<void>;
    onPendingSessionsChanged(
      listener: (sessions: PendingRemoteSession[]) => void,
    ): () => void;
```

- [ ] **Step 10: Confirm the protocol is green and the desktop typecheck is the new red**

Run: `pnpm --filter @codra/protocol test && pnpm --filter @codra/protocol typecheck`

Expected: PASS

Run: `pnpm --filter @codra/desktop typecheck`

Expected: FAIL with

```
src/preload/desktop-api.ts(201,5): error TS2739: Type '{ getState(): ... }' is missing the following properties from type '{ ... }': getPendingSessions, approveSession, rejectSession, onPendingSessionsChanged
```

This is the failing test for Task 4 — do not fix it here. Record it and move on.

- [ ] **Step 11: Commit**

```bash
git add packages/protocol/src/desktop-api.ts packages/protocol/test/desktop-api.test.ts
git commit -m "feat(protocol): freeze pending remote session approval contracts"
```

---

---

### Task 4: Preload bridge for the pending-session channels

**Files:**

- Modify: `apps/desktop/src/preload/desktop-api.ts:1-29` (imports) and `:201-253` (the `remote` object literal)
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx:210`
- Modify: `apps/desktop/src/renderer/src/terminal/useTerminals.test.tsx:70`
- Test: `apps/desktop/src/preload/desktop-api.test.ts`

**Interfaces:**

- Consumes (from Task 3): `IPC_CHANNELS.remoteGetPendingSessions`, `IPC_CHANNELS.remoteApproveSession`, `IPC_CHANNELS.remoteRejectSession`, `IPC_CHANNELS.remotePendingSessions`, `PendingRemoteSessionListSchema`, `ApproveRemoteSessionRequestSchema`, `RejectRemoteSessionRequestSchema`, `type PendingRemoteSession`, and the four `CodraDesktopApi["remote"]` members.
- Produces: `createDesktopApi(ipc: IpcRendererLike): CodraDesktopApi` now satisfies the grown interface. The main-process task consumes the wire shapes this establishes: `remoteGetPendingSessions` invoked with **no argument** and answering a `PendingRemoteSession[]`; `remoteApproveSession` / `remoteRejectSession` invoked with **one parsed request object** and answering `undefined`; `remotePendingSessions` pushed as a **complete `PendingRemoteSession[]`**, never a delta.

> **How to not break the three existing full-log assertions.** `apps/desktop/src/preload/desktop-api.test.ts:201` asserts `ipc.invocations.slice(-6)` — a fixed-width window over the tail of the log. Adding `getPendingSessions`/`approveSession`/`rejectSession` calls to that test after line 187 would leave the assertion silently checking the wrong six entries; adding them before would fail it confusingly. Three other tests assert the full log with `toEqual([...])` at `:130-152`, `:234-258`, `:300-302` and `:322-327`. **Do not touch any of those five tests.** Every new test below builds its own `FakeIpcRenderer`, so its `ipc.invocations` is a fresh log that can be asserted whole — which is stronger than a slice. Insert all four new `it` blocks between the closing `});` of `"routes account login and host activation independently"` (line 209) and the opening of `it("routes every terminal invocation through its frozen channel", ...)` (line 211).

- [ ] **Step 1: Add the shared fixture and type import**

Two edits to `apps/desktop/src/preload/desktop-api.test.ts`.

Extend the import at lines 2-8:

```ts
import {
  IPC_CHANNELS,
  type AgentLaunchTarget,
  type PendingRemoteSession,
  type RemoteAccountStatus,
  type RemoteHostStatus,
  type TerminalDescriptor,
} from "@codra/protocol";
```

Insert the fixture after `const terminalId = "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5";` (line 43) and before `const descriptor: TerminalDescriptor = {` (line 45), matching the file's existing module-level fixture placement:

```ts
const pendingSession: PendingRemoteSession = {
  sessionId: "3f5f0a02-27b0-4a04-9a2f-6cb2f5d6a111",
  clientDeviceId: "7c9f1d33-4b62-4f0e-9f4c-1c0b7d2a2222",
  requesterDisplayName: "Studio Mac",
  requestedScopes: ["workspace.read", "agent.launch"],
  expiresAt: 1_785_000_000_000,
};
```

- [ ] **Step 2: Write the four failing tests**

Insert all four blocks after line 209 (the `});` closing `"routes account login and host activation independently"`), before `it("routes every terminal invocation through its frozen channel", ...)`.

```ts
it("routes pending session approval through its own channels", async () => {
  const ipc = new FakeIpcRenderer(
    new Map<string, unknown>([
      [IPC_CHANNELS.remoteGetPendingSessions, [pendingSession]],
    ]),
  );
  const api = createDesktopApi(ipc);
  const received: PendingRemoteSession[][] = [];
  api.remote.onPendingSessionsChanged((sessions) => received.push(sessions));

  await expect(api.remote.getPendingSessions()).resolves.toEqual([
    pendingSession,
  ]);
  await expect(
    api.remote.approveSession({
      sessionId: pendingSession.sessionId,
      approvedScopes: ["workspace.read"],
    }),
  ).resolves.toBeUndefined();
  await expect(
    api.remote.rejectSession({ sessionId: pendingSession.sessionId }),
  ).resolves.toBeUndefined();
  ipc.emit(IPC_CHANNELS.remotePendingSessions, [
    { ...pendingSession, requestedScopes: [] },
  ]);
  ipc.emit(IPC_CHANNELS.remotePendingSessions, [pendingSession]);
  ipc.emit(IPC_CHANNELS.remotePendingSessions, []);

  expect(received).toEqual([[pendingSession], []]);
  expect(ipc.invocations).toEqual([
    { channel: IPC_CHANNELS.remoteGetPendingSessions, args: [] },
    {
      channel: IPC_CHANNELS.remoteApproveSession,
      args: [
        {
          sessionId: pendingSession.sessionId,
          approvedScopes: ["workspace.read"],
        },
      ],
    },
    {
      channel: IPC_CHANNELS.remoteRejectSession,
      args: [{ sessionId: pendingSession.sessionId }],
    },
  ]);
});

it("keeps invalid approval requests off the IPC bridge", async () => {
  const ipc = new FakeIpcRenderer();
  const api = createDesktopApi(ipc);

  await expect(
    api.remote.approveSession({
      sessionId: pendingSession.sessionId,
      approvedScopes: [],
    }),
  ).rejects.toThrow();
  await expect(
    api.remote.rejectSession({ sessionId: "not-a-session-id" }),
  ).rejects.toThrow();

  expect(ipc.invocations).toEqual([]);
});

it("rejects a non-undefined approval response", async () => {
  const ipc = new FakeIpcRenderer(
    new Map<string, unknown>([
      [IPC_CHANNELS.remoteApproveSession, "unexpected"],
    ]),
  );

  await expect(
    createDesktopApi(ipc).remote.approveSession({
      sessionId: pendingSession.sessionId,
      approvedScopes: ["workspace.read"],
    }),
  ).rejects.toThrow("Expected IPC mutation response to be undefined");
});

it("unsubscribes only its pending session listener wrapper", () => {
  const ipc = new FakeIpcRenderer();
  const api = createDesktopApi(ipc);
  const first: PendingRemoteSession[][] = [];
  const second: PendingRemoteSession[][] = [];
  const stopFirst = api.remote.onPendingSessionsChanged((sessions) =>
    first.push(sessions),
  );
  api.remote.onPendingSessionsChanged((sessions) => second.push(sessions));

  stopFirst();
  ipc.emit(IPC_CHANNELS.remotePendingSessions, [pendingSession]);

  expect(first).toEqual([]);
  expect(second).toEqual([[pendingSession]]);
});
```

What each one pins down:

1. **`routes pending session approval…`** — request/response validation on all three invokes, plus `safeParse`-and-drop on the push. The first emit carries `requestedScopes: []`, which `PendingRemoteSessionSchema` rejects; `received` must not contain it. The empty array in the third emit must be forwarded, because the push carries the complete current set and an empty set is how the modal learns to close.
2. **`keeps invalid approval requests…`** — `Schema.parse` runs _before_ `ipc.invoke`, so a bad request never reaches main. This is the `it.each` pattern at `:344-379` (`expect(ipc.invocations).toEqual([])`) applied to the new channels.
3. **`rejects a non-undefined approval response`** — proves `assertUndefinedResponse` guards the two `Promise<void>` mutations, mirroring `:411-434`.
4. **`unsubscribes only its pending session listener wrapper`** — the unsubscribe closure must pass `wrapped` to `ipc.removeListener`, not the caller's `listener`. Passing the caller's function is a no-op against the `Set<Listener>` in `FakeIpcRenderer` and this test catches it. Mirrors `:476-489`.

- [ ] **Step 3: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/preload/desktop-api.test.ts`

Expected: FAIL — `Tests 4 failed | 20 passed (24)`, the first being

```
FAIL  |node| src/preload/desktop-api.test.ts > createDesktopApi > routes pending session approval through its own channels
TypeError: api.remote.onPendingSessionsChanged is not a function
```

The other three fail the same way on `api.remote.approveSession` / `api.remote.onPendingSessionsChanged`.

- [ ] **Step 4: Implement the four bridge members**

Two edits to `apps/desktop/src/preload/desktop-api.ts`.

Extend the import block (lines 1-29) — the list is alphabetised:

```ts
  AgentTargetRuntimeRequestSchema,
  ApproveRemoteSessionRequestSchema,
  ChooseTerminalCwdRequestSchema,
  ChooseTerminalCwdResultSchema,
  CreateTerminalRequestSchema,
  IPC_CHANNELS,
  PendingRemoteSessionListSchema,
  RejectRemoteSessionRequestSchema,
  RemoteAccountStatusSchema,
```

Then append to the `remote` object literal, after the closing `},` of `onAuthStateChanged` (line 252) and before the `},` that closes `remote` (line 253):

```ts
      async getPendingSessions() {
        return PendingRemoteSessionListSchema.parse(
          await ipc.invoke(IPC_CHANNELS.remoteGetPendingSessions),
        );
      },
      async approveSession(request) {
        assertUndefinedResponse(
          await ipc.invoke(
            IPC_CHANNELS.remoteApproveSession,
            ApproveRemoteSessionRequestSchema.parse(request),
          ),
        );
      },
      async rejectSession(request) {
        assertUndefinedResponse(
          await ipc.invoke(
            IPC_CHANNELS.remoteRejectSession,
            RejectRemoteSessionRequestSchema.parse(request),
          ),
        );
      },
      onPendingSessionsChanged(listener) {
        const wrapped: IpcListener = (_event, payload) => {
          const parsed = PendingRemoteSessionListSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data);
        };

        ipc.on(IPC_CHANNELS.remotePendingSessions, wrapped);
        return () =>
          ipc.removeListener(IPC_CHANNELS.remotePendingSessions, wrapped);
      },
```

Four idioms this copies, each load-bearing:

- `getPendingSessions` parses the **response** with `PendingRemoteSessionListSchema.parse` — same shape as `getState` at `:202-206`. No argument is passed to `ipc.invoke`, so `args` is `[]`.
- `approveSession` / `rejectSession` parse the **request** before `ipc.invoke` and wrap the result in `assertUndefinedResponse` — the `Promise<void>` mutation convention from `terminal.write` at `:146-153`.
- `onPendingSessionsChanged` uses `safeParse`, never `parse`. A malformed push must be dropped silently: `parse` would throw inside an Electron IPC event listener, which is a real defect, not a style choice. Only `parsed.data` reaches the listener, never the raw payload.
- The returned closure captures `wrapped` and hands that exact reference to `ipc.removeListener`, matching `onStateChanged` at `:235-243`. Use the single-line `if (parsed.success) listener(parsed.data);` form — that is the style of all three existing agent/remote subscriptions.

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/preload/desktop-api.test.ts`

Expected: PASS — `Test Files 1 passed (1)`, `Tests 24 passed (24)`

- [ ] **Step 6: Run the desktop typecheck and watch the renderer fakes fail**

Run: `pnpm --filter @codra/desktop typecheck`

Expected: FAIL with exactly two errors — the preload error from Task 3 Step 10 is now gone, and two renderer test fakes surface in its place:

```
src/renderer/src/terminal/TerminalSidebar.test.tsx(195,5): error TS2739: Type '{ getState: Mock<Procedure>; ... }' is missing the following properties from type '{ ... }': getPendingSessions, approveSession, rejectSession, onPendingSessionsChanged
src/renderer/src/terminal/useTerminals.test.tsx(59,5): error TS2739: Type '{ getState: Mock<Procedure>; ... }' is missing the following properties from type '{ ... }': getPendingSessions, approveSession, rejectSession, onPendingSessionsChanged
```

These two hand-written `window.codra` fakes are not mentioned in the IPC reference report, and they do **not** fail under `pnpm test` — vitest transpiles without typechecking, so all 262 desktop tests pass while `tsc -p tsconfig.web.json` is red. This is exactly why both commands belong in the verification.

- [ ] **Step 7: Add the four members to both renderer fakes**

In `apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx`, insert after `onAuthStateChanged: vi.fn(() => vi.fn()),` at line 210:

```ts
      getPendingSessions: vi.fn().mockResolvedValue([]),
      approveSession: vi.fn().mockResolvedValue(undefined),
      rejectSession: vi.fn().mockResolvedValue(undefined),
      onPendingSessionsChanged: vi.fn(() => vi.fn()),
```

In `apps/desktop/src/renderer/src/terminal/useTerminals.test.tsx`, insert the identical four lines after `onAuthStateChanged: vi.fn(() => vi.fn()),` at line 70.

`getPendingSessions` resolves `[]` rather than a fixture on purpose: neither of these two suites exercises approval, and an empty pull keeps their behaviour unchanged.

- [ ] **Step 8: Run the full verification**

Run: `pnpm test && pnpm typecheck`

Expected: PASS — `apps/desktop test: Tests 262 passed (262)` grows to 266, `packages/protocol test: Tests 36 passed (36)`, and every `typecheck` line reports `Done`.

Run: `npx prettier --check apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/desktop-api.test.ts apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx apps/desktop/src/renderer/src/terminal/useTerminals.test.tsx`

Expected: PASS — `All matched files use Prettier code style!` (every block above is already prettier-formatted; the repo gates on `pnpm format:check`)

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/desktop-api.test.ts apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx apps/desktop/src/renderer/src/terminal/useTerminals.test.tsx
git commit -m "feat(desktop): bridge pending remote session approval to the renderer"
```

---

### Task 5: SessionApprovalRegistry

**Files:**

- Create: `apps/desktop/src/main/remote/session-approval.ts`
- Test: `apps/desktop/src/main/remote/session-approval.test.ts`

**Interfaces:**

- Consumes (from Task 1, `packages/protocol/src/desktop-api.ts`): `PendingRemoteSessionListSchema`, `type PendingRemoteSession`, `type ApproveRemoteSessionRequest`, `type RejectRemoteSessionRequest`; plus `type RemoteSession` from `packages/protocol/src/remote.ts:297`.
- Produces (CONTRACT §5, verbatim): `SessionApprovalDependencies`, `SessionApprovalRegistry` with `handlePending`, `list`, `approve`, `reject`, `onChanged`, `clear`. Thrown strings: `"REMOTE_SESSION_NOT_PENDING"`, `"REMOTE_SCOPES_NOT_REQUESTED"`.

This module is electron-free by construction (it imports only `@codra/protocol`), which is the reason it exists — `apps/desktop/src/main/index.ts:1` imports `electron` at module scope and `apps/desktop/test/setup.ts` installs no electron mock.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/remote/session-approval.test.ts
import { describe, expect, it, vi } from "vitest";
import type { PendingRemoteSession, RemoteSession } from "@codra/protocol";
import {
  SessionApprovalRegistry,
  type SessionApprovalDependencies,
} from "./session-approval";

const SESSION_ID = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";
const CLIENT_DEVICE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function pendingSession(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    sessionId: SESSION_ID,
    ownerUid: "uid-1",
    clientDeviceId: CLIENT_DEVICE_ID,
    hostDeviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    clientKeyThumbprint: "client-thumbprint",
    hostKeyThumbprint: "host-thumbprint",
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 1,
    protocolVersion: 1,
    requestedScopes: ["workspace.read", "agent.launch"],
    clientChallenge: "challenge",
    requestSignature: "signature",
    createdAt: 1_000,
    expiresAt: 61_000,
    status: "requested",
    ...overrides,
  };
}

function harness(overrides: Partial<SessionApprovalDependencies> = {}) {
  const changes: PendingRemoteSession[][] = [];
  const dependencies = {
    approve: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    resolveRequesterName: vi.fn(async () => "Studio Mac"),
    ensureWindow: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000),
    reportError: vi.fn(),
    ...overrides,
  } satisfies SessionApprovalDependencies;
  const registry = new SessionApprovalRegistry(dependencies);
  registry.onChanged((sessions) => changes.push(sessions));
  return { changes, dependencies, registry };
}

describe("SessionApprovalRegistry", () => {
  it("announces the complete pending set once per session and resolves the requester name", async () => {
    const { changes, dependencies, registry } = harness();

    registry.handlePending(pendingSession());
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(changes.length).toBe(2));

    expect(dependencies.ensureWindow).toHaveBeenCalledOnce();
    expect(changes[0]).toEqual([
      {
        sessionId: SESSION_ID,
        clientDeviceId: CLIENT_DEVICE_ID,
        requestedScopes: ["workspace.read", "agent.launch"],
        expiresAt: 61_000,
      },
    ]);
    expect(changes[1]).toEqual([
      {
        sessionId: SESSION_ID,
        clientDeviceId: CLIENT_DEVICE_ID,
        requesterDisplayName: "Studio Mac",
        requestedScopes: ["workspace.read", "agent.launch"],
        expiresAt: 61_000,
      },
    ]);
    expect(registry.list()).toEqual(changes[1]);
  });

  it("rejects the session when no window can be shown", async () => {
    const failure = new Error("Renderer URL policy is not initialized");
    const { changes, dependencies, registry } = harness({
      ensureWindow: vi.fn(async () => {
        throw failure;
      }),
    });

    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(dependencies.reject).toHaveBeenCalledOnce());

    expect(dependencies.reportError).toHaveBeenCalledWith(failure);
    expect(registry.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
    expect(dependencies.resolveRequesterName).not.toHaveBeenCalled();
  });

  it("refuses scopes that were never requested without dropping the session", async () => {
    const { dependencies, registry } = harness();
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));

    await expect(
      registry.approve({
        sessionId: SESSION_ID,
        approvedScopes: ["workspace.read", "terminal.create"],
      }),
    ).rejects.toThrow("REMOTE_SCOPES_NOT_REQUESTED");
    expect(dependencies.approve).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
  });

  it("clears the pending entry when the approval callable fails", async () => {
    const { dependencies, registry } = harness({
      approve: vi.fn(async () => {
        throw new Error("REMOTE_HOST_NOT_STARTED");
      }),
    });
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));

    await expect(
      registry.approve({
        sessionId: SESSION_ID,
        approvedScopes: ["workspace.read"],
      }),
    ).rejects.toThrow("REMOTE_HOST_NOT_STARTED");
    expect(dependencies.approve).toHaveBeenCalledWith(expect.anything(), [
      "workspace.read",
    ]);
    expect(registry.list()).toEqual([]);
    await expect(
      registry.approve({
        sessionId: SESSION_ID,
        approvedScopes: ["workspace.read"],
      }),
    ).rejects.toThrow("REMOTE_SESSION_NOT_PENDING");
  });

  it("treats an expired session as no longer pending and clears every entry on demand", async () => {
    const clock = { value: 1_000 };
    const { changes, dependencies, registry } = harness({
      now: vi.fn(() => clock.value),
    });
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));

    clock.value = 61_000;
    expect(registry.list()).toEqual([]);
    await expect(registry.reject({ sessionId: SESSION_ID })).rejects.toThrow(
      "REMOTE_SESSION_NOT_PENDING",
    );
    expect(dependencies.reject).not.toHaveBeenCalled();

    clock.value = 1_000;
    registry.handlePending(pendingSession({ sessionId: SESSION_ID }));
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/session-approval.test.ts`
Expected: FAIL with `Failed to resolve import "./session-approval" from "src/main/remote/session-approval.test.ts"`

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/remote/session-approval.ts
import {
  PendingRemoteSessionListSchema,
  type ApproveRemoteSessionRequest,
  type PendingRemoteSession,
  type RejectRemoteSessionRequest,
  type RemoteSession,
} from "@codra/protocol";

const REQUESTER_DISPLAY_NAME_MAX_LENGTH = 200;

export interface SessionApprovalDependencies {
  approve(
    session: RemoteSession,
    approvedScopes: readonly string[],
  ): Promise<void>;
  reject(session: RemoteSession): Promise<void>;
  resolveRequesterName(session: RemoteSession): Promise<string | undefined>;
  ensureWindow(): Promise<void>;
  now(): number;
  reportError(error: unknown): void;
}

interface PendingEntry {
  session: RemoteSession;
  requesterDisplayName?: string;
}

function toPendingRemoteSession(entry: PendingEntry): PendingRemoteSession {
  const pending: PendingRemoteSession = {
    sessionId: entry.session.sessionId,
    clientDeviceId: entry.session.clientDeviceId,
    requestedScopes: [...entry.session.requestedScopes],
    expiresAt: entry.session.expiresAt,
  };
  if (entry.requesterDisplayName !== undefined)
    pending.requesterDisplayName = entry.requesterDisplayName;
  return pending;
}

export class SessionApprovalRegistry {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly listeners = new Set<
    (sessions: PendingRemoteSession[]) => void
  >();

  constructor(private readonly dependencies: SessionApprovalDependencies) {}

  handlePending(session: RemoteSession): void {
    if (this.entries.has(session.sessionId)) return;
    if (session.expiresAt <= this.dependencies.now()) return;
    this.entries.set(session.sessionId, { session });
    void this.present(session);
  }

  list(): PendingRemoteSession[] {
    this.prune();
    return PendingRemoteSessionListSchema.parse(
      [...this.entries.values()].map(toPendingRemoteSession),
    );
  }

  async approve(request: ApproveRemoteSessionRequest): Promise<void> {
    const session = this.requirePending(request.sessionId);
    for (const scope of request.approvedScopes) {
      if (!session.requestedScopes.includes(scope))
        throw new Error("REMOTE_SCOPES_NOT_REQUESTED");
    }
    this.entries.delete(session.sessionId);
    this.notify();
    await this.dependencies.approve(session, request.approvedScopes);
  }

  async reject(request: RejectRemoteSessionRequest): Promise<void> {
    const session = this.requirePending(request.sessionId);
    this.entries.delete(session.sessionId);
    this.notify();
    await this.dependencies.reject(session);
  }

  onChanged(listener: (sessions: PendingRemoteSession[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.notify();
  }

  private requirePending(sessionId: string): RemoteSession {
    this.prune();
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error("REMOTE_SESSION_NOT_PENDING");
    return entry.session;
  }

  private prune(): void {
    const now = this.dependencies.now();
    for (const [sessionId, entry] of this.entries) {
      if (entry.session.expiresAt <= now) this.entries.delete(sessionId);
    }
  }

  private async present(session: RemoteSession): Promise<void> {
    try {
      await this.dependencies.ensureWindow();
    } catch (error) {
      this.dependencies.reportError(error);
      this.entries.delete(session.sessionId);
      this.notify();
      await this.dependencies
        .reject(session)
        .catch((rejectError: unknown) =>
          this.dependencies.reportError(rejectError),
        );
      return;
    }
    this.notify();
    let requesterDisplayName: string | undefined;
    try {
      requesterDisplayName =
        await this.dependencies.resolveRequesterName(session);
    } catch (error) {
      this.dependencies.reportError(error);
      return;
    }
    const bounded = requesterDisplayName
      ?.trim()
      .slice(0, REQUESTER_DISPLAY_NAME_MAX_LENGTH);
    if (!bounded) return;
    const entry = this.entries.get(session.sessionId);
    if (!entry) return;
    entry.requesterDisplayName = bounded;
    this.notify();
  }

  private notify(): void {
    const sessions = this.list();
    for (const listener of this.listeners) {
      try {
        listener(sessions);
      } catch (error) {
        this.dependencies.reportError(error);
      }
    }
  }
}
```

Design points this code fixes, each covered by one test above:

- De-dup lives in `entries` (a `Map<string, RemoteSession>` wrapper), replacing the id-only `promptedSessions` set at `host-controller.ts:76`; `handlePending` is idempotent per `sessionId`.
- Cleanup runs on the ERROR path too: `approve`/`reject` delete the entry **before** awaiting the dependency, so a failing callable does not strand the id the way `host-controller.ts:480` and `:523` do today.
- Subset validation runs before deletion, so a rejected `approvedScopes` leaves the session pending.
- `prune()` drops expired entries, which both implements "expired means not pending" and keeps the map under `PendingRemoteSessionListSchema`'s `.max(50)` even though `subscribeSessions` never emits a removal event (`packages/firebase/src/index.ts:262-277`).
- Every notification carries the complete current set via `list()`, never a delta.
- `ensureWindow()` precedes the first notification; on failure the session is rejected, the rejection's own throw is caught, and `reportError` sees both.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/session-approval.test.ts && pnpm typecheck`
Expected: PASS — `Test Files 1 passed (1)`, `Tests 5 passed (5)`; `pnpm typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/remote/session-approval.ts apps/desktop/src/main/remote/session-approval.test.ts
git commit -m "feat(desktop): retain and validate pending remote sessions"
```

---

---

### Task 6: host-controller wiring and device name

**Files:**

- Create: `apps/desktop/src/main/remote/device-name.ts`
- Test: `apps/desktop/src/main/remote/device-name.test.ts`
- Modify: `apps/desktop/src/main/remote/desktop-login.ts:1`, `:27`, `:702`
- Modify: `apps/desktop/src/main/remote/desktop-login.test.ts:1-24`, insert before `:510`
- Modify: `apps/desktop/src/main/remote/host-controller.ts:1`, `:10-24`, `:26`, `:52-60`, `:68`, `:86-105`, `:332`, `:379`, `:419-425`, `:444`, `:488`
- Modify: `apps/desktop/src/main/remote/host-controller.test.ts:1-24`, append after `:116`
- Modify: `apps/desktop/src/main/index.ts:125-126`

**Interfaces:**

- Consumes: `SessionApprovalRegistry`, `SessionApprovalDependencies` (Task 5); `listHostDevices(functions: Functions): Promise<RemoteDevice[]>` (`packages/firebase/src/auth-client.ts:62`, already imported as `listFirebaseHostDevices` at `host-controller.ts:5`).
- Produces (CONTRACT §10): `export function resolveDeviceDisplayName(hostname: string): string` in `apps/desktop/src/main/remote/device-name.ts`.
- Produces (satisfies CONTRACT §4): `RemoteHostController.getPendingSessions(): PendingRemoteSession[]`, `.approveSession(request: ApproveRemoteSessionRequest): Promise<void>`, `.rejectSession(request: RejectRemoteSessionRequest): Promise<void>`, `.onPendingSessionsChanged(listener: (sessions: PendingRemoteSession[]) => void): () => void`.
- **Names introduced by this task that are not in CONTRACT.md; no other task may redefine them:**
  - `RemoteHostController.signSessionApproval(session: RemoteSession, approvedScopes?): Promise<RemoteSession>` — the existing `approveSession` at `host-controller.ts:444`, renamed. The rename is forced: CONTRACT §4 reuses the name `approveSession` with an incompatible signature (`ApproveRemoteSessionRequest` → `Promise<void>`).
  - `RemoteHostController.signSessionRejection(session: RemoteSession, rejectionReason?): Promise<RemoteSession>` — the existing `rejectSession` at `host-controller.ts:488`, renamed for the same reason.
  - `RemoteHostControllerOptions.ensureWindow?(): Promise<void>` — the injection point through which `main/index.ts` supplies the electron window-creation dependency that `SessionApprovalDependencies.ensureWindow` requires.

Requester names resolve through `listHostDevices`, **not** `getSessionPeerDevice`: `functions/src/index.ts:550-556` throws `failed-precondition SESSION_NOT_CONNECTABLE` for any session whose status is not `approved`/`signaling`/`connected`, and a pending session is `requested`, so every pre-approval lookup would fail. `listHostDevices` is callable by a `host`-kind device (`functions/src/auth.ts:53-59`) and needs no Functions change.

- [ ] **Step 1: Write the failing test for the display-name helper**

```ts
// apps/desktop/src/main/remote/device-name.test.ts
import { describe, expect, it } from "vitest";
import { resolveDeviceDisplayName } from "./device-name";

describe("resolveDeviceDisplayName", () => {
  it("uses the bare hostname without the mDNS suffix", () => {
    expect(resolveDeviceDisplayName("Juns-MacBook-Pro.local")).toBe(
      "Juns-MacBook-Pro",
    );
    expect(resolveDeviceDisplayName("  studio-mac  ")).toBe("studio-mac");
  });

  it("falls back to a constant when the hostname is empty", () => {
    expect(resolveDeviceDisplayName("")).toBe("CODRA host");
    expect(resolveDeviceDisplayName(".local")).toBe("CODRA host");
  });

  it("stays inside the RemoteDevice displayName bounds of 1 to 200", () => {
    for (const hostname of ["", ".local", "a", "x".repeat(500)]) {
      const resolved = resolveDeviceDisplayName(hostname);
      expect(resolved.length).toBeGreaterThanOrEqual(1);
      expect(resolved.length).toBeLessThanOrEqual(200);
    }
    expect(resolveDeviceDisplayName("x".repeat(500))).toHaveLength(200);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/device-name.test.ts`
Expected: FAIL with `Failed to resolve import "./device-name" from "src/main/remote/device-name.test.ts"`

- [ ] **Step 3: Implement the helper**

```ts
// apps/desktop/src/main/remote/device-name.ts
const DEVICE_DISPLAY_NAME_MAX_LENGTH = 200;
const DEFAULT_DEVICE_DISPLAY_NAME = "CODRA host";

export function resolveDeviceDisplayName(hostname: string): string {
  const trimmed = hostname
    .trim()
    .replace(/\.local\.?$/iu, "")
    .trim();
  if (trimmed.length === 0) return DEFAULT_DEVICE_DISPLAY_NAME;
  return trimmed.slice(0, DEVICE_DISPLAY_NAME_MAX_LENGTH);
}
```

The bound matches `RemoteDeviceSchema.displayName` (`packages/protocol/src/remote.ts:65`, `z.string().min(1).max(200)`), which is also the bound on `DesktopLoginStartRequestSchema.displayName` (`remote.ts:111`).

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/device-name.test.ts`
Expected: PASS — `Tests 3 passed (3)`

- [ ] **Step 5: Write the failing test for the signed login-start payload**

Insert this `it` block into `apps/desktop/src/main/remote/desktop-login.test.ts` immediately before the existing `it("has no embedded browser or Firebase web redirect implementation", ...)` at `:510`, and add the two imports.

```ts
// apps/desktop/src/main/remote/desktop-login.test.ts — add after line 2
import { hostname } from "node:os";
// apps/desktop/src/main/remote/desktop-login.test.ts — add before the HostIdentity import at line 24
import { resolveDeviceDisplayName } from "./device-name";
```

```ts
it("registers the device under the resolved host display name", async () => {
  const runtime = productionRuntime();
  let startBody: { displayName?: unknown } | undefined;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("desktopLoginStart")) {
      startBody = JSON.parse(String(init.body)) as { displayName?: unknown };
      return new Promise<Response>(() => undefined);
    }
    return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
  });

  await expect(
    bootstrapProductionDesktopLogin(
      runtime,
      { identity: hostIdentity(), action: "register" },
      {
        fetch,
        openExternal: async () => undefined,
        timeoutMs: 25,
      },
    ),
  ).rejects.toThrow("DESKTOP_LOGIN_TIMEOUT");
  expect(startBody?.displayName).toBe(resolveDeviceDisplayName(hostname()));
  expect(startBody?.displayName).not.toBe("CODRA host");
});
```

This is a real assertion on a **signed** field: `displayName` feeds `buildDesktopLoginStartSigningPayload` at `desktop-login.ts:713`. The hanging-start-plus-cancel fetch fake copies the existing idiom at `desktop-login.test.ts:481-489`. Neither the new `it` nor the helper contains `BrowserWindow`, `BrowserView`, `webview`, `signInWithPopup`, or `signInWithRedirect`, so the raw source scan at `desktop-login.test.ts:515-517` still passes.

- [ ] **Step 6: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/desktop-login.test.ts`
Expected: FAIL with `expected 'CODRA host' to be '<this machine's resolved hostname>'` — 1 failed, 18 passed.

- [ ] **Step 7: Implement the desktop-login change**

```ts
// apps/desktop/src/main/remote/desktop-login.ts — insert as line 2, after the node:crypto import
import { hostname } from "node:os";
```

```ts
// apps/desktop/src/main/remote/desktop-login.ts — insert immediately before line 27,
// `import type { HostIdentity } from "./host-identity";`
import { resolveDeviceDisplayName } from "./device-name";
```

```ts
// apps/desktop/src/main/remote/desktop-login.ts:702 — replace
      displayName: resolveDeviceDisplayName(hostname()),
```

- [ ] **Step 8: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/desktop-login.test.ts`
Expected: PASS — `Tests 19 passed (19)`

- [ ] **Step 9: Write the failing tests for the controller**

Replace the mock preamble at `apps/desktop/src/main/remote/host-controller.test.ts:1-24` with the block below, and append the harness plus the three new tests after the closing `});` at `:116`.

```ts
// apps/desktop/src/main/remote/host-controller.test.ts:1-24 — replaces the existing preamble
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapRemoteAccount: vi.fn(),
  bootstrapRemoteAuth: vi.fn(),
  createRemoteFirebaseRuntime: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signOut: vi.fn(async () => undefined),
  hostname: vi.fn(() => "Studio-Mac.local"),
  httpsCallable: vi.fn(() => async () => ({ data: {} })),
  loadOrCreateHostIdentity: vi.fn(),
  registerDevice: vi.fn(),
  listHostDevices: vi.fn(
    async (): Promise<{ deviceId: string; displayName: string }[]> => [],
  ),
  subscribePendingSessions: vi.fn(
    (options: { onChange: (sessions: RemoteSession[]) => void }) => {
      void options;
      return (): void => undefined;
    },
  ),
  approveRemoteSession: vi.fn(),
  rejectRemoteSession: vi.fn(),
}));

vi.mock("node:os", () => ({ hostname: mocks.hostname }));

vi.mock("@codra/remote-account-bootstrap", () => ({
  bootstrapRemoteAccount: mocks.bootstrapRemoteAccount,
  bootstrapRemoteAuth: mocks.bootstrapRemoteAuth,
}));

vi.mock("@codra/remote-firebase-config", () => ({
  createRemoteFirebaseRuntime: mocks.createRemoteFirebaseRuntime,
}));

vi.mock("firebase/auth", () => ({
  signInWithCustomToken: mocks.signInWithCustomToken,
  signOut: mocks.signOut,
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: mocks.httpsCallable,
}));

vi.mock("./host-identity", () => ({
  loadOrCreateHostIdentity: mocks.loadOrCreateHostIdentity,
}));

vi.mock("@codra/firebase", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerDevice: mocks.registerDevice,
  listHostDevices: mocks.listHostDevices,
  subscribePendingSessions: mocks.subscribePendingSessions,
  approveRemoteSession: mocks.approveRemoteSession,
  rejectRemoteSession: mocks.rejectRemoteSession,
}));

import { generateKeyPairSync } from "node:crypto";
import {
  createRfc7638Thumbprint,
  type PublicEcJwk,
  type RemoteSession,
} from "@codra/protocol";
import { RemoteHostController } from "./host-controller";
```

`@codra/firebase` is mocked with `importOriginal` spread rather than a bare factory because `desktop-peer-connector.ts:2-8` and `signal-transport.ts` import other members of the same package from inside the controller's module graph. `./host-identity` must be mocked because `host-identity.ts:4` reaches electron `safeStorage`.

```ts
// apps/desktop/src/main/remote/host-controller.test.ts — append after the existing
// `describe("RemoteHostController account lifecycle", ...)` block ends at line 116
const CLIENT_DEVICE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const HOST_DEVICE_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const SESSION_ID = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";

function keyMaterial() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyJwk = pair.publicKey.export({ format: "jwk" }) as PublicEcJwk;
  return {
    publicKeyJwk,
    privateKey: pair.privateKey.export({ format: "jwk" }),
    keyThumbprint: createRfc7638Thumbprint(publicKeyJwk),
  };
}

function pendingSession(): RemoteSession {
  return {
    sessionId: SESSION_ID,
    ownerUid: "uid-1",
    clientDeviceId: CLIENT_DEVICE_ID,
    hostDeviceId: HOST_DEVICE_ID,
    clientKeyThumbprint: "client-thumbprint",
    hostKeyThumbprint: "host-thumbprint",
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 1,
    protocolVersion: 1,
    requestedScopes: ["workspace.read", "agent.launch"],
    clientChallenge: "challenge",
    requestSignature: "signature",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    status: "requested",
  };
}

async function activatedController(
  ensureWindow = vi.fn(async () => undefined),
) {
  const material = keyMaterial();
  const accountAuth = {
    currentUser: null as null | {
      displayName: string;
      email: string;
      photoURL: null;
      uid: string;
    },
  };
  const accountRuntime = { auth: accountAuth, functions: {}, firestore: {} };
  const deviceRuntime = {
    auth: { currentUser: { uid: "uid-1" } },
    functions: {},
    firestore: {},
  };
  mocks.createRemoteFirebaseRuntime.mockImplementation((name?: string) =>
    name === "codra-host-device" ? deviceRuntime : accountRuntime,
  );
  mocks.bootstrapRemoteAuth.mockImplementation(async () => {
    accountAuth.currentUser = {
      displayName: "CODRA Operator",
      email: "operator@example.com",
      photoURL: null,
      uid: "uid-1",
    };
  });
  mocks.bootstrapRemoteAccount.mockResolvedValue(undefined);
  mocks.loadOrCreateHostIdentity.mockResolvedValue({
    deviceId: HOST_DEVICE_ID,
    publicKeyJwk: material.publicKeyJwk,
    privateKey: material.privateKey,
    keyThumbprint: material.keyThumbprint,
    created: true,
  });
  mocks.registerDevice.mockImplementation(
    async (_functions: unknown, request: { displayName: string }) => ({
      token: "device-token",
      device: {
        deviceId: HOST_DEVICE_ID,
        ownerUid: "uid-1",
        kind: "host",
        displayName: request.displayName,
        publicKeyJwk: material.publicKeyJwk,
        keyThumbprint: material.keyThumbprint,
        active: true,
        generation: 1,
        remoteAccessEnabled: true,
        capabilities: ["terminal", "webrtc", "turn-udp"],
        createdAt: 1_000,
        lastSeenAt: 2_000,
        expiresAt: 3_000,
      },
    }),
  );
  let onChange: ((sessions: RemoteSession[]) => void) | undefined;
  mocks.subscribePendingSessions.mockImplementation(
    (options: { onChange: (sessions: RemoteSession[]) => void }) => {
      onChange = options.onChange;
      return () => undefined;
    },
  );
  const controller = new RemoteHostController({
    userDataPath: "/tmp/codra-host-controller-test",
    reportError: vi.fn(),
    ensureWindow,
    createPeer: vi.fn(),
  });
  await controller.login("google", parentWindow());
  await controller.activate();
  return {
    controller,
    ensureWindow,
    deliverPending: (session: RemoteSession) => onChange?.([session]),
  };
}

describe("RemoteHostController session approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostname.mockReturnValue("Studio-Mac.local");
    mocks.listHostDevices.mockResolvedValue([]);
  });

  it("registers the device under the resolved host name", async () => {
    await activatedController();

    expect(mocks.registerDevice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ displayName: "Studio-Mac" }),
    );
  });

  it("publishes pending sessions with the requester name from listHostDevices", async () => {
    mocks.listHostDevices.mockResolvedValue([
      { deviceId: CLIENT_DEVICE_ID, displayName: "Laptop Mac" },
    ]);
    const { controller, deliverPending, ensureWindow } =
      await activatedController();
    const changes: unknown[] = [];
    controller.onPendingSessionsChanged((sessions) => changes.push(sessions));

    deliverPending(pendingSession());
    await vi.waitFor(() => expect(changes.length).toBe(2));

    expect(ensureWindow).toHaveBeenCalledOnce();
    expect(controller.getPendingSessions()).toEqual([
      {
        sessionId: SESSION_ID,
        clientDeviceId: CLIENT_DEVICE_ID,
        requesterDisplayName: "Laptop Mac",
        requestedScopes: ["workspace.read", "agent.launch"],
        expiresAt: expect.any(Number),
      },
    ]);
  });

  it("refuses scopes outside the request and clears the registry on deactivate", async () => {
    const { controller, deliverPending } = await activatedController();
    deliverPending(pendingSession());
    await vi.waitFor(() =>
      expect(controller.getPendingSessions()).toHaveLength(1),
    );

    await expect(
      controller.approveSession({
        sessionId: SESSION_ID,
        approvedScopes: ["terminal.create"],
      }),
    ).rejects.toThrow("REMOTE_SCOPES_NOT_REQUESTED");
    expect(mocks.approveRemoteSession).not.toHaveBeenCalled();

    await controller.deactivate();
    expect(controller.getPendingSessions()).toEqual([]);
    await expect(
      controller.rejectSession({ sessionId: SESSION_ID }),
    ).rejects.toThrow("REMOTE_SESSION_NOT_PENDING");
  });
});
```

`terminal.create` is deliberate: `host-control-gateway.ts:462` enforces that scope but `REMOTE_AGENT_SCOPES` (`host-control-gateway.ts:35-42`) never requests it, so it is the canonical never-requested scope.

- [ ] **Step 10: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/host-controller.test.ts`
Expected: FAIL — 3 failed, 2 passed. First failure: `expected "registerDevice" to be called with arguments: [ Anything, ObjectContaining {"displayName": "Studio-Mac"} ]` (the call carries `displayName: "CODRA host"`). Second and third: `TypeError: controller.onPendingSessionsChanged is not a function` and `TypeError: controller.getPendingSessions is not a function`.

- [ ] **Step 11: Implement the controller changes**

```ts
// apps/desktop/src/main/remote/host-controller.ts — insert as line 1
import { hostname } from "node:os";
```

```ts
// apps/desktop/src/main/remote/host-controller.ts:13 — add to the @codra/protocol type imports
  type AgentExecutionTarget,
  type ApproveRemoteSessionRequest,
  type PendingRemoteSession,
  type RejectRemoteSessionRequest,
  type AgentLaunchTarget,
```

```ts
// apps/desktop/src/main/remote/host-controller.ts — insert after line 26
import { resolveDeviceDisplayName } from "./device-name";
import { SessionApprovalRegistry } from "./session-approval";
```

```ts
// apps/desktop/src/main/remote/host-controller.ts:55 — add to RemoteHostControllerOptions,
// after `onPendingSession?(session: RemoteSession): void;`
  ensureWindow?(): Promise<void>;
```

```ts
// apps/desktop/src/main/remote/host-controller.ts:68 — add after `private readonly remoteClient: RemoteAgentClient;`
  private readonly sessionApprovals: SessionApprovalRegistry;
```

```ts
// apps/desktop/src/main/remote/host-controller.ts — append inside the constructor,
// immediately after the `this.remoteClient = new RemoteAgentClient({...});` statement ends at line 104
    this.sessionApprovals = new SessionApprovalRegistry({
      approve: async (session, approvedScopes) => {
        await this.signSessionApproval(session, [...approvedScopes]);
      },
      reject: async (session) => {
        await this.signSessionRejection(session);
      },
      resolveRequesterName: (session) => this.resolveRequesterName(session),
      ensureWindow: async () => {
        await this.options.ensureWindow?.();
      },
      now: () => Date.now(),
      reportError: (error) => this.options.reportError(error),
    });
  }

  getPendingSessions(): PendingRemoteSession[] {
    return this.sessionApprovals.list();
  }

  approveSession(request: ApproveRemoteSessionRequest): Promise<void> {
    return this.sessionApprovals.approve(request);
  }

  rejectSession(request: RejectRemoteSessionRequest): Promise<void> {
    return this.sessionApprovals.reject(request);
  }

  onPendingSessionsChanged(
    listener: (sessions: PendingRemoteSession[]) => void,
  ): () => void {
    return this.sessionApprovals.onChanged(listener);
  }

  private async resolveRequesterName(
    session: RemoteSession,
  ): Promise<string | undefined> {
    if (!this.deviceRuntime) return undefined;
    const devices = await listFirebaseHostDevices(this.deviceRuntime.functions);
    return devices.find((device) => device.deviceId === session.clientDeviceId)
      ?.displayName;
  }
```

The registry is assigned in the constructor body, not as a field initializer, so that `this.options` (a parameter property) is already bound — the same ordering the existing `this.remoteClient` assignment relies on.

```ts
// apps/desktop/src/main/remote/host-controller.ts:332 — add immediately after
// `this.promptedSessions.clear();` inside stopHostResources
this.sessionApprovals.clear();
```

```ts
// apps/desktop/src/main/remote/host-controller.ts:379 — replace
          displayName: resolveDeviceDisplayName(hostname()),
```

```ts
// apps/desktop/src/main/remote/host-controller.ts:419-425 — replace the onChange body
        onChange: (sessions) => {
          for (const session of sessions) {
            this.sessionApprovals.handlePending(session);
            if (this.promptedSessions.has(session.sessionId)) continue;
            this.promptedSessions.add(session.sessionId);
            this.options.onPendingSession?.(session);
          }
        },
```

`handlePending` runs before the `promptedSessions` guard so the registry — which cleans up on the error path — owns re-prompting, while `onPendingSession` keeps its existing once-per-session contract for the auto-response test seam.

```ts
// apps/desktop/src/main/remote/host-controller.ts:444 — rename
  async signSessionApproval(
```

```ts
// apps/desktop/src/main/remote/host-controller.ts:488 — rename
  async signSessionRejection(
```

```ts
// apps/desktop/src/main/index.ts:125-126 — update the two call sites of the renamed methods
if (result.response === 1) return remoteHost.signSessionApproval(session);
return remoteHost.signSessionRejection(session);
```

- [ ] **Step 12: Run the tests and watch them pass**

Run: `pnpm --filter @codra/desktop test && pnpm typecheck`
Expected: PASS — `Test Files 36 passed (36)`, `Tests 272 passed (272)`; `pnpm typecheck` exits 0.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/src/main/remote/device-name.ts apps/desktop/src/main/remote/device-name.test.ts apps/desktop/src/main/remote/desktop-login.ts apps/desktop/src/main/remote/desktop-login.test.ts apps/desktop/src/main/remote/host-controller.ts apps/desktop/src/main/remote/host-controller.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): name devices by hostname and expose pending sessions"
```

---

---

### Task 7: remote-ipc registration

**Files:**

- Modify: `apps/desktop/src/main/ipc/remote-ipc.ts:1-26`, `:62-65`, `:77-150`, `:262-269`, `:277-301`
- Modify: `apps/desktop/src/main/ipc/remote-ipc.test.ts:1-9`, `:47-134`, append after `:277`

**Interfaces:**

- Consumes: `IPC_CHANNELS.remoteGetPendingSessions`, `.remoteApproveSession`, `.remoteRejectSession`, `.remotePendingSessions` (Task 2); `PendingRemoteSessionListSchema`, `ApproveRemoteSessionRequestSchema`, `RejectRemoteSessionRequestSchema` (Task 1); `RemoteHostController.getPendingSessions/approveSession/rejectSession/onPendingSessionsChanged` (Task 6).
- Produces (CONTRACT §4): the four `RemoteHostControllerPort` members, consumed by the preload bridge task.
- **Name introduced by this task, not in CONTRACT.md; no other task may redefine it:** `sendToTrustedWindows(windows, isTrustedRendererUrl, channel, payload, reportError): void`.

**Explicit decision on the fan-out helper — parameterise, do not add a fourth copy.** `sendToLiveWindows` (`:77-100`), `sendAccountStatusToLiveWindows` (`:102-125`), and `sendTargetsToLiveWindows` (`:127-150`) differ only in their channel constant and their Zod schema; a fourth copy would put the five window guards in four places. They are replaced by a single `sendToTrustedWindows` that takes `channel` and an already-parsed `payload`. All five guards move verbatim into that one function, in order: `window.isDestroyed?.()`, `!webContents`, `webContents.isDestroyed()`, `!isTrustedRendererUrl(webContents.getURL())`, `!isTrustedRendererUrl(webContents.mainFrame.url)`. Parsing stays at the subscription site so a schema failure still propagates out of the listener exactly as it does today.

- [ ] **Step 1: Write the failing test**

Add the type imports, extend the hand-written fake, and append two `it` blocks.

```ts
// apps/desktop/src/main/ipc/remote-ipc.test.ts:4-7 — extend the @codra/protocol type imports
  type AgentExecutionTarget,
  type AgentLaunchTarget,
  type ApproveRemoteSessionRequest,
  type PendingRemoteSession,
  type RejectRemoteSessionRequest,
  type RemoteAccountStatus,
  type RemoteHostStatus,
```

```ts
// apps/desktop/src/main/ipc/remote-ipc.test.ts:52 — add after the targetsListener declaration
let pendingListener: ((next: PendingRemoteSession[]) => void) | undefined;
let pending: PendingRemoteSession[] = [
  {
    sessionId: "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d",
    clientDeviceId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    requesterDisplayName: "Laptop Mac",
    requestedScopes: ["workspace.read", "agent.launch"],
    expiresAt: 1_700_000_000_000,
  },
];
```

```ts
// apps/desktop/src/main/ipc/remote-ipc.test.ts — add to the returned fake, after the
// `onTargetsChanged` member ends at line 125
    getPendingSessions: vi.fn(() => pending),
    approveSession: vi.fn(async (request: ApproveRemoteSessionRequest) => {
      pending = pending.filter(
        (session) => session.sessionId !== request.sessionId,
      );
      pendingListener?.(pending);
    }),
    rejectSession: vi.fn(async (request: RejectRemoteSessionRequest) => {
      pending = pending.filter(
        (session) => session.sessionId !== request.sessionId,
      );
      pendingListener?.(pending);
    }),
    onPendingSessionsChanged: (
      next: (value: PendingRemoteSession[]) => void,
    ) => {
      pendingListener = next;
      return () => {
        pendingListener = undefined;
      };
    },
```

```ts
// apps/desktop/src/main/ipc/remote-ipc.test.ts — add after the `emitTargets` member at line 132
    emitPending(next: PendingRemoteSession[]) {
      pending = next;
      pendingListener?.(next);
    },
```

```ts
// apps/desktop/src/main/ipc/remote-ipc.test.ts — append inside describe("registerRemoteIpc"),
// after the existing untrusted-renderer test ends at line 276
it("pulls, pushes, and resolves pending remote sessions", async () => {
  const ipc = new FakeIpc();
  const host = controller();
  const client = sender();
  const cleanup = registerRemoteIpc({
    ipc,
    controller: host,
    windows: () => [client.window],
    isTrustedRendererUrl: (url) => url.startsWith("file:///trusted/"),
  });
  const sessionId = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";

  expect(
    ipc.handlers.get(IPC_CHANNELS.remoteGetPendingSessions)?.(client.event),
  ).toEqual([
    {
      sessionId,
      clientDeviceId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      requesterDisplayName: "Laptop Mac",
      requestedScopes: ["workspace.read", "agent.launch"],
      expiresAt: 1_700_000_000_000,
    },
  ]);

  await expect(
    ipc.handlers.get(IPC_CHANNELS.remoteApproveSession)?.(client.event, {
      sessionId,
      approvedScopes: ["workspace.read"],
    }),
  ).resolves.toBeUndefined();
  expect(host.approveSession).toHaveBeenCalledWith({
    sessionId,
    approvedScopes: ["workspace.read"],
  });
  expect(client.sends.at(-1)).toEqual({
    channel: IPC_CHANNELS.remotePendingSessions,
    payload: [],
  });

  await expect(
    ipc.handlers.get(IPC_CHANNELS.remoteApproveSession)?.(client.event, {
      sessionId,
      approvedScopes: [],
    }),
  ).rejects.toThrow();
  await expect(
    ipc.handlers.get(IPC_CHANNELS.remoteRejectSession)?.(client.event, {
      sessionId,
      reason: "USER_REJECTED",
    }),
  ).rejects.toThrow();

  await expect(
    ipc.handlers.get(IPC_CHANNELS.remoteRejectSession)?.(client.event, {
      sessionId,
    }),
  ).resolves.toBeUndefined();
  expect(host.rejectSession).toHaveBeenCalledWith({ sessionId });

  cleanup();
  const before = client.sends.length;
  host.emitPending([]);
  expect(client.sends).toHaveLength(before);
});

it("rejects an untrusted renderer on every pending-session channel", async () => {
  const ipc = new FakeIpc();
  const host = controller();
  const client = sender();
  registerRemoteIpc({
    ipc,
    controller: host,
    windows: () => [client.window],
    isTrustedRendererUrl: () => false,
  });
  const sessionId = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";

  expect(() =>
    ipc.handlers.get(IPC_CHANNELS.remoteGetPendingSessions)?.(client.event),
  ).toThrow("Unauthorized terminal IPC sender");
  expect(host.getPendingSessions).not.toHaveBeenCalled();

  await expect(
    ipc.handlers.get(IPC_CHANNELS.remoteApproveSession)?.(client.event, {
      sessionId,
      approvedScopes: ["workspace.read"],
    }),
  ).rejects.toThrow("Unauthorized terminal IPC sender");
  expect(host.approveSession).not.toHaveBeenCalled();

  await expect(
    ipc.handlers.get(IPC_CHANNELS.remoteRejectSession)?.(client.event, {
      sessionId,
    }),
  ).rejects.toThrow("Unauthorized terminal IPC sender");
  expect(host.rejectSession).not.toHaveBeenCalled();
});
```

The pull handler is synchronous — like `remoteGetState` at `remote-ipc.ts:224` — so its unauthorized case is asserted with `expect(() => ...).toThrow(...)`, not `.rejects.toThrow(...)`; `.rejects` on a synchronous throw fails with the error escaping the test. The two invoke handlers are async and use `.rejects`. The `cleanup(); host.emitPending([])` assertion is what proves the push subscription is folded into the composed unsubscribe rather than leaking — no existing test covers that for any channel.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/ipc/remote-ipc.test.ts`
Expected: FAIL — 2 failed, 3 passed. First failure: `expected undefined to deeply equal [ { sessionId: '7f1d3b2a-…', … } ]` (the channel has no handler). Second: `expected [Function] to throw error including "Unauthorized terminal IPC sender"`.

- [ ] **Step 3: Replace the three fan-out helpers with one parameterised helper**

Delete `remote-ipc.ts:77-150` entirely and put this in their place.

```ts
// apps/desktop/src/main/ipc/remote-ipc.ts:77 — replaces sendToLiveWindows,
// sendAccountStatusToLiveWindows, and sendTargetsToLiveWindows
function sendToTrustedWindows(
  windows: () => readonly BrowserWindowLike[],
  isTrustedRendererUrl: (url: string) => boolean,
  channel: string,
  payload: unknown,
  reportError: (error: unknown) => void,
): void {
  for (const window of windows()) {
    try {
      if (window.isDestroyed?.()) continue;
      const webContents = window.webContents;
      if (!webContents || webContents.isDestroyed()) continue;
      if (
        !isTrustedRendererUrl(webContents.getURL()) ||
        !isTrustedRendererUrl(webContents.mainFrame.url)
      ) {
        continue;
      }
      webContents.send(channel, payload);
    } catch (error) {
      reportError(error);
    }
  }
}
```

Then rewrite the subscription block at `remote-ipc.ts:277-301` so each listener parses its own payload and the pending-sessions unsubscribe joins the composed closure.

```ts
// apps/desktop/src/main/ipc/remote-ipc.ts:277-301 — replaces the existing subscription block
unsubscribe = controller.onStatusChanged((status) =>
  sendToTrustedWindows(
    windows,
    isTrustedRendererUrl,
    IPC_CHANNELS.remoteState,
    RemoteHostStatusSchema.parse(status),
    reportError,
  ),
);
const unsubscribeAccount = controller.onAccountStatusChanged((status) =>
  sendToTrustedWindows(
    windows,
    isTrustedRendererUrl,
    IPC_CHANNELS.remoteAuthState,
    RemoteAccountStatusSchema.parse(status),
    reportError,
  ),
);
const previousUnsubscribe = unsubscribe;
const unsubscribeTargets = controller.onTargetsChanged((targets) =>
  sendToTrustedWindows(
    windows,
    isTrustedRendererUrl,
    IPC_CHANNELS.agentTargetsChanged,
    AgentLaunchTargetSchema.array().parse(targets),
    reportError,
  ),
);
const unsubscribePendingSessions = controller.onPendingSessionsChanged(
  (sessions) =>
    sendToTrustedWindows(
      windows,
      isTrustedRendererUrl,
      IPC_CHANNELS.remotePendingSessions,
      PendingRemoteSessionListSchema.parse(sessions),
      reportError,
    ),
);
unsubscribe = () => {
  previousUnsubscribe?.();
  unsubscribeAccount();
  unsubscribeTargets();
  unsubscribePendingSessions();
};
```

- [ ] **Step 4: Extend the port and register the three invoke channels**

```ts
// apps/desktop/src/main/ipc/remote-ipc.ts:6 — add to the value imports from @codra/protocol
  AgentTargetRuntimeRequestSchema,
  ApproveRemoteSessionRequestSchema,
  IPC_CHANNELS,
  PendingRemoteSessionListSchema,
  RemoteAccountStatusSchema,
  RemoteAuthProviderSchema,
  RejectRemoteSessionRequestSchema,
  RemoteHostStatusSchema,
```

```ts
// apps/desktop/src/main/ipc/remote-ipc.ts:18 — add to the type imports from @codra/protocol
  type AgentRuntime,
  type ApproveRemoteSessionRequest,
  type PendingRemoteSession,
  type RejectRemoteSessionRequest,
  type RemoteAccountStatus,
```

```ts
// apps/desktop/src/main/ipc/remote-ipc.ts:62-65 — add to RemoteHostControllerPort,
// after the closing brace of onTargetsChanged and before the interface's own closing brace
  getPendingSessions(): PendingRemoteSession[];
  approveSession(request: ApproveRemoteSessionRequest): Promise<void>;
  rejectSession(request: RejectRemoteSessionRequest): Promise<void>;
  onPendingSessionsChanged(
    listener: (sessions: PendingRemoteSession[]) => void,
  ): () => void;
```

```ts
// apps/desktop/src/main/ipc/remote-ipc.ts:268 — append to the `registrations` array,
// after the IPC_CHANNELS.remoteDeactivate entry and before the closing `];`
    [
      IPC_CHANNELS.remoteGetPendingSessions,
      (event) => {
        authorize(event);
        return PendingRemoteSessionListSchema.parse(
          controller.getPendingSessions(),
        );
      },
    ],
    [
      IPC_CHANNELS.remoteApproveSession,
      async (event, rawRequest) => {
        authorize(event);
        await controller.approveSession(
          ApproveRemoteSessionRequestSchema.parse(rawRequest),
        );
      },
    ],
    [
      IPC_CHANNELS.remoteRejectSession,
      async (event, rawRequest) => {
        authorize(event);
        await controller.rejectSession(
          RejectRemoteSessionRequestSchema.parse(rawRequest),
        );
      },
    ],
```

`authorize(event)` is the first statement of all three. Registering inside `registrations` is what makes the returned teardown at `:309` remove them, keeping `cleanup(); expect(ipc.handlers.size).toBe(0)` (`remote-ipc.test.ts:207-208`) honest.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/ipc/remote-ipc.test.ts && pnpm test && pnpm typecheck`
Expected: PASS — `Tests 5 passed (5)` for the file; `pnpm test` and `pnpm typecheck` both exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ipc/remote-ipc.ts apps/desktop/src/main/ipc/remote-ipc.test.ts
git commit -m "feat(desktop): register pending remote session IPC channels"
```

---

**Verification note for whoever executes this.** Every code block above was written into the real repository, executed, and then reverted. Measured results at the end of Task 7: `pnpm --filter @codra/desktop test` → `Test Files 36 passed (36)`, `Tests 272 passed (272)`; `pnpm --filter @codra/desktop typecheck` → exit 0; `npx eslint apps/desktop/src` → clean; `npx prettier --check apps/desktop/src` → clean. The one prerequisite that must land first is Task 1 (`PendingRemoteSessionListSchema` and the three request types in `packages/protocol/src/desktop-api.ts`) and Task 2 (the four `IPC_CHANNELS` keys) — without them Task 5 Step 4 fails with `TypeError: Cannot read properties of undefined (reading 'parse')` rather than a schema error.

---

### Task 8: SessionApprovalDialog

**Files:**

- Create: `apps/desktop/src/renderer/src/remote/SessionApprovalDialog.tsx`
- Test: `apps/desktop/src/renderer/src/remote/SessionApprovalDialog.test.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css:1590-1600` (append the new blocks directly after the `.remote-workspace-dialog .modal-body` block that ends at line 1600)

**Interfaces:**

- Consumes: `PendingRemoteSession` from `@codra/protocol` (CONTRACT §1 — `sessionId`, `clientDeviceId`, `requesterDisplayName?`, `requestedScopes`, `expiresAt`); `ModalDialog` with `ModalDialogProps { open, title, description?, className?, onClose(), children }` (`apps/desktop/src/renderer/src/components/ModalDialog.tsx:4-11`).
- Produces:

```tsx
export interface SessionApprovalDialogProps {
  session: PendingRemoteSession;
  busy: boolean;
  error?: string;
  onApprove(approvedScopes: string[]): void;
  onDeny(): void;
}
export function SessionApprovalDialog(props: SessionApprovalDialogProps);
```

Three decisions this task fixes, so no later task re-litigates them:

1. **No `open` prop.** CONTRACT §6 does not list one; the component always renders `<ModalDialog open>`, and Task 9 controls visibility by mounting it conditionally. That is also how the "two open `ModalDialog`s stack badly" hazard is avoided.
2. **No explicit return-type annotation.** CONTRACT §6 writes the signature as `JSX.Element`, but `@types/react` 19.2.18 (`apps/desktop/package.json:37`) removed the global `JSX` namespace, so a literal `JSX.Element` annotation fails `pnpm typecheck`. Every existing dialog omits the annotation (`SignInDialog.tsx:38`, `RemoteWorkspaceDialog.tsx:27`); this one does too. The _names_ in the contract are unchanged.
3. **`expiresAt` is not consumed here.** The props carry no `onExpire`, so silent expiry is handled upstream by `SessionApprovalRegistry` pruning and re-emitting the set (CONTRACT §5 `now()`); the modal unmounts when the entry leaves the pushed array.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/remote/SessionApprovalDialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { PendingRemoteSession } from "@codra/protocol";
import { SessionApprovalDialog } from "./SessionApprovalDialog";

void React;

const session: PendingRemoteSession = {
  sessionId: "3f0f8f1a-1f7e-4c4a-9a2f-1a2b3c4d5e6f",
  clientDeviceId: "40c77568-ae29-4af2-a57e-453ffc248a7b",
  requesterDisplayName: "Studio Mac",
  requestedScopes: ["workspace.read", "agent.launch"],
  expiresAt: 1_800_000_000_000,
};

describe("SessionApprovalDialog", () => {
  it("names the requester, focuses Deny, and grants every requested scope", async () => {
    const onApprove = vi.fn();

    render(
      <SessionApprovalDialog
        session={session}
        busy={false}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Allow Studio Mac to connect?" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    expect(
      screen.getByRole("switch", { name: "Grant workspace.read" }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    ).toBeChecked();
    expect(
      screen.getByText(
        "Granting agent.launch lets this device run an agent on this Mac.",
      ),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApprove).toHaveBeenCalledWith(["workspace.read", "agent.launch"]);
  });

  it("approves only the scopes left granted", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    render(
      <SessionApprovalDialog
        session={session}
        busy={false}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );

    await userEvent.click(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    );
    expect(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    ).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApprove).toHaveBeenCalledWith(["workspace.read"]);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("denies rather than approving an empty scope set", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    render(
      <SessionApprovalDialog
        session={session}
        busy={false}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );

    await userEvent.click(
      screen.getByRole("switch", { name: "Grant workspace.read" }),
    );
    await userEvent.click(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).toHaveBeenCalledOnce();
  });

  it("falls back to the truncated device id and locks the controls while busy", () => {
    render(
      <SessionApprovalDialog
        session={{ ...session, requesterDisplayName: undefined }}
        busy
        error="The remote connection could not be approved."
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", {
        name: "Allow Device 40c77568… to connect?",
      }),
    ).toBeVisible();
    expect(
      screen.getByText("The remote connection could not be approved."),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/renderer/src/remote/SessionApprovalDialog.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./SessionApprovalDialog" from "src/renderer/src/remote/SessionApprovalDialog.test.tsx". Does the file exist?`

- [ ] **Step 3: Implement**

Create `apps/desktop/src/renderer/src/remote/SessionApprovalDialog.tsx`:

```tsx
import type { PendingRemoteSession } from "@codra/protocol";
import React from "react";
import { ModalDialog } from "../components/ModalDialog";

const AGENT_LAUNCH_SCOPE = "agent.launch";

const SCOPE_LABELS: Record<string, string> = {
  "workspace.read": "Browse folders on this Mac",
  "agent.runtimes": "List the agent CLIs installed on this Mac",
  "agent.launch": "Run an agent on this Mac",
  "terminal.write": "Type into terminals on this Mac",
  "terminal.resize": "Resize terminals on this Mac",
  "terminal.detach": "Detach from terminals on this Mac",
};

export interface SessionApprovalDialogProps {
  session: PendingRemoteSession;
  busy: boolean;
  error?: string;
  onApprove(approvedScopes: string[]): void;
  onDeny(): void;
}

export function SessionApprovalDialog({
  session,
  busy,
  error,
  onApprove,
  onDeny,
}: SessionApprovalDialogProps) {
  const [deniedScopes, setDeniedScopes] = React.useState<string[]>([]);
  const denyRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    setDeniedScopes([]);
    denyRef.current?.focus();
  }, [session.sessionId]);

  const deviceLabel = `${session.clientDeviceId.slice(0, 8)}…`;
  const requesterName = session.requesterDisplayName ?? `Device ${deviceLabel}`;

  function toggleScope(scope: string): void {
    setDeniedScopes((current) =>
      current.includes(scope)
        ? current.filter((denied) => denied !== scope)
        : [...current, scope],
    );
  }

  function confirmApproval(): void {
    if (busy) return;
    const approvedScopes = session.requestedScopes.filter(
      (scope) => !deniedScopes.includes(scope),
    );
    if (approvedScopes.length === 0) {
      onDeny();
      return;
    }
    onApprove(approvedScopes);
  }

  return (
    <ModalDialog
      open
      title={`Allow ${requesterName} to connect?`}
      description={`Requesting device ${deviceLabel}. Grant only what this device needs.`}
      className="session-approval-dialog"
      onClose={() => {
        if (!busy) onDeny();
      }}
    >
      <section aria-label="Requested permissions">
        {session.requestedScopes.map((scope) => {
          const label = SCOPE_LABELS[scope];
          return (
            <div className="session-scope-row" key={scope}>
              <div>
                <strong>{label ?? scope}</strong>
                {label ? <p>{scope}</p> : null}
              </div>
              <button
                className="switch-control"
                type="button"
                role="switch"
                aria-label={`Grant ${scope}`}
                aria-checked={!deniedScopes.includes(scope)}
                disabled={busy}
                onClick={() => toggleScope(scope)}
              >
                <span className="switch-thumb" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </section>
      {session.requestedScopes.includes(AGENT_LAUNCH_SCOPE) ? (
        <p className="dialog-footnote">
          Granting agent.launch lets this device run an agent on this Mac.
        </p>
      ) : null}
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="agent-dialog-actions">
        <button
          ref={denyRef}
          className="agent-cancel-button"
          type="button"
          disabled={busy}
          onClick={onDeny}
        >
          Deny
        </button>
        <button
          className="agent-start-button"
          type="button"
          disabled={busy}
          onClick={confirmApproval}
        >
          {busy ? "Approving…" : "Approve"}
        </button>
      </footer>
    </ModalDialog>
  );
}
```

Two mechanics that make the required behaviors work, do not "simplify" them away:

- `denyRef.current?.focus()` runs in the parent's effect, which React commits _after_ `ModalDialog`'s own effect (`ModalDialog.tsx:42-45`) has focused `.modal-close-button`. That ordering is the only reason `Deny` holds default focus.
- `confirmApproval` filters `session.requestedScopes`, never `deniedScopes`, so the emitted array is a subset in request order — which is exactly what the main process re-validates against (`REMOTE_SCOPES_NOT_REQUESTED`, CONTRACT §5) — and routes an empty result to `onDeny()`, never `onApprove([])`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/renderer/src/remote/SessionApprovalDialog.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the stylesheet blocks**

Insert into `apps/desktop/src/renderer/src/styles.css` immediately after line 1600 (the closing brace of `.remote-workspace-dialog .modal-body`):

```css
.session-approval-dialog {
  width: min(520px, calc(100vw - 48px));
}

.session-approval-dialog .agent-dialog-actions {
  bottom: -22px;
  margin: 0 -22px -22px;
  padding: 12px 22px 22px;
}

.session-scope-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-top: 10px;
  padding: 9px 11px;
  background: var(--deck);
  border: 1px solid var(--steel-soft);
  border-radius: 6px;
}

.session-scope-row strong {
  color: var(--fog-soft);
  font-size: 10px;
}

.session-scope-row p {
  margin: 4px 0 0;
  color: var(--muted);
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 9px;
  line-height: 1.45;
}
```

Everything else is reused as-is: `.modal-*` via `ModalDialog`, `.switch-control` + `.switch-thumb`, `.dialog-footnote`, `.dialog-error`, `.agent-dialog-actions`, `.agent-cancel-button`, `.agent-start-button`. `.session-scope-row` is the copy of the orphaned `.agent-yolo-row` (`styles.css:1493-1515`) the reference calls for, and the second rule is the documented dialog-scoped override form (`styles.css:1594-1600`) that re-fits `.agent-dialog-actions`' `-18px` bleed to `.modal-body`'s 22px padding (`styles.css:827-829`). No entry is needed in the `margin: 0` reset list at `styles.css:97-111`, because `.session-scope-row p` sets its own margin.

- [ ] **Step 6: Verify types, lint, and the full test run**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/remote/SessionApprovalDialog.tsx apps/desktop/src/renderer/src/remote/SessionApprovalDialog.test.tsx apps/desktop/src/renderer/src/styles.css
git commit -m "feat(desktop): add renderer session approval dialog"
```

---

---

### Task 9: App wiring and native dialog removal

**Files:**

- Modify: `apps/desktop/src/renderer/src/App.tsx:1-17` (imports), `:35-37` (state), `:92-122` (subscription effect), `:299-302` (handlers), `:304-311` (derived), `:381-425` (dialog siblings)
- Modify: `apps/desktop/src/main/index.ts:104-137` (registry wiring replacing the native dialog), `:199` (`stopRemoteHost`)
- Test: `apps/desktop/src/renderer/src/App.test.tsx` (create)

**Interfaces:**

- Consumes: `CodraDesktopApi.remote.getPendingSessions(): Promise<PendingRemoteSession[]>`, `approveSession(request: ApproveRemoteSessionRequest): Promise<void>`, `rejectSession(request: RejectRemoteSessionRequest): Promise<void>`, `onPendingSessionsChanged(listener: (sessions: PendingRemoteSession[]) => void): () => void` (CONTRACT §3); `SessionApprovalRegistry` + `SessionApprovalDependencies` (CONTRACT §5); `SessionApprovalDialogProps` (Task 8); `RemoteHostControllerPort` (CONTRACT §4).
- Produces: nothing later tasks import. `tests/e2e/remote-direct.spec.ts` (Task 12) drives this surface by aria name: dialog `Allow <name> to connect?`, buttons `Approve` / `Deny`, switches `Grant <scope>`.

Two names this task introduces, because CONTRACT does not list them, and **no other task may redefine them**: the local `sessionApprovals` (the `SessionApprovalRegistry` instance in `index.ts`) and `remoteControllerPort` (the `RemoteHostControllerPort` object literal in `index.ts`). Both are function-local to `startPrimaryInstance`; neither is exported.

`App.tsx` has no test file today and reaches `window.codra` at 16 sites with no injectable api. Rather than refactor all 16 (which would touch `useTerminals`, `TerminalPane`, and `main.tsx`), this task stubs `window.codra` in the test with the same fake shape used at `useTerminals.test.tsx:26-82`. That is new for this repo, and it is deliberate: the wiring under test _is_ the global.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/App.test.tsx`:

```tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CodraDesktopApi, PendingRemoteSession } from "@codra/protocol";
import App from "./App";

void React;

const pendingSession: PendingRemoteSession = {
  sessionId: "3f0f8f1a-1f7e-4c4a-9a2f-1a2b3c4d5e6f",
  clientDeviceId: "40c77568-ae29-4af2-a57e-453ffc248a7b",
  requesterDisplayName: "Studio Mac",
  requestedScopes: ["workspace.read", "agent.launch"],
  expiresAt: 1_800_000_000_000,
};

function createDesktopApiFake() {
  let pendingListener: ((sessions: PendingRemoteSession[]) => void) | undefined;

  const api: CodraDesktopApi = {
    agents: {
      list: vi.fn().mockResolvedValue([]),
      targets: vi
        .fn()
        .mockResolvedValue([{ target: { kind: "local" }, state: "connected" }]),
      connectTarget: vi.fn(),
      listForTarget: vi.fn().mockResolvedValue([]),
      workspaceRoots: vi.fn().mockResolvedValue([]),
      workspaceList: vi.fn(),
      workspaceValidate: vi.fn(),
      onTargetsChanged: vi.fn(() => vi.fn()),
      setup: vi.fn(),
    },
    terminal: {
      defaultCwd: vi.fn().mockResolvedValue("/Users/codra"),
      chooseCwd: vi.fn().mockResolvedValue("/workspace/selected"),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      replay: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn(() => vi.fn()),
      onChanged: vi.fn(() => vi.fn()),
    },
    remote: {
      getState: vi.fn().mockResolvedValue({ state: "online" }),
      getAuthState: vi.fn().mockResolvedValue({ state: "signed_out" }),
      login: vi.fn(),
      logout: vi.fn(),
      activate: vi.fn(),
      deactivate: vi.fn(),
      onStateChanged: vi.fn(() => vi.fn()),
      onAuthStateChanged: vi.fn(() => vi.fn()),
      getPendingSessions: vi.fn().mockResolvedValue([]),
      approveSession: vi.fn().mockResolvedValue(undefined),
      rejectSession: vi.fn().mockResolvedValue(undefined),
      onPendingSessionsChanged: vi.fn((listener) => {
        pendingListener = listener;
        return vi.fn();
      }),
    },
  };

  return {
    api,
    emitPending(sessions: PendingRemoteSession[]) {
      pendingListener?.(sessions);
    },
  };
}

describe("App remote session approval", () => {
  it("pulls the pending set on mount and approves the granted scopes", async () => {
    const fake = createDesktopApiFake();
    vi.mocked(fake.api.remote.getPendingSessions).mockResolvedValue([
      pendingSession,
    ]);
    window.codra = fake.api;

    render(<App />);

    expect(fake.api.remote.getPendingSessions).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("dialog", {
        name: "Allow Studio Mac to connect?",
      }),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(fake.api.remote.approveSession).toHaveBeenCalledWith({
        sessionId: pendingSession.sessionId,
        approvedScopes: ["workspace.read"],
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Allow Studio Mac to connect?" }),
      ).toBeNull(),
    );
  });

  it("shows a session pushed after mount and denies it", async () => {
    const fake = createDesktopApiFake();
    window.codra = fake.api;

    render(<App />);

    expect(fake.api.remote.onPendingSessionsChanged).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("dialog", { name: "Allow Studio Mac to connect?" }),
    ).toBeNull();

    act(() => {
      fake.emitPending([pendingSession]);
    });

    expect(
      await screen.findByRole("dialog", {
        name: "Allow Studio Mac to connect?",
      }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(fake.api.remote.rejectSession).toHaveBeenCalledWith({
        sessionId: pendingSession.sessionId,
      }),
    );
    expect(fake.api.remote.approveSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/renderer/src/App.test.tsx`
Expected: FAIL with `AssertionError: expected "spy" to be called once, but it was called 0 times` (App never calls `getPendingSessions`)

- [ ] **Step 3: Implement the App.tsx wiring**

Four edits to `apps/desktop/src/renderer/src/App.tsx`.

(a) Imports — add `PendingRemoteSession` to the type list (alphabetically after `AgentSetupRequest`, `App.tsx:2-11`) and the component import after `NewAgentDialog` (`App.tsx:17`):

```tsx
import type {
  AgentExecutionTarget,
  AgentLaunchRequest,
  AgentLaunchTarget,
  AgentRuntime,
  AgentSetupRequest,
  PendingRemoteSession,
  RemoteAccountStatus,
  RemoteAuthProvider,
  RemoteHostStatus,
} from "@codra/protocol";
```

```tsx
import { NewAgentDialog } from "./agent/NewAgentDialog";
import { SessionApprovalDialog } from "./remote/SessionApprovalDialog";
```

(b) State — insert directly after the `accountStatus` declaration (`App.tsx:35-37`):

```tsx
const [pendingSessions, setPendingSessions] = React.useState<
  PendingRemoteSession[]
>([]);
const [approvalBusy, setApprovalBusy] = React.useState(false);
const [approvalError, setApprovalError] = React.useState<string>();
```

(c) Subscription effect — replace `App.tsx:92-122` in full. Pull-on-mount _and_ push-on-change, per the design's "Windowless case": `createWindow()` resolving does not mean the renderer is listening, so a push-only contract races and a renderer mounting after the session arrived would never learn about it.

```tsx
React.useEffect(() => {
  const stopListening = window.codra.remote.onStateChanged(setRemoteStatus);
  const stopListeningAccount =
    window.codra.remote.onAuthStateChanged(setAccountStatus);
  const stopListeningTargets =
    window.codra.agents.onTargetsChanged(setAgentTargets);
  const stopListeningPending =
    window.codra.remote.onPendingSessionsChanged(setPendingSessions);
  void window.codra.remote
    .getState()
    .then(setRemoteStatus)
    .catch(() =>
      setRemoteStatus({
        state: "error",
        message: "REMOTE_STATUS_UNAVAILABLE",
      }),
    );
  void refreshAgentRuntimes();
  void window.codra.remote
    .getAuthState()
    .then(setAccountStatus)
    .catch(() =>
      setAccountStatus({
        state: "error",
        message: "REMOTE_AUTH_UNAVAILABLE",
      }),
    );
  void window.codra.remote
    .getPendingSessions()
    .then(setPendingSessions)
    .catch(() => setPendingSessions([]));
  return () => {
    stopListening();
    stopListeningAccount();
    stopListeningTargets();
    stopListeningPending();
  };
}, [refreshAgentRuntimes, refreshAgentTargets]);
```

(d) Handlers — insert after `changeRemote` (`App.tsx:299-302`):

```tsx
async function approveSession(
  sessionId: string,
  approvedScopes: string[],
): Promise<void> {
  setApprovalBusy(true);
  setApprovalError(undefined);
  try {
    await window.codra.remote.approveSession({ sessionId, approvedScopes });
    setPendingSessions((current) =>
      current.filter((session) => session.sessionId !== sessionId),
    );
  } catch {
    setApprovalError("The remote connection could not be approved.");
  } finally {
    setApprovalBusy(false);
  }
}

async function denySession(sessionId: string): Promise<void> {
  setApprovalBusy(true);
  setApprovalError(undefined);
  try {
    await window.codra.remote.rejectSession({ sessionId });
    setPendingSessions((current) =>
      current.filter((session) => session.sessionId !== sessionId),
    );
  } catch {
    setApprovalError("The remote connection could not be denied.");
  } finally {
    setApprovalBusy(false);
  }
}
```

(e) Derived value — insert immediately before `const remoteStatusLabel =` (`App.tsx:304`):

```tsx
const pendingSession = pendingSessions.at(0);
```

(f) Dialog siblings — in the trailing fragment (`App.tsx:381-425`), gate the three existing dialogs and add the new one last:

```tsx
      <SignInDialog
        open={signInOpen && !pendingSession}
```

```tsx
      <NewAgentDialog
        open={agentDialogOpen && !pendingSession}
```

```tsx
      <SettingsDialog
        open={settingsOpen && !pendingSession}
```

```tsx
{
  pendingSession ? (
    <SessionApprovalDialog
      session={pendingSession}
      busy={approvalBusy}
      error={approvalError}
      onApprove={(approvedScopes) =>
        void approveSession(pendingSession.sessionId, approvedScopes)
      }
      onDeny={() => void denySession(pendingSession.sessionId)}
    />
  ) : null;
}
```

The `open={… && !pendingSession}` gating is the same mutual-exclusion idiom as `NewAgentDialog.tsx:230`; without it two native `<dialog>` elements are `showModal()`-open at once with overlapping `::backdrop`, and the security prompt loses.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/renderer/src/App.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Run typecheck and watch the main process fail**

Run: `pnpm typecheck`
Expected: FAIL in `apps/desktop/src/main/index.ts` at the `registerRemoteIpc({ … controller: remoteHost … })` call (`index.ts:131-137`) with `error TS2345: Argument of type '{ ipc: …; controller: RemoteHostController; … }' is not assignable to parameter of type 'RegisterRemoteIpcOptions'. Types of property 'controller' are incompatible. Type 'RemoteHostController' is not assignable to type 'RemoteHostControllerPort'.`

This is the real forcing function for the untestable file: `RemoteHostControllerPort.approveSession(request: ApproveRemoteSessionRequest): Promise<void>` (CONTRACT §4) is incompatible with `RemoteHostController.approveSession(session: RemoteSession, approvedScopes?): Promise<RemoteSession>` (`host-controller.ts:444-447`), and the controller has no `getPendingSessions`. `index.ts` must now compose the port explicitly — the controller can no longer be passed straight through. `pnpm test` alone stays green here.

- [ ] **Step 6: Replace the native dialog with the registry wiring**

In `apps/desktop/src/main/index.ts`, extend the two imports:

```ts
import {
  registerRemoteIpc,
  type RemoteHostControllerPort,
} from "./ipc/remote-ipc";
```

```ts
import { SessionApprovalRegistry } from "./remote/session-approval";
```

Then replace lines 104-137 in full — this deletes the `dialog.showMessageBox` block (the app's only Korean strings) at `index.ts:113-129`:

```ts
const sessionApprovals = new SessionApprovalRegistry({
  approve: async (session, approvedScopes) => {
    await remoteHost.approveSession(session, [...approvedScopes]);
  },
  reject: async (session) => {
    await remoteHost.rejectSession(session);
  },
  resolveRequesterName: async (session) => {
    const targets = await remoteHost.listTargets();
    for (const { target } of targets) {
      if (
        target.kind === "remote" &&
        target.deviceId === session.clientDeviceId
      ) {
        return target.displayName;
      }
    }
    return undefined;
  },
  ensureWindow: async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    await createWindow();
  },
  now: () => Date.now(),
  reportError: (error) => console.error("Remote approval failed", error),
});

const remoteHost = new RemoteHostController({
  userDataPath: app.getPath("userData"),
  reportError: (error) => console.error("Remote host error", error),
  createPeer: (peerName, iceServers) =>
    createNativePeerConnection(
      requireFromMain("node-datachannel") as NativeDataChannelModule,
      peerName,
      iceServers,
    ),
  onPendingSession: (session: RemoteSession) =>
    sessionApprovals.handlePending(session),
});

const remoteControllerPort: RemoteHostControllerPort = {
  getStatus: () => remoteHost.getStatus(),
  getAccountStatus: () => remoteHost.getAccountStatus(),
  login: (provider, parentWindow) => remoteHost.login(provider, parentWindow),
  logout: () => remoteHost.logout(),
  activate: () => remoteHost.activate(),
  deactivate: async () => {
    const status = await remoteHost.deactivate();
    sessionApprovals.clear();
    return status;
  },
  onStatusChanged: (listener) => remoteHost.onStatusChanged(listener),
  onAccountStatusChanged: (listener) =>
    remoteHost.onAccountStatusChanged(listener),
  listTargets: () => remoteHost.listTargets(),
  connectTarget: (target) => remoteHost.connectTarget(target),
  listRuntimesForTarget: (target) => remoteHost.listRuntimesForTarget(target),
  workspaceRoots: (target) => remoteHost.workspaceRoots(target),
  workspaceList: (target, path) => remoteHost.workspaceList(target, path),
  workspaceValidate: (target, path) =>
    remoteHost.workspaceValidate(target, path),
  onTargetsChanged: (listener) => remoteHost.onTargetsChanged(listener),
  getPendingSessions: () => sessionApprovals.list(),
  approveSession: (request) => sessionApprovals.approve(request),
  rejectSession: (request) => sessionApprovals.reject(request),
  onPendingSessionsChanged: (listener) => sessionApprovals.onChanged(listener),
};

registerRemoteIpc({
  ipc: ipcMain,
  controller: remoteControllerPort,
  windows: () => BrowserWindow.getAllWindows(),
  isTrustedRendererUrl: rendererUrlPolicy.isTrusted,
  reportError: (error) => console.error("Remote IPC error", error),
});
```

And replace `index.ts:199`:

```ts
    stopRemoteHost: async () => {
      sessionApprovals.clear();
      await remoteHost.stop();
    },
```

Notes so this stays wiring and nothing more:

- `resolveRequesterName` goes through `remoteHost.listTargets()` — which is `RemoteAgentClient.refreshTargets()` over `listHostDevices` (`host-controller.ts:92-95, 111-113`) — because `getSessionPeerDevice` rejects a still-`requested` session with `SESSION_NOT_CONNECTABLE` (`functions/src/index.ts:550-556`). No new controller method is added.
- `remoteHost` is referenced from inside the registry's dependency closures before its `const` is initialized. That is legal (the closures run after `activate()`), and only a _direct_ use before declaration would be a TS error.
- `[...approvedScopes]` is required: `SessionApprovalDependencies.approve` takes `readonly string[]` (CONTRACT §5) and `RemoteHostController.approveSession` takes `string[]`.
- `sessionApprovals.clear()` is called from exactly two places — `deactivate` and `stopRemoteHost` — so a deactivated host cannot approve a stale session. No other task may add a third call site.
- `dialog` stays imported: it is still used by `confirmQuitWithActiveTerminals` (`index.ts:72`) and `chooseDirectory` (`index.ts:184`). `RemoteSession` stays imported for the `onPendingSession` parameter type.

- [ ] **Step 7: Run typecheck and the full test suite**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/App.test.tsx apps/desktop/src/main/index.ts
git commit -m "feat(desktop): approve remote sessions from the renderer"
```

---

### Task 10: `scripts/scan-client-artifacts.mjs` (design Piece E)

**Files:**

- Create: `scripts/scan-client-artifacts.mjs`
- Create (Test): `scripts/test-scan-client-artifacts.mjs`
- Modify: `docs/security/remote-baseline.json:1-5` (whole file — it is 5 lines today)
- Modify: `scripts/verify-remote-build-config.mjs:146-162` (frozen script list)
- Modify: `package.json:33` (insert one line after it; **do not** re-add `scan:client-artifacts`, it already exists at line 33)

**Interfaces:**

- Consumes: nothing from earlier tasks. Reads `docs/security/remote-baseline.json` and the gitignored build trees `apps/desktop/out/{main,preload,renderer}` and `apps/web/dist`.
- Produces (later tasks and the gate rely on these exact strings):
  - CLI: `node scripts/scan-client-artifacts.mjs [--root <dir>]` — `--root` resolves the four trees under an alternate root; the baseline is always read from `process.cwd()`.
  - Baseline shape: `{ schemaVersion: 2, baselineCommit: <40-hex>, purpose: "remote-implementation-secret-scan", trees: { "desktop-main" | "desktop-preload" | "desktop-renderer" | "web": <relative path> }, rules: [{ id, kind: "literal"|"regex", pattern, trees }] }`
  - Failure strings: `Run pnpm build first: <tree path> is missing.` / `client artifact scan denied:\n<rule-id> <tree>/<file>` / `symlink is forbidden: <relative>`
  - Root script: `test:scan-client-artifacts`

**Measured corrections to the design that this task encodes (all re-verified against the current build output before writing):**

- `docs/…-design.md:235` says the bridge app id must be absent from the desktop renderer and preload. It is **present** in both — `const BRIDGE_FIREBASE_APP_ID = "1:92715578857:web:6c07f26a4866a1d4d3c778";` at `apps/desktop/out/renderer/assets/index-dwWJtCaG.js:28259` and `apps/desktop/out/preload/index.js:6352`, via the `@codra/protocol` barrel. **Only the `AIzaSy…` apiKey is path-scoped.** A bridge-app-id rule lands red on day one.
- `node-datachannel` is **present** in `apps/desktop/out/main/index.js` (`requireFromMain`, `apps/desktop/src/main/index.ts:109`). Its rule is scoped to preload/renderer/web, not "everywhere".
- The rules are **case-sensitive**. `grep -i cloudflare` hits all four trees (`"Cloudflare TURN is used only w…"` UI copy at renderer line 21918, `navigator.userAgent.includes("Cloudflare")`, `cloudflareCredentialHash`). All-caps `CLOUDFLARE` is absent everywhere.
- `grep -F "turn:"` hits `apps/desktop/out/renderer/…index-dwWJtCaG.js` on `return: async () =>`. The TURN rule is anchored `\bturns?://`, verified to match nothing today.
- Minified/unminified is handled by matching **values**, never identifiers: no rule references `DEMO_PROJECT_ID`, `Fd=`, or any binding name.

---

- [ ] **Step 1: Write the failing test**

Create `scripts/test-scan-client-artifacts.mjs`. It follows `scripts/test-functions-deploy-artifact.mjs` exactly: `mkdtemp` fixtures outside the repo, `spawnSync(process.execPath, …)`, a clean pass, a poisoned failure, and an unbuilt-tree failure.

```js
/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "codra-scan-artifacts-"));
  const trees = {
    main: join(root, "apps/desktop/out/main"),
    preload: join(root, "apps/desktop/out/preload"),
    renderer: join(root, "apps/desktop/out/renderer/assets"),
    web: join(root, "apps/web/dist/assets"),
  };
  for (const directory of Object.values(trees)) {
    await mkdir(directory, { recursive: true });
  }
  // Desktop main legitimately carries the public browser apiKey and the
  // node-datachannel require, exactly as the real release bundle does.
  await writeFile(
    join(trees.main, "index.js"),
    'const CODRA_PROJECT_ID = "codra-1b3bb";\n' +
      'const apiKey = "AIzaSyDqVsIBxX09Gv3WQJSgvE51uU4DfJU4x2o";\n' +
      'requireFromMain("node-datachannel");\n',
  );
  // Unminified desktop shape, plus the `return:` sequence that a naive
  // substring rule for "turn:" would falsely deny.
  await writeFile(
    join(trees.preload, "index.js"),
    'const BRIDGE_FIREBASE_APP_ID = "1:92715578857:web:6c07f26a4866a1d4d3c778";\n',
  );
  await writeFile(
    join(trees.renderer, "index-clean.js"),
    'const DEMO_PROJECT_ID = "demo-codra";\n' +
      'const AUTH_ORIGIN = "http://127.0.0.1:9099";\n' +
      'const FLAVOR = "remote-test";\n' +
      'const ALIAS = "password-test-only";\n' +
      "const handlers = { return: async () => undefined };\n" +
      'const label = "Cloudflare TURN is used only when required";\n',
  );
  // Minified web shape: the same values with no readable identifiers.
  await writeFile(
    join(trees.web, "index-clean.js"),
    'Fd="demo-codra",Ge="AIzaSyDqVsIBxX09Gv3WQJSgvE51uU4DfJU4x2o",Hj="1:92715578857:web:6c07f26a4866a1d4d3c778";\n',
  );
  return root;
}

function runScanner(root) {
  return spawnSync(
    process.execPath,
    ["scripts/scan-client-artifacts.mjs", "--root", root],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

const cleanRoot = await createFixtureRoot();
const clean = runScanner(cleanRoot);
assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);

const poisonedRoot = await createFixtureRoot();
await writeFile(
  join(poisonedRoot, "apps/desktop/out/renderer/assets/index-poison.js"),
  'Ee="AIzaSyPOISONPOISONPOISON99";\n',
);
await writeFile(
  join(poisonedRoot, "apps/desktop/out/preload/turn.js"),
  'const ice = "turns://relay.example.net:5349";\n',
);
await writeFile(
  join(poisonedRoot, "apps/web/dist/assets/index-poison.js"),
  "const s = process.env.CLOUDFLARE_TURN_CONFIG;\n",
);
const poisoned = runScanner(poisonedRoot);
assert.notEqual(poisoned.status, 0, "poisoned client artifacts must be denied");
assert.match(poisoned.stderr, /firebase-api-key/u);
assert.match(poisoned.stderr, /turn-url/u);
assert.match(poisoned.stderr, /turn-secret-name/u);

const emptyRoot = await mkdtemp(join(tmpdir(), "codra-scan-artifacts-empty-"));
const unbuilt = runScanner(emptyRoot);
assert.notEqual(unbuilt.status, 0, "an unbuilt tree must be denied");
assert.match(unbuilt.stderr, /Run pnpm build first/u);
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node scripts/test-scan-client-artifacts.mjs`

Expected: FAIL with an `AssertionError [ERR_ASSERTION]` whose message is the captured child stderr:

```
Error: Cannot find module '/Users/imjunhyeog/Documents/wicklim90/codra/scripts/scan-client-artifacts.mjs'
```

- [ ] **Step 3: Implement — rewrite the baseline as the rule input**

Replace all of `docs/security/remote-baseline.json`. `schemaVersion` goes `1 → 2` because the shape changes materially; nothing in `apps/`, `packages/`, `functions/`, `scripts/`, or `tests/` reads this file today, so the bump is free. `baselineCommit` and `purpose` are kept byte-identical so the file stays the tamper-evident anchor the earlier plan described.

```json
{
  "schemaVersion": 2,
  "baselineCommit": "d417c313738fd2c5718746428caf5e57b9f4e9df",
  "purpose": "remote-implementation-secret-scan",
  "trees": {
    "desktop-main": "apps/desktop/out/main",
    "desktop-preload": "apps/desktop/out/preload",
    "desktop-renderer": "apps/desktop/out/renderer",
    "web": "apps/web/dist"
  },
  "rules": [
    {
      "id": "turn-secret-name",
      "kind": "literal",
      "pattern": "CLOUDFLARE_TURN_CONFIG",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "turn-vendor-constant",
      "kind": "literal",
      "pattern": "CLOUDFLARE",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "service-account-private-key",
      "kind": "literal",
      "pattern": "private_key",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "pem-private-key",
      "kind": "regex",
      "pattern": "BEGIN[ _]+(RSA[ _]+)?PRIVATE[ _]+KEY",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "safe-storage-test-alias",
      "kind": "literal",
      "pattern": "safe-storage-test-only",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "account-bootstrap-test-alias",
      "kind": "literal",
      "pattern": "account-bootstrap-test-only",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "email-password-sign-in",
      "kind": "literal",
      "pattern": "signInWithEmailAndPassword",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "remote-test-credential-env",
      "kind": "literal",
      "pattern": "CODRA_REMOTE_TEST_EMAIL",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "remote-test-app-id",
      "kind": "literal",
      "pattern": "com.codra.desktop.remote-test",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "remote-test-product-name",
      "kind": "literal",
      "pattern": "CODRA Remote Test",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "host-bearer-token-field",
      "kind": "literal",
      "pattern": "bearerToken",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "signing-key-id-field",
      "kind": "literal",
      "pattern": "keyId",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "native-datachannel-module",
      "kind": "literal",
      "pattern": "node-datachannel",
      "trees": ["desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "developer-home-path",
      "kind": "regex",
      "pattern": "/Users/[A-Za-z0-9._-]+/",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "source-map-reference",
      "kind": "literal",
      "pattern": "sourceMappingURL",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "turn-url",
      "kind": "regex",
      "pattern": "\\bturns?://",
      "trees": ["desktop-main", "desktop-preload", "desktop-renderer", "web"]
    },
    {
      "id": "firebase-api-key",
      "kind": "regex",
      "pattern": "AIzaSy[0-9A-Za-z_-]{10,}",
      "trees": ["desktop-preload", "desktop-renderer"]
    }
  ]
}
```

- [ ] **Step 4: Implement — write the scanner**

Create `scripts/scan-client-artifacts.mjs`. `/* global process */` first line, `node:assert/strict`, top-level `await`, no try/catch around the assertions, no `process.exit`, no success output — the convention of the five existing verify scripts. The `--root` flag mirrors `--output` at `scripts/stage-functions-deploy.mjs:16-19`; the `lstat` symlink rejection mirrors `scripts/test-functions-deploy-artifact.mjs:17-39`; the missing-tree message mirrors `scripts/stage-functions-deploy.mjs:144-147`. The denial report prints rule id and path only — never the matched bytes.

```js
/* global process */

import assert from "node:assert/strict";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootIndex = process.argv.indexOf("--root");
const rootArgument = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
if (rootIndex >= 0 && !rootArgument) throw new Error("--root requires a path");
const artifactRoot = resolve(rootArgument ?? process.cwd());
const baselinePath = resolve(
  process.cwd(),
  "docs/security/remote-baseline.json",
);

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
assert.equal(
  baseline.schemaVersion,
  2,
  "remote baseline schemaVersion must be 2",
);
assert.match(
  baseline.baselineCommit,
  /^[0-9a-f]{40}$/u,
  "remote baseline baselineCommit must be a 40-hex commit id",
);
assert.equal(
  baseline.purpose,
  "remote-implementation-secret-scan",
  "remote baseline purpose must be remote-implementation-secret-scan",
);

const treeIds = Object.keys(baseline.trees).sort();
assert.deepEqual(
  treeIds,
  ["desktop-main", "desktop-preload", "desktop-renderer", "web"],
  "remote baseline must declare exactly the four client artifact trees",
);
assert.ok(
  Array.isArray(baseline.rules) && baseline.rules.length > 0,
  "remote baseline must declare at least one rule",
);
for (const rule of baseline.rules) {
  assert.match(rule.id, /^[a-z0-9-]{3,60}$/u, "rule id must be kebab-case");
  assert.ok(
    rule.kind === "literal" || rule.kind === "regex",
    `rule ${rule.id} kind must be literal or regex`,
  );
  assert.ok(
    typeof rule.pattern === "string" && rule.pattern.length > 0,
    `rule ${rule.id} must declare a pattern`,
  );
  assert.ok(
    Array.isArray(rule.trees) && rule.trees.length > 0,
    `rule ${rule.id} must declare at least one tree`,
  );
  for (const treeId of rule.trees) {
    assert.ok(
      Object.hasOwn(baseline.trees, treeId),
      `rule ${rule.id} names unknown tree ${treeId}`,
    );
  }
}

async function collectFiles(directory, prefix) {
  const collected = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolute = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(absolute);
    assert.equal(
      info.isSymbolicLink(),
      false,
      `symlink is forbidden: ${relative}`,
    );
    if (info.isDirectory())
      collected.push(...(await collectFiles(absolute, relative)));
    else collected.push([relative, await readFile(absolute, "utf8")]);
  }
  return collected;
}

const trees = new Map();
for (const treeId of treeIds) {
  const relativePath = baseline.trees[treeId];
  const absolute = resolve(artifactRoot, relativePath);
  if (!(await stat(absolute).catch(() => false)))
    throw new Error(`Run pnpm build first: ${relativePath} is missing.`);
  const files = await collectFiles(absolute, "");
  assert.ok(
    files.length > 0,
    `Run pnpm build first: ${relativePath} is empty.`,
  );
  trees.set(treeId, files);
}

const denials = [];
for (const rule of baseline.rules) {
  const expression =
    rule.kind === "regex" ? new RegExp(rule.pattern, "u") : undefined;
  for (const treeId of rule.trees) {
    for (const [relative, text] of trees.get(treeId)) {
      const denied = expression
        ? expression.test(text)
        : text.includes(rule.pattern);
      if (denied)
        denials.push(`${rule.id} ${baseline.trees[treeId]}/${relative}`);
    }
  }
}
denials.sort();
assert.equal(
  denials.length,
  0,
  `client artifact scan denied:\n${denials.join("\n")}`,
);
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `node scripts/test-scan-client-artifacts.mjs`
Expected: PASS (exit 0, no output)

- [ ] **Step 6: Run the scanner against the real build output**

This is the day-one-red check the design calls for. `pnpm build` is required first because all four trees are gitignored.

Run: `pnpm build && pnpm scan:client-artifacts`
Expected: PASS (exit 0, no output). Confirmed today against `apps/desktop/out/` and `apps/web/dist/`: `demo-codra`, `http://127.0.0.1:9099`, `password-test-only`, `remote-test`, `Cloudflare`, and the bridge app id are all present and all allowed; every declared rule matches nothing.

- [ ] **Step 7: Freeze `scan:client-artifacts` in the verify script**

Edit `scripts/verify-remote-build-config.mjs`. Insert one entry after line 153 (`"verify:firebase-indexes",`):

```js
for (const script of [
  "firebase:emulators",
  "test:firebase-rules",
  "build:remote-test",
  "package:remote-test",
  "verify:native-package",
  "verify:remote-build-config",
  "verify:firebase-indexes",
  "scan:client-artifacts",
  "test:firebase-claim-canary",
  "resume:firebase-claim-canary",
]) {
```

- [ ] **Step 8: Prove the new frozen entry bites**

The script already exists at `package.json:33`, so the added assertion cannot fail on its own. Prove it is live by removing the entry temporarily.

Run:

```bash
node -e "const fs=require('fs');const p='package.json';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('    \"scan:client-artifacts\": \"node scripts/scan-client-artifacts.mjs\",\n',''))"
node scripts/verify-remote-build-config.mjs
```

Expected: FAIL with `AssertionError [ERR_ASSERTION]: missing scan:client-artifacts script`

Then restore: `git checkout package.json` and re-run `node scripts/verify-remote-build-config.mjs` — Expected: PASS.

- [ ] **Step 9: Wire the scanner test into `package.json`**

`scripts/test-live-test-guard.mjs` and `scripts/test-firebase-claim-canary.mjs` are orphans with no script entry; do not add a third. Insert one line after `package.json:33`:

```json
    "scan:client-artifacts": "node scripts/scan-client-artifacts.mjs",
    "test:scan-client-artifacts": "node scripts/test-scan-client-artifacts.mjs",
```

Note for the record: the repo root is not a member of `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `functions`), so `pnpm test` (`pnpm -r --if-present test`) does **not** reach root scripts — `pnpm test:scan-client-artifacts` is run explicitly, exactly like `pnpm test:functions-deploy-artifact`.

- [ ] **Step 10: Run the repository gate**

Run:

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm test:scan-client-artifacts && pnpm verify:remote-build-config
```

Expected: PASS for all six. `pnpm typecheck` and `pnpm test` cannot regress here (no TypeScript changed), but they are run so a mid-plan break from an adjacent task surfaces at this commit rather than later.

- [ ] **Step 11: Commit**

```bash
git add scripts/scan-client-artifacts.mjs scripts/test-scan-client-artifacts.mjs docs/security/remote-baseline.json scripts/verify-remote-build-config.mjs package.json
git commit -m "feat(security): scan built client artifacts against the remote baseline"
```

---

---

### Task 11: Two-device remote harness (design Piece C)

**Files:**

- Create: `tests/e2e/remote-harness.ts`
- Create (Test): `tests/e2e/remote-harness.spec.ts`
- Modify: `playwright.config.ts:13-26`
- Modify: `package.json:26-27`
- Modify: `scripts/verify-remote-build-config.mjs:21-43` and `:146-163` (line numbers **after** Task 10, which added `"scan:client-artifacts",` at line 154 and grew the file to 187 lines)

**Interfaces:**

- Consumes:
  - `tests/e2e/process-cleanup.ts` — `processExists(pid: number): boolean`, `rememberDescendants(rootPid: number, knownPids: Set<number>): Promise<void>`, `terminateCapturedProcessTree(options: { rootPid?: number; knownDescendantPids: Set<number>; knownShellPid?: number }): Promise<void>`
  - `apps/desktop/out-remote-test/main/index.js` (built by `pnpm build:remote-test`)
  - `apps/desktop/src/main/remote/account-bootstrap-test-only.ts:7-35` — requires `CODRA_REMOTE_TEST_EMAIL` / `CODRA_REMOTE_TEST_PASSWORD` and provider `"email_password"`
- Produces, verbatim per CONTRACT.md §7 (Tasks 12–14 import exactly these):

```ts
export interface RemoteDeviceHandle {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  descendantPids: Set<number>;
}

export interface RemoteEmulators {
  authOrigin: string;
  firestoreOrigin: string;
  functionsOrigin: string;
  projectId: string;
}

export async function startRemoteEmulators(): Promise<
  RemoteEmulators & { stop(): Promise<void> }
>;

export async function seedRemoteTestAccount(
  emulators: RemoteEmulators,
): Promise<{ email: string; password: string }>;

export async function launchRemoteDevice(options: {
  label: string;
  email: string;
  password: string;
}): Promise<RemoteDeviceHandle>;

export async function shutdownRemoteDevices(
  devices: readonly RemoteDeviceHandle[],
): Promise<void>;
```

- **New names introduced by this task, not in CONTRACT.md §8. No other task may redefine them:** the Playwright project `remote-harness` (spec `tests/e2e/remote-harness.spec.ts`) and the script `test:remote-harness`. They exist so Piece C has its own failing-then-passing proof instead of resting on Tasks 12–14. CONTRACT.md §8's three project names and three scripts are used verbatim and unchanged.

**Facts measured on this machine before writing (not assumed):**

- Two `apps/desktop/out-remote-test/main/index.js` instances launched with distinct `CODRA_USER_DATA_DIR` both stayed alive with `exitCode: null` and both opened a window titled `CODRA`, with `getByRole("button", { name: "New terminal" })` resolving to exactly 1 in each. `--user-data-dir` was not used and must not be introduced.
- `firebase emulators:start --only auth,firestore,functions` prints `All emulators ready!` on stdout (`node_modules/firebase-tools/lib/commands/emulators-start.js:68`); `GET http://127.0.0.1:9099/` then returns `{"authEmulator":{"ready":true,…}}`; `POST …/accounts:signUp?key=demo-codra-api-key` returns 200 with `localId`/`idToken`; `SIGTERM` to the CLI exits it 0.
- If port 8080 is occupied (Docker was holding it here), `emulators:start` **exits 1** in ~6s with `Could not start Firestore Emulator, port taken.` The readiness loop therefore polls `child.exitCode` and rethrows the transcript instead of waiting out the timeout. Free ports 9099/8080/5001 are a prerequisite for `test:remote-harness`.
- `tests/e2e/**` is covered by **no** tsconfig (`apps/desktop/tsconfig{,.node,.web}.json` include only `src/**`, `electron*.config.ts`, `vitest.config.ts`; there is no root `tsconfig.json`, only `tsconfig.base.json`). Adding one would require `@types/node` and `electron` as root devDependencies — neither is installed at the root — and would newly typecheck the three existing specs. That is out of scope here, so the harness is written type-clean by hand (`buildDeviceEnv` never spreads `process.env` into Playwright's `env`, which is `Record<string, string|number|boolean>`) and its forcing function is `pnpm test:remote-harness`, not `pnpm typecheck`.

---

- [ ] **Step 1: Write the failing test for the project and script wiring**

Extend `scripts/verify-remote-build-config.mjs`. This reuses the repo's existing grep-based config assertion mechanism, which is already driven by `tests/remote-build-config.test.mjs` and by `pnpm verify:remote-build-config` in the gate.

Add `playwrightConfigText,` as the last destructured name (after `webRemoteVite,` at line 31) and `read("playwright.config.ts"),` as the last read (after `read("apps/web/vite.remote-test.config.ts"),` at line 42):

```js
const [
  workspaceYaml,
  rootPackageText,
  desktopPackageText,
  releaseVite,
  remoteVite,
  releaseBuilder,
  remoteBuilder,
  firebaseJsonText,
  webVite,
  webRemoteVite,
  playwrightConfigText,
] = await Promise.all([
  read("pnpm-workspace.yaml"),
  read("package.json"),
  read("apps/desktop/package.json"),
  read("apps/desktop/electron.vite.config.ts"),
  read("apps/desktop/electron.remote-test.vite.config.ts"),
  read("apps/desktop/electron-builder.yml"),
  read("apps/desktop/electron-builder.remote-test.yml"),
  read("firebase.json"),
  read("apps/web/vite.config.ts"),
  read("apps/web/vite.remote-test.config.ts"),
  read("playwright.config.ts"),
]);
```

Insert this block immediately after the frozen-script loop's closing `}` (line 163 after Task 10) and before the blank line preceding `for (const file of [`:

```js
for (const project of [
  "remote-harness",
  "remote-direct",
  "remote-reconnect",
  "remote-agent-workspace",
]) {
  requireText(playwrightConfigText, `name: "${project}"`, "Playwright config");
  requireText(
    playwrightConfigText,
    `testMatch: "${project}.spec.ts"`,
    "Playwright config",
  );
  assert.equal(
    rootPackage.scripts[`test:${project}`],
    `playwright test --project=${project}`,
    `test:${project} must select the ${project} project`,
  );
}
assert.equal(
  (playwrightConfigText.match(/^ {6}timeout: /gmu) ?? []).length,
  4,
  "each remote Playwright project must set its own timeout",
);
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node tests/remote-build-config.test.mjs`

Expected: FAIL with

```
AssertionError [ERR_ASSERTION]: remote build configuration verifier failed:
… AssertionError [ERR_ASSERTION]: Playwright config must include name: "remote-harness"
```

- [ ] **Step 3: Implement — add the four projects to `playwright.config.ts`**

Insert after the `packaged-native-modules` entry (line 25). The global `timeout: 60_000` at line 9 cannot cover an emulator boot plus two Electron launches, so every remote project sets its own.

```ts
    {
      name: "remote-harness",
      testMatch: "remote-harness.spec.ts",
      timeout: 600_000,
    },
    {
      name: "remote-direct",
      testMatch: "remote-direct.spec.ts",
      timeout: 300_000,
    },
    {
      name: "remote-reconnect",
      testMatch: "remote-reconnect.spec.ts",
      timeout: 300_000,
    },
    {
      name: "remote-agent-workspace",
      testMatch: "remote-agent-workspace.spec.ts",
      timeout: 300_000,
    },
```

- [ ] **Step 4: Implement — rewrite the `package.json` scripts to `--project=`**

Replace lines 26-27 (positional path filters, which load and evaluate every other project) with four `--project=` entries, matching `test:e2e` / `test:packaged` at lines 14-15:

```json
    "test:remote-harness": "playwright test --project=remote-harness",
    "test:remote-direct": "playwright test --project=remote-direct",
    "test:remote-reconnect": "playwright test --project=remote-reconnect",
    "test:remote-agent-workspace": "playwright test --project=remote-agent-workspace",
```

- [ ] **Step 5: Run the wiring test and watch it pass**

Run: `node tests/remote-build-config.test.mjs && pnpm verify:remote-build-config`
Expected: PASS (both exit 0, no output)

- [ ] **Step 6: Write the failing test for the harness itself**

Create `tests/e2e/remote-harness.spec.ts`. It exercises the whole Piece-C contract and asserts, as executable code, the empirical claim the design rests on: two isolated devices stay alive.

```ts
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { processExists } from "./process-cleanup";
import {
  launchRemoteDevice,
  seedRemoteTestAccount,
  shutdownRemoteDevices,
  startRemoteEmulators,
} from "./remote-harness";
import type { RemoteDeviceHandle } from "./remote-harness";

test("the harness runs two isolated remote-test devices against the emulators", async () => {
  expect(existsSync("apps/desktop/out-remote-test/main/index.js")).toBe(true);
  const emulators = await startRemoteEmulators();
  const devices: RemoteDeviceHandle[] = [];
  try {
    expect(emulators.projectId).toBe("demo-codra");
    expect(emulators.authOrigin).toBe("http://127.0.0.1:9099");
    expect(emulators.firestoreOrigin).toBe("http://127.0.0.1:8080");
    expect(emulators.functionsOrigin).toBe("http://127.0.0.1:5001");

    const account = await seedRemoteTestAccount(emulators);
    devices.push(await launchRemoteDevice({ label: "a", ...account }));
    devices.push(await launchRemoteDevice({ label: "b", ...account }));

    const pids = devices.map((device) => device.app.process().pid!);
    expect(new Set(pids).size).toBe(2);
    for (const pid of pids) expect(processExists(pid)).toBe(true);
    expect(devices[0].userDataDir).not.toBe(devices[1].userDataDir);
    expect(devices[0].descendantPids).not.toBe(devices[1].descendantPids);
    for (const device of devices) {
      await expect(
        device.page.getByRole("button", { name: "New terminal" }),
      ).toBeVisible();
    }

    const launched = devices.splice(0, devices.length);
    await shutdownRemoteDevices(launched);
    for (const pid of pids) {
      await expect.poll(() => processExists(pid)).toBe(false);
    }
  } finally {
    try {
      if (devices.length > 0) await shutdownRemoteDevices(devices);
    } finally {
      await emulators.stop();
    }
  }
});
```

- [ ] **Step 7: Run the harness test and watch it fail**

Run: `pnpm build:remote-test && pnpm test:remote-harness`

Expected: FAIL with

```
Error: Cannot find module './remote-harness'
Require stack:
- /Users/imjunhyeog/Documents/wicklim90/codra/tests/e2e/remote-harness.spec.ts
…
Error: No tests found
```

- [ ] **Step 8: Implement — write `tests/e2e/remote-harness.ts`**

```ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import {
  rememberDescendants,
  terminateCapturedProcessTree,
} from "./process-cleanup";

// Mirrors packages/protocol/src/deployment.ts:133-146 (emulatorDeployment).
// tests/ is not a pnpm workspace member, so @codra/protocol is not resolvable
// from this file and the origins are restated rather than imported.
const EMULATOR_PROJECT_ID = "demo-codra";
const EMULATOR_AUTH_ORIGIN = "http://127.0.0.1:9099";
const EMULATOR_FIRESTORE_ORIGIN = "http://127.0.0.1:8080";
const EMULATOR_FUNCTIONS_ORIGIN = "http://127.0.0.1:5001";
// packages/firebase/src/index.ts:68 (DEMO_FIREBASE_OPTIONS.apiKey).
const EMULATOR_API_KEY = "demo-codra-api-key";
const EMULATOR_READY_TIMEOUT_MS = 300_000;
const DEVICE_LIVENESS_SETTLE_MS = 1_000;

const firebaseBin = path.resolve("node_modules/.bin/firebase");
const remoteTestMainEntry = path.resolve(
  "apps/desktop/out-remote-test/main/index.js",
);

export interface RemoteDeviceHandle {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  descendantPids: Set<number>;
}

export interface RemoteEmulators {
  authOrigin: string;
  firestoreOrigin: string;
  functionsOrigin: string;
  projectId: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let transcript = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      transcript += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      transcript += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code}:\n${transcript}`,
          ),
        );
    });
  });
}

function buildDeviceEnv(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  return { ...env, ...overrides };
}

export async function startRemoteEmulators(): Promise<
  RemoteEmulators & { stop(): Promise<void> }
> {
  await runCommand("pnpm", ["--filter", "@codra/protocol", "build"]);
  await runCommand("pnpm", ["--filter", "@codra/functions", "build"]);
  await runCommand("pnpm", ["run", "stage:functions-deploy"]);
  await runCommand("pnpm", [
    "--dir",
    "functions-deploy-build",
    "install",
    "--frozen-lockfile",
  ]);

  // `--only auth,firestore,functions` is mandatory: firebase.json declares a
  // `hosting` key, and the Hosting emulator is skipped only when that key is
  // absent (firebase-tools/lib/emulator/controller.js:125-128).
  const child = spawn(
    firebaseBin,
    [
      "emulators:start",
      "--only",
      "auth,firestore,functions",
      "--config",
      "firebase.json",
      "--project",
      EMULATOR_PROJECT_ID,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const emulatorPid = child.pid;
  const emulatorDescendantPids = new Set<number>();
  let transcript = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    transcript += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    transcript += chunk;
  });

  const stop = async (): Promise<void> => {
    if (emulatorPid === undefined) return;
    await terminateCapturedProcessTree({
      rootPid: emulatorPid,
      knownDescendantPids: emulatorDescendantPids,
    });
  };

  const deadline = Date.now() + EMULATOR_READY_TIMEOUT_MS;
  while (!transcript.includes("All emulators ready")) {
    if (child.exitCode !== null) {
      throw new Error(
        `Firebase emulators exited with ${child.exitCode} before becoming ready:\n${transcript}`,
      );
    }
    if (Date.now() >= deadline) {
      await stop();
      throw new Error(`Firebase emulators never became ready:\n${transcript}`);
    }
    await sleep(250);
  }
  // Capture the Java Firestore child while the CLI is still alive; a plain
  // SIGTERM to the CLI does not reap it.
  if (emulatorPid !== undefined) {
    await rememberDescendants(emulatorPid, emulatorDescendantPids);
  }

  try {
    const authRoot = (await (
      await fetch(`${EMULATOR_AUTH_ORIGIN}/`)
    ).json()) as { authEmulator?: { ready?: boolean } };
    if (authRoot.authEmulator?.ready !== true) {
      throw new Error(`Auth emulator did not report ready:\n${transcript}`);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    authOrigin: EMULATOR_AUTH_ORIGIN,
    firestoreOrigin: EMULATOR_FIRESTORE_ORIGIN,
    functionsOrigin: EMULATOR_FUNCTIONS_ORIGIN,
    projectId: EMULATOR_PROJECT_ID,
    stop,
  };
}

export async function seedRemoteTestAccount(
  emulators: RemoteEmulators,
): Promise<{ email: string; password: string }> {
  const email = `remote-harness-${randomUUID()}@example.com`;
  const password = `harness-${randomUUID()}`;
  const response = await fetch(
    `${emulators.authOrigin}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${EMULATOR_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Auth emulator rejected the seeded account (${response.status}): ${await response.text()}`,
    );
  }
  const created = (await response.json()) as { localId?: string };
  if (!created.localId) {
    throw new Error("Auth emulator returned no localId for the seeded account");
  }
  return { email, password };
}

export async function launchRemoteDevice(options: {
  label: string;
  email: string;
  password: string;
}): Promise<RemoteDeviceHandle> {
  const userDataDir = await mkdtemp(
    path.join(tmpdir(), `codra-remote-${options.label}-`),
  );
  const descendantPids = new Set<number>();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [remoteTestMainEntry],
      env: buildDeviceEnv({
        CODRA_USER_DATA_DIR: userDataDir,
        CODRA_REMOTE_TEST_EMAIL: options.email,
        CODRA_REMOTE_TEST_PASSWORD: options.password,
      }),
    });
    const pid = app.process().pid;
    if (pid === undefined) {
      throw new Error(`Device ${options.label} reported no process id`);
    }
    // single-instance.ts:40-43 calls app.exit(0) when the lock is taken, which
    // is silent and returns success. Assert liveness rather than waiting on
    // firstWindow(), which would only hang until the project timeout.
    await sleep(DEVICE_LIVENESS_SETTLE_MS);
    if (app.process().exitCode !== null) {
      throw new Error(
        `Device ${options.label} exited with ${app.process().exitCode} during startup; CODRA_USER_DATA_DIR isolation failed`,
      );
    }
    const page = await app.firstWindow();
    await rememberDescendants(pid, descendantPids);
    return { app, page, userDataDir, descendantPids };
  } catch (error) {
    const pid = app?.process().pid;
    if (pid !== undefined) {
      await terminateCapturedProcessTree({
        rootPid: pid,
        knownDescendantPids: descendantPids,
      }).catch(() => undefined);
    }
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

export async function shutdownRemoteDevices(
  devices: readonly RemoteDeviceHandle[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const device of devices) {
    try {
      await terminateCapturedProcessTree({
        rootPid: device.app.process().pid,
        knownDescendantPids: device.descendantPids,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(device.userDataDir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Remote device shutdown failed");
  }
}
```

- [ ] **Step 9: Run the harness test and watch it pass**

Prerequisite: TCP 9099, 8080, and 5001 must be free, and a JDK must be installed for the Firestore emulator. If 8080 is taken the run fails in seconds with the CLI's own message (`Could not start Firestore Emulator, port taken.`) surfaced through `Firebase emulators exited with 1 before becoming ready:` — free the port and re-run.

Run: `pnpm build:remote-test && pnpm test:remote-harness`
Expected: PASS — `1 passed`

- [ ] **Step 10: Confirm the emulators and both devices left nothing behind**

Run:

```bash
ps -axo pid=,command= | grep -E "firebase|CODRA Remote Test|out-remote-test" | grep -v grep
ls /tmp | grep -E "^codra-remote-" || true
```

Expected: no output from either command.

- [ ] **Step 11: Run the repository gate**

Run:

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm verify:remote-build-config && pnpm scan:client-artifacts
```

Expected: PASS for all six. `pnpm typecheck` does not reach `tests/e2e/**` (see the measured facts above) — it is run here so a break introduced by an adjacent task surfaces at this commit, and the real forcing functions for this task are `pnpm test:remote-harness` (Step 9) and `pnpm verify:remote-build-config`. `pnpm test:remote-direct`, `pnpm test:remote-reconnect`, and `pnpm test:remote-agent-workspace` correctly fail with `Error: No tests found` until Tasks 12–14 create their spec files.

- [ ] **Step 12: Commit**

```bash
git add tests/e2e/remote-harness.ts tests/e2e/remote-harness.spec.ts playwright.config.ts package.json scripts/verify-remote-build-config.mjs
git commit -m "test(remote): add the two-device remote end-to-end harness"
```

---

### Task 12: `remote-direct` end-to-end spec

**Files:**

- Create: `tests/e2e/remote-direct.spec.ts`
- Test: `tests/e2e/remote-direct.spec.ts` (the spec _is_ the test)
- Read-only dependency: `playwright.config.ts:31-35` (the `remote-direct` project, added by the harness task) and `package.json:27` (`"test:remote-direct": "playwright test --project=remote-direct"`). **Do not re-add either** — they already exist; this task only adds the spec file that those two entries name.

**Interfaces:**

- Consumes (harness, frozen — `tests/e2e/remote-harness.ts`):
  - `startRemoteEmulators(): Promise<RemoteEmulators & { stop(): Promise<void> }>`
  - `seedRemoteTestAccount(emulators: RemoteEmulators): Promise<{ email: string; password: string }>`
  - `launchRemoteDevice(options: { label: string; email: string; password: string }): Promise<RemoteDeviceHandle>`
  - `shutdownRemoteDevices(devices: readonly RemoteDeviceHandle[]): Promise<void>`
  - `interface RemoteDeviceHandle { app: ElectronApplication; page: Page; userDataDir: string; descendantPids: Set<number> }`
- Consumes (main, frozen contract §10): `resolveDeviceDisplayName(hostname: string): string` from `apps/desktop/src/main/remote/device-name.ts`. That module is electron-free by contract, which is why a Playwright spec may import it directly.
- Consumes (renderer, frozen contract §6): the approval modal's `ModalDialog` `className` is `session-approval-dialog`, so the dialog element is `dialog.modal-dialog.session-approval-dialog` (`ModalDialog.tsx:67` composes `className={\`modal-dialog ${className}\`.trim()}`). Its two actions are named `Approve`and`Deny` (design B, "Design" bullet 4).
- Consumes (protocol): `window.codra.remote.login("email_password")`, `window.codra.remote.activate()`, `window.codra.agents.targets()`, `window.codra.agents.connectTarget(target)`, `window.codra.agents.listForTarget(target)` — all present at `packages/protocol/src/desktop-api.ts` and routed by `apps/desktop/src/main/ipc/remote-ipc.ts:161-268`.
- Produces: nothing importable. It is the acceptance proof that Pieces A/B/C are wired together.

Sign-in is driven through `page.evaluate` and not through the UI because the `Email and password — test only` button at `apps/desktop/src/renderer/src/account/SignInDialog.tsx:73-90` carries `disabled` and has **no** `onClick`; it never calls `onProvider("email_password")` in either build flavor.

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/remote-direct.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { resolveDeviceDisplayName } from "../../apps/desktop/src/main/remote/device-name";
import {
  launchRemoteDevice,
  seedRemoteTestAccount,
  shutdownRemoteDevices,
  startRemoteEmulators,
  type RemoteDeviceHandle,
} from "./remote-harness";

const remoteMainEntry = path.resolve(
  "apps/desktop/out-remote-test/main/index.js",
);

interface RemoteTarget {
  kind: "remote";
  deviceId: string;
  displayName: string;
}

test("approves a remote session in the renderer and completes the hello handshake", async () => {
  test.skip(
    process.platform !== "darwin",
    "two-device remote harness is macOS",
  );
  expect(
    existsSync(remoteMainEntry),
    `${remoteMainEntry} is missing. Run: pnpm build:remote-test`,
  ).toBe(true);

  const emulators = await startRemoteEmulators();
  const devices: RemoteDeviceHandle[] = [];
  try {
    const account = await seedRemoteTestAccount(emulators);
    const client = await launchRemoteDevice({ label: "client", ...account });
    devices.push(client);
    const host = await launchRemoteDevice({ label: "host", ...account });
    devices.push(host);

    for (const device of devices) {
      const signedIn = await device.page.evaluate(() =>
        window.codra.remote.login("email_password"),
      );
      expect(signedIn.state).toBe("signed_in");
      const online = await device.page.evaluate(() =>
        window.codra.remote.activate(),
      );
      expect(online).toEqual({ state: "online" });
    }

    let hostTarget: RemoteTarget | undefined;
    await expect
      .poll(
        async () => {
          const targets = await client.page.evaluate(() =>
            window.codra.agents.targets(),
          );
          hostTarget = targets
            .map((entry) => entry.target)
            .find((target): target is RemoteTarget => target.kind === "remote");
          return hostTarget === undefined ? 0 : 1;
        },
        { timeout: 60_000, message: "the client never discovered the host" },
      )
      .toBe(1);

    let connectFailure: unknown;
    const connection = client.page
      .evaluate(
        (target) => window.codra.agents.connectTarget(target),
        hostTarget!,
      )
      .catch((error: unknown) => {
        connectFailure = error;
        return undefined;
      });

    const approval = host.page.locator("dialog.session-approval-dialog");
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(approval).toContainText(resolveDeviceDisplayName(hostname()));
    await expect(approval).toContainText("agent.launch");
    await expect(approval.getByRole("button", { name: "Deny" })).toBeVisible();
    await approval.getByRole("button", { name: "Approve" }).click();
    await expect(approval).toBeHidden();

    const connected = await connection;
    expect(
      connectFailure,
      `connectTarget rejected: ${String(connectFailure)}`,
    ).toBeUndefined();
    expect(connected).toEqual({ target: hostTarget, state: "connected" });

    const runtimes = await client.page.evaluate(
      (target) => window.codra.agents.listForTarget(target),
      hostTarget!,
    );
    expect(runtimes.map((runtime) => runtime.kind).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
      "ollama",
    ]);
  } finally {
    try {
      await shutdownRemoteDevices(devices);
    } finally {
      await emulators.stop();
    }
  }
});
```

- [ ] **Step 2: Run the test and watch the build guard fail**

Run: `rm -rf apps/desktop/out-remote-test && pnpm test:remote-direct`
Expected: FAIL with `Error: expect(received).toBe(expected)` carrying the message `/…/apps/desktop/out-remote-test/main/index.js is missing. Run: pnpm build:remote-test`

- [ ] **Step 3: Build the remote-test bundle the spec requires**

Run: `pnpm build:remote-test`
Expected: exit 0, and `apps/desktop/out-remote-test/main/index.js` exists again.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm test:remote-direct`
Expected: PASS — `1 passed`

- [ ] **Step 5: Run the repository checks**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all four exit 0.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/remote-direct.spec.ts
git commit -m "test(e2e): prove renderer session approval and hello handshake across two devices"
```

---

---

### Task 13: `remote-reconnect` end-to-end spec (and the resume capability it proves)

**Read this before starting.** The design assumes cross-break cursor continuity already works. It does not. Three facts, measured in the current tree:

1. `REMOTE_AGENT_SCOPES` (`apps/desktop/src/main/remote/host-control-gateway.ts:35-42`) does **not** contain `terminal.attach`, so a client can never re-attach after a transport drop.
2. `RemoteAgentChannelClient` has `detach` but no `attach` (`apps/desktop/src/main/remote/remote-agent-client.ts:404-415`), and `ProxyTerminalRouter` has no resume path — a dropped remote terminal is permanently `exited` (`proxy-terminal-router.ts:311-320`).
3. `ProxyTerminalRouter.acceptFrame` acknowledges `session.nextCursor` for an already-seen frame (`proxy-terminal-router.ts:258-261`). During a replay the host's `AttachmentPump` has only sent up to `sentCursor`, and `AttachmentPump.acknowledge` throws `OUTPUT_CURSOR_INVALID` when `cursor > sentCursor` (`packages/webrtc/src/attachment-pump.ts:85-89`), which `handleHostControl` turns into a full session teardown (`desktop-peer-connector.ts:426-435`).

So this task builds the capability first (steps 1–16, each with a failing unit test), then writes the spec (steps 17–22). Granting `terminal.attach` is only safe together with the ownership rule in step 3: without it, `terminal.attach` would let a peer stream **any** terminal on the host, including local ones, because the handler checks existence only (`host-control-gateway.ts:476-483`).

**Files:**

- Modify: `apps/desktop/src/main/remote/host-control-gateway.ts:35-42` (scope list), `:63-75` (options), `:194-195` (owned set), `:340-342` (close), `:476-489` (attach handler)
- Modify: `apps/desktop/src/main/remote/host-control-gateway.test.ts:161-166` (harness signature) and append one test
- Modify: `apps/desktop/src/main/remote/remote-agent-client.ts:404-415`, `:598-611`
- Modify: `apps/desktop/src/main/remote/remote-agent-client.test.ts` (append one test)
- Modify: `apps/desktop/src/main/remote/proxy-terminal-router.ts:28-44`, `:150-162`, `:236-289`
- Modify: `apps/desktop/src/main/remote/proxy-terminal-router.test.ts:65-77` (peer fake) and append one test
- Modify: `apps/desktop/src/main/remote/desktop-peer-connector.ts:52-63`, `:110-200`
- Modify: `apps/desktop/src/main/remote/host-controller.ts:62-76`, `:230-247`, `:401-407`
- Modify: `apps/desktop/src/main/index.ts:177-178`
- Create: `tests/e2e/remote-fake-agent.ts`
- Create: `tests/e2e/remote-reconnect.spec.ts`
- Read-only dependency: `playwright.config.ts:36-40` and `package.json:28` already name the `remote-reconnect` project.

**Interfaces:**

- Consumes: the Task 12 harness exports, unchanged.
- Consumes: `CODRA_REMOTE_TEST_AUTO_APPROVE` — the Piece-B auto-response seam. **This plan freezes that name**; the remote-test build auto-approves every pending session with its full `requestedScopes` when the main process sees `process.env.CODRA_REMOTE_TEST_AUTO_APPROVE === "1"`. The spec sets it on `process.env` before `launchRemoteDevice`, because `launchRemoteDevice`'s frozen options are only `{ label, email, password }` and the harness spreads `...process.env` into each device. No other task may rename it.
- Produces (new names, frozen by this task, no other task may redefine them):
  - `HostControlGatewayOptions.ownedTerminals?: Set<string>`
  - `RemoteAgentChannelClient.attach(terminalId: string): Promise<void>`
  - `RemoteAgentPeerPort.attach(terminalId: string): Promise<void>`
  - `ProxyTerminalRouter.resume(target: RemoteAgentExecutionTarget): Promise<void>`
  - `DesktopPeerConnectorOptions.terminalOwners: Map<string, Set<string>>`
  - `tests/e2e/remote-fake-agent.ts` → `installFakeClaudeAgent(): Promise<FakeAgentInstallation>`, `interface FakeAgentInstallation { binDirectory: string; remove(): Promise<void> }`
  - `"terminal.attach"` appended to `REMOTE_AGENT_SCOPES` — the approval modal now lists seven scopes instead of six.

- [ ] **Step 1: Write the failing gateway ownership test**

In `apps/desktop/src/main/remote/host-control-gateway.test.ts`, change the harness signature at line 161 from `async function createHarness(scopes: readonly string[]) {` to:

```ts
async function createHarness(
  scopes: readonly string[],
  ownedTerminals?: Set<string>,
) {
```

and add `ownedTerminals,` to the `new HostControlGateway({ … })` options object immediately after `outputStore: { … },`. Then append this test inside the existing `describe("HostControlGateway", …)` block:

```ts
it("attaches only to terminals this client launched, across sessions", async () => {
  const owned = new Set<string>();
  const harness = await createHarness(["terminal.attach"], owned);
  await harness.authorize();

  await harness.gateway.handleControl({
    type: "terminal.attach",
    requestId: "attach-unowned",
    terminalId,
  });
  expect(harness.control.at(-1)).toEqual({
    type: "terminal.error",
    requestId: "attach-unowned",
    code: "TERMINAL_NOT_FOUND",
    message: "TERMINAL_NOT_FOUND",
  });
  expect(harness.terminalFrames).toHaveLength(0);

  owned.add(terminalId);
  await harness.gateway.handleControl({
    type: "terminal.attach",
    requestId: "attach-owned",
    terminalId,
  });
  expect(harness.control.at(-1)).toEqual({
    type: "terminal.ok",
    requestId: "attach-owned",
    operation: "terminal.attach",
    result: { terminalId },
  });
  expect(decodeOutputFrameBinary(harness.terminalFrames[0]!)).toMatchObject({
    terminalId,
    cursor: 0n,
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/host-control-gateway.test.ts`
Expected: FAIL — the first assertion receives `{ type: "terminal.ok", requestId: "attach-unowned", operation: "terminal.attach", result: { terminalId } }` instead of the `TERMINAL_NOT_FOUND` error, because the handler accepts any existing terminal.

- [ ] **Step 3: Implement gateway-side ownership**

In `apps/desktop/src/main/remote/host-control-gateway.ts`, add one field to the options interface (after `terminalSender: BinaryOutputChannel;` at line 73):

```ts
  ownedTerminals?: Set<string>;
```

Replace line 195 `private readonly owned = new Set<string>();` with:

```ts
  private readonly owned: Set<string>;
```

and add, as the first statement of the constructor body (before `this.session = …`):

```ts
this.owned = options.ownedTerminals ?? new Set<string>();
```

Delete `this.owned.clear();` from `close()` (line 342) — ownership now outlives one session and is owned by the connector.

Replace the `terminal.attach` case body (lines 476-489) with:

```ts
      case "terminal.attach": {
        this.requireScope("terminal.attach");
        if (!this.owned.has(message.terminalId)) this.terminalNotFound();
        const exists = (await this.options.manager.list()).some(
          (terminal) => terminal.id === message.terminalId,
        );
        if (!exists) this.terminalNotFound();
        await this.attach(message.terminalId);
        this.sendTerminalOk(
          message.requestId,
          "terminal.attach",
          message.terminalId,
        );
        return;
      }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/host-control-gateway.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing client-attach test**

Append to `describe("RemoteAgentChannelClient", …)` in `apps/desktop/src/main/remote/remote-agent-client.test.ts`:

```ts
it("re-attaches an existing remote terminal over the control channel", async () => {
  const { client, control } = await harness();
  const attach = client.attach(terminalId);
  await vi.waitFor(() => expect(control.sent).toHaveLength(2));
  const request = decodeRemoteControlMessage(control.sent.at(-1)!);
  expect(request).toMatchObject({ type: "terminal.attach", terminalId });
  if (!("requestId" in request)) throw new Error("missing request id");
  control.emit(
    encodeRemoteControlMessageBinary({
      type: "terminal.ok",
      requestId: request.requestId,
      operation: "terminal.attach",
      result: { terminalId },
    }),
  );

  await expect(attach).resolves.toBeUndefined();
});
```

- [ ] **Step 6: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/remote-agent-client.test.ts`
Expected: FAIL with `TypeError: client.attach is not a function`

- [ ] **Step 7: Implement `RemoteAgentChannelClient.attach`**

In `apps/desktop/src/main/remote/remote-agent-client.ts`, insert immediately before `async detach(` (line 404):

```ts
  async attach(terminalId: string): Promise<void> {
    await this.expectTerminalOk(
      await this.request({
        type: "terminal.attach",
        requestId: randomUUID(),
        terminalId,
      }),
      "terminal.attach",
      terminalId,
    );
  }
```

and widen the `operation` parameter of `expectTerminalOk` (line 600) to:

```ts
    operation:
      | "terminal.attach"
      | "terminal.write"
      | "terminal.resize"
      | "terminal.detach",
```

- [ ] **Step 8: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/remote-agent-client.test.ts`
Expected: PASS

- [ ] **Step 9: Write the failing router-resume test**

In `apps/desktop/src/main/remote/proxy-terminal-router.test.ts`, add `readonly attach = vi.fn(async () => undefined);` to `PeerFake` immediately after the `launch` field (line 73), then append this test inside `describe("ProxyTerminalRouter", …)`:

```ts
it("resumes a dropped remote terminal and acknowledges replayed frames at their own boundary", async () => {
  const { peer, router } = setup();
  const chunks: TerminalOutputChunk[] = [];
  router.onOutput((chunk) => chunks.push(chunk));
  await router.create({
    target,
    cwd: "/Users/remote/project",
    cols: 100,
    rows: 30,
    agent,
  });
  peer.emitOutput({
    terminalId,
    cursor: 0n,
    data: new TextEncoder().encode("one"),
  });
  peer.disconnect();

  await router.resume(target);

  expect(peer.attach).toHaveBeenCalledWith(terminalId);
  peer.emitOutput({
    terminalId,
    cursor: 0n,
    data: new TextEncoder().encode("one"),
  });
  peer.emitOutput({
    terminalId,
    cursor: 3n,
    data: new TextEncoder().encode("two"),
  });

  expect(chunks).toEqual([
    { terminalId, sequence: 1, data: "one" },
    { terminalId, sequence: 2, data: "two" },
  ]);
  expect(peer.acknowledge).toHaveBeenNthCalledWith(2, terminalId, 3n);
  await expect(
    router.replay({ terminalId, afterSequence: 0, limit: 10 }),
  ).resolves.toEqual(chunks);
  await router.write({ terminalId, data: "ls\r" });
  expect(peer.write).toHaveBeenCalledWith(terminalId, "ls\r");
});
```

- [ ] **Step 10: Run the test and watch it fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/proxy-terminal-router.test.ts`
Expected: FAIL with `TypeError: router.resume is not a function`

- [ ] **Step 11: Implement `ProxyTerminalRouter.resume` and the replay acknowledgement fix**

In `apps/desktop/src/main/remote/proxy-terminal-router.ts`, add to `RemoteAgentPeerPort` (after `launch(…)`, line 35):

```ts
  attach(terminalId: string): Promise<void>;
```

Add a field beside `remoteTerminalIds` (line 70):

```ts
  private readonly resuming = new Set<string>();
```

Add this public method immediately after `create(…)` (line 149):

```ts
  async resume(target: RemoteAgentExecutionTarget): Promise<void> {
    const peer = this.resolvePeer(target);
    this.ensurePeer(peer);
    for (const [terminalId, session] of this.remoteSessions) {
      const origin = session.descriptor.origin;
      if (session.connected || !session.visible) continue;
      if (origin?.kind !== "remote" || origin.deviceId !== target.deviceId) {
        continue;
      }
      if (this.resuming.has(terminalId)) continue;
      this.resuming.add(terminalId);
      session.peer = peer;
      session.connected = true;
      try {
        await peer.attach(terminalId);
        session.descriptor = {
          ...session.descriptor,
          state: "running",
          exitCode: undefined,
        };
        this.publishChanged(session.descriptor);
      } catch (error) {
        this.disconnectSession(session);
        throw error;
      } finally {
        this.resuming.delete(terminalId);
      }
    }
  }
```

Replace the duplicate-frame acknowledgement inside `acceptFrame` (line 259) — `session.peer.acknowledge(frame.terminalId, session.nextCursor);` — with:

```ts
session.peer.acknowledge(frame.terminalId, frameEnd);
```

The host's pump has only sent up to its own `sentCursor` during a replay, so acknowledging the local cursor tears the session down; acknowledging the frame's own end is monotonic and always within `sentCursor`.

- [ ] **Step 12: Run the test and watch it pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/proxy-terminal-router.test.ts`
Expected: PASS

- [ ] **Step 13: Grant the scope and carry ownership across sessions**

In `apps/desktop/src/main/remote/host-control-gateway.ts:35-42`, append one entry to `REMOTE_AGENT_SCOPES` so it reads:

```ts
export const REMOTE_AGENT_SCOPES = [
  "workspace.read",
  "agent.runtimes",
  "agent.launch",
  "terminal.write",
  "terminal.resize",
  "terminal.detach",
  "terminal.attach",
] as const;
```

In `apps/desktop/src/main/remote/desktop-peer-connector.ts`, add to `DesktopPeerConnectorOptions` (after `device: RemoteDevice;`, line 56):

```ts
terminalOwners: Map<string, Set<string>>;
```

add this private method to `DesktopPeerConnector` (immediately before `private async createSession(`, line 212):

```ts
  private ownedTerminalsFor(clientDeviceId: string): Set<string> {
    const existing = this.options.terminalOwners.get(clientDeviceId);
    if (existing) return existing;
    const created = new Set<string>();
    this.options.terminalOwners.set(clientDeviceId, created);
    return created;
  }
```

and pass it into the gateway construction in `acceptHostSession` by adding one property to the `new HostControlGateway({ … })` literal, immediately after `outputStore: services.outputStore,` (line 175):

```ts
            ownedTerminals: this.ownedTerminalsFor(session.clientDeviceId),
```

In `apps/desktop/src/main/remote/host-controller.ts`, add the surviving registry beside `promptedSessions` (line 76):

```ts
  private readonly terminalOwners = new Map<string, Set<string>>();
```

pass it into the connector at line 401-407 by adding one property after `device,`:

```ts
        terminalOwners: this.terminalOwners,
```

and clear it in `logout()` only — add `this.terminalOwners.clear();` immediately after `this.identity = undefined;` (line 240). It must **not** be cleared in `stopHostResources`, or `deactivate()` would destroy the ownership that reconnect depends on.

- [ ] **Step 14: Run the unit suite and the typechecker**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0. `pnpm typecheck` is the forcing function here — `terminalOwners` is a required option, so any `new DesktopPeerConnector({…})` that omits it fails to compile.

- [ ] **Step 15: Wire resume into the main process**

In `apps/desktop/src/main/index.ts`, replace lines 177-178:

```ts
    createTerminalRouter: (manager) =>
      new ProxyTerminalRouter(manager, (target) => remoteHost.peerFor(target)),
```

with:

```ts
    createTerminalRouter: (manager) => {
      const router = new ProxyTerminalRouter(manager, (target) =>
        remoteHost.peerFor(target),
      );
      remoteHost.onTargetsChanged((targets) => {
        for (const entry of targets) {
          if (entry.target.kind !== "remote" || entry.state !== "connected") {
            continue;
          }
          void router
            .resume(entry.target)
            .catch((error) => console.error("Remote resume failed", error));
        }
      });
      return router;
    },
```

`resume` is a no-op for every already-connected session, so the repeated `connected` publishes from `refreshTargets` cost nothing.

- [ ] **Step 16: Typecheck the wiring**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 17: Add the deterministic fake agent**

Create `tests/e2e/remote-fake-agent.ts`:

```ts
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FAKE_CLAUDE = `#!/bin/sh
printf 'CODRA_FAKE_AGENT_READY %s\\n' "$*"
(
  tick=0
  while [ "$tick" -lt 900 ]; do
    tick=$((tick + 1))
    printf 'CODRA_FAKE_AGENT_TICK %s\\n' "$tick"
    sleep 0.2
  done
) &
ticker=$!
while IFS= read -r line; do
  case "$line" in
    size) printf 'CODRA_FAKE_AGENT_SIZE %s\\n' "$(stty size | tr ' ' 'x')" ;;
    where) printf 'CODRA_FAKE_AGENT_CWD %s\\n' "$(pwd)" ;;
    quit) break ;;
    *) printf 'CODRA_FAKE_AGENT_ECHO %s\\n' "$line" ;;
  esac
done
kill "$ticker" 2>/dev/null
`;

export interface FakeAgentInstallation {
  binDirectory: string;
  remove(): Promise<void>;
}

export async function installFakeClaudeAgent(): Promise<FakeAgentInstallation> {
  const binDirectory = await mkdtemp(path.join(tmpdir(), "codra-fake-agent-"));
  const executable = path.join(binDirectory, "claude");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);
  return {
    binDirectory,
    remove: () => rm(binDirectory, { recursive: true, force: true }),
  };
}
```

`claude` is the chosen kind because its profile needs no model and no discovery subprocess (`agent-runtime.ts:87-101`, `modelRequired: false`; `discoverModels` only shells out for `codex` and `ollama`). Prepending `binDirectory` to `PATH` wins over a real `claude`, because `candidateExecutables` walks `PATH` in order (`agent-runtime.ts:187-209`).

- [ ] **Step 18: Write the failing reconnect spec**

Create `tests/e2e/remote-reconnect.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path, { delimiter } from "node:path";
import { installFakeClaudeAgent } from "./remote-fake-agent";
import {
  launchRemoteDevice,
  seedRemoteTestAccount,
  shutdownRemoteDevices,
  startRemoteEmulators,
  type RemoteDeviceHandle,
} from "./remote-harness";

const remoteMainEntry = path.resolve(
  "apps/desktop/out-remote-test/main/index.js",
);

interface RemoteTarget {
  kind: "remote";
  deviceId: string;
  displayName: string;
}

async function replayText(page: Page, terminalId: string): Promise<string> {
  const chunks = await page.evaluate(
    (id) =>
      window.codra.terminal.replay({
        terminalId: id,
        afterSequence: 0,
        limit: 1000,
      }),
    terminalId,
  );
  return chunks.map((chunk) => chunk.data).join("");
}

function tickNumbers(text: string): number[] {
  return [...text.matchAll(/CODRA_FAKE_AGENT_TICK (\d+)/gu)].map((match) =>
    Number(match[1]),
  );
}

async function terminalState(
  page: Page,
  terminalId: string,
): Promise<string | undefined> {
  const terminals = await page.evaluate(() => window.codra.terminal.list());
  return terminals.find((terminal) => terminal.id === terminalId)?.state;
}

test("resumes a dropped remote session with no lost and no duplicated output", async () => {
  test.skip(
    process.platform !== "darwin",
    "two-device remote harness is macOS",
  );
  expect(
    existsSync(remoteMainEntry),
    `${remoteMainEntry} is missing. Run: pnpm build:remote-test`,
  ).toBe(true);

  const agent = await installFakeClaudeAgent();
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${agent.binDirectory}${delimiter}${previousPath}`;
  process.env.CODRA_REMOTE_TEST_AUTO_APPROVE = "1";
  const emulators = await startRemoteEmulators();
  const devices: RemoteDeviceHandle[] = [];
  try {
    const account = await seedRemoteTestAccount(emulators);
    const client = await launchRemoteDevice({ label: "client", ...account });
    devices.push(client);
    const host = await launchRemoteDevice({ label: "host", ...account });
    devices.push(host);
    for (const device of devices) {
      await device.page.evaluate(() =>
        window.codra.remote.login("email_password"),
      );
      expect(
        await device.page.evaluate(() => window.codra.remote.activate()),
      ).toEqual({ state: "online" });
    }

    let hostTarget: RemoteTarget | undefined;
    await expect
      .poll(
        async () => {
          const targets = await client.page.evaluate(() =>
            window.codra.agents.targets(),
          );
          hostTarget = targets
            .map((entry) => entry.target)
            .find((target): target is RemoteTarget => target.kind === "remote");
          return hostTarget === undefined ? 0 : 1;
        },
        { timeout: 60_000, message: "the client never discovered the host" },
      )
      .toBe(1);
    expect(
      await client.page.evaluate(
        (target) => window.codra.agents.connectTarget(target),
        hostTarget!,
      ),
    ).toEqual({ target: hostTarget, state: "connected" });

    const terminal = await client.page.evaluate(
      (target) =>
        window.codra.terminal.create({
          target,
          cwd: "/tmp",
          cols: 100,
          rows: 30,
          agent: {
            kind: "claude",
            yolo: false,
            prompt: "hold this remote session open",
          },
        }),
      hostTarget!,
    );

    await expect
      .poll(
        async () =>
          tickNumbers(await replayText(client.page, terminal.id)).length,
        { timeout: 60_000, message: "no agent output arrived before the drop" },
      )
      .toBeGreaterThan(3);
    const beforeBreak = tickNumbers(await replayText(client.page, terminal.id));

    await host.page.evaluate(() => window.codra.remote.deactivate());
    await expect
      .poll(() => terminalState(client.page, terminal.id), { timeout: 60_000 })
      .toBe("exited");
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(
      await host.page.evaluate(() => window.codra.remote.activate()),
    ).toEqual({ state: "online" });
    await expect
      .poll(
        async () => {
          const targets = await client.page.evaluate(() =>
            window.codra.agents.targets(),
          );
          return targets.some((entry) => entry.target.kind === "remote");
        },
        { timeout: 60_000, message: "the host never came back online" },
      )
      .toBe(true);
    expect(
      await client.page.evaluate(
        (target) => window.codra.agents.connectTarget(target),
        hostTarget!,
      ),
    ).toEqual({ target: hostTarget, state: "connected" });

    await expect
      .poll(() => terminalState(client.page, terminal.id), { timeout: 60_000 })
      .toBe("running");
    await expect
      .poll(
        async () => {
          const ticks = tickNumbers(await replayText(client.page, terminal.id));
          return ticks.at(-1) ?? 0;
        },
        {
          timeout: 60_000,
          message: "output did not resume after renegotiation",
        },
      )
      .toBeGreaterThan(beforeBreak.at(-1)! + 5);

    const afterBreak = tickNumbers(await replayText(client.page, terminal.id));
    expect(afterBreak).toEqual(
      Array.from({ length: afterBreak.length }, (_, index) => index + 1),
    );
    expect(afterBreak.length).toBeGreaterThan(beforeBreak.length);

    await client.page.evaluate(
      (id) => window.codra.terminal.write({ terminalId: id, data: "quit\r" }),
      terminal.id,
    );
  } finally {
    delete process.env.CODRA_REMOTE_TEST_AUTO_APPROVE;
    process.env.PATH = previousPath;
    try {
      await shutdownRemoteDevices(devices);
    } finally {
      try {
        await emulators.stop();
      } finally {
        await agent.remove();
      }
    }
  }
});
```

`afterBreak` being exactly `1..n` is the whole claim: every tick emitted while the transport was down is present (nothing lost), and every tick the host replays from cursor 0 on re-attach appears once (nothing duplicated).

- [ ] **Step 19: Run the spec against the stale bundle and watch the guard fail**

Run: `rm -rf apps/desktop/out-remote-test && pnpm test:remote-reconnect`
Expected: FAIL with `/…/apps/desktop/out-remote-test/main/index.js is missing. Run: pnpm build:remote-test`

- [ ] **Step 20: Rebuild the remote-test bundle with the resume capability in it**

Run: `pnpm build:remote-test`
Expected: exit 0.

- [ ] **Step 21: Run the spec and watch it pass**

Run: `pnpm test:remote-reconnect`
Expected: PASS — `1 passed`

- [ ] **Step 22: Run the repository checks**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all four exit 0.

- [ ] **Step 23: Commit**

```bash
git add apps/desktop/src/main/remote/host-control-gateway.ts \
  apps/desktop/src/main/remote/host-control-gateway.test.ts \
  apps/desktop/src/main/remote/remote-agent-client.ts \
  apps/desktop/src/main/remote/remote-agent-client.test.ts \
  apps/desktop/src/main/remote/proxy-terminal-router.ts \
  apps/desktop/src/main/remote/proxy-terminal-router.test.ts \
  apps/desktop/src/main/remote/desktop-peer-connector.ts \
  apps/desktop/src/main/remote/host-controller.ts \
  apps/desktop/src/main/index.ts \
  tests/e2e/remote-fake-agent.ts \
  tests/e2e/remote-reconnect.spec.ts
git commit -m "feat(remote): resume owned remote terminals across a dropped transport"
```

---

---

### Task 14: `remote-agent-workspace` end-to-end spec and the exhaustive Firestore privacy scan

**Files:**

- Create: `tests/e2e/remote-agent-workspace.spec.ts`
- Test: `tests/e2e/remote-agent-workspace.spec.ts`
- Read-only dependency: `playwright.config.ts:41-45` and `package.json:29` already name the `remote-agent-workspace` project.

**Interfaces:**

- Consumes: the harness exports; `installFakeClaudeAgent()` from Task 13; `CODRA_REMOTE_TEST_AUTO_APPROVE` from Task 13; `RemoteEmulators.firestoreOrigin` and `RemoteEmulators.projectId`.
- Consumes: `window.codra.agents.workspaceRoots/workspaceList/workspaceValidate`, `window.codra.terminal.create/write/resize/replay` (`packages/protocol/src/desktop-api.ts`, routed at `remote-ipc.ts:191-221` and `terminal-ipc.ts`).
- Produces: nothing importable.

The Firestore assertion walks the emulator with the REST v1 surface (`:listCollectionIds` plus `GET {parent}/{collectionId}?showMissing=true`), recursing into every document's subcollections, and matches the needles against the raw document JSON, the document resource name, and every base64-decoded `bytesValue`. It is not a field spot check: the collections it must reach — `users/{uid}/devices`, `users/{uid}/remoteSessions`, `users/{uid}/remoteSessions/{id}/signals`, and the `server*` roots (`firestore.rules:63-100`) — are asserted to be present so a scan that silently found nothing cannot pass.

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/remote-agent-workspace.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";
import { installFakeClaudeAgent } from "./remote-fake-agent";
import {
  launchRemoteDevice,
  seedRemoteTestAccount,
  shutdownRemoteDevices,
  startRemoteEmulators,
  type RemoteDeviceHandle,
  type RemoteEmulators,
} from "./remote-harness";

const remoteMainEntry = path.resolve(
  "apps/desktop/out-remote-test/main/index.js",
);

interface RemoteTarget {
  kind: "remote";
  deviceId: string;
  displayName: string;
}

interface ScannedDocument {
  name: string;
  haystack: string;
}

async function firestoreJson(
  url: string,
  init?: { method: string; body: string },
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Bearer owner",
      "content-type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Firestore emulator returned ${response.status} for ${url}: ${await response.text()}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

async function listCollectionIds(
  origin: string,
  parent: string,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const body = await firestoreJson(
      `${origin}/v1/${parent}:listCollectionIds`,
      {
        method: "POST",
        body: JSON.stringify({
          pageSize: 300,
          ...(pageToken ? { pageToken } : {}),
        }),
      },
    );
    ids.push(...((body.collectionIds as string[] | undefined) ?? []));
    pageToken = body.nextPageToken as string | undefined;
  } while (pageToken);
  return ids;
}

async function listDocuments(
  origin: string,
  parent: string,
  collectionId: string,
): Promise<Array<Record<string, unknown>>> {
  const documents: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      pageSize: "300",
      showMissing: "true",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const body = await firestoreJson(
      `${origin}/v1/${parent}/${collectionId}?${query.toString()}`,
    );
    documents.push(
      ...((body.documents as Array<Record<string, unknown>> | undefined) ?? []),
    );
    pageToken = body.nextPageToken as string | undefined;
  } while (pageToken);
  return documents;
}

function decodedBytes(body: string): string {
  return [...body.matchAll(/"bytesValue":"([A-Za-z0-9+/=]*)"/gu)]
    .map((match) => Buffer.from(match[1]!, "base64").toString("utf8"))
    .join("\n");
}

async function scanEveryFirestoreDocument(
  emulators: RemoteEmulators,
): Promise<ScannedDocument[]> {
  const origin = emulators.firestoreOrigin;
  const scanned: ScannedDocument[] = [];
  const queue = [
    `projects/${emulators.projectId}/databases/(default)/documents`,
  ];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const collectionId of await listCollectionIds(origin, parent)) {
      for (const document of await listDocuments(
        origin,
        parent,
        collectionId,
      )) {
        const name = String(document.name ?? "");
        const body = JSON.stringify(document);
        scanned.push({
          name,
          haystack: `${name}\n${body}\n${decodedBytes(body)}`,
        });
        queue.push(name);
      }
    }
  }
  return scanned;
}

async function replayText(page: Page, terminalId: string): Promise<string> {
  const chunks = await page.evaluate(
    (id) =>
      window.codra.terminal.replay({
        terminalId: id,
        afterSequence: 0,
        limit: 1000,
      }),
    terminalId,
  );
  return chunks.map((chunk) => chunk.data).join("");
}

test("runs an agent on the peer's workspace and writes nothing sensitive to Firestore", async () => {
  test.skip(
    process.platform !== "darwin",
    "two-device remote harness is macOS",
  );
  expect(
    existsSync(remoteMainEntry),
    `${remoteMainEntry} is missing. Run: pnpm build:remote-test`,
  ).toBe(true);

  const workspaceRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "codra-remote-workspace-")),
  );
  const prompt = `audit the checkout ${randomUUID()}`;
  const inputToken = `CODRA_PROBE_${randomUUID()}`;
  const agent = await installFakeClaudeAgent();
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${agent.binDirectory}${delimiter}${previousPath}`;
  process.env.CODRA_REMOTE_TEST_AUTO_APPROVE = "1";
  const emulators = await startRemoteEmulators();
  const devices: RemoteDeviceHandle[] = [];
  try {
    const account = await seedRemoteTestAccount(emulators);
    const client = await launchRemoteDevice({ label: "client", ...account });
    devices.push(client);
    const host = await launchRemoteDevice({ label: "host", ...account });
    devices.push(host);
    for (const device of devices) {
      await device.page.evaluate(() =>
        window.codra.remote.login("email_password"),
      );
      expect(
        await device.page.evaluate(() => window.codra.remote.activate()),
      ).toEqual({ state: "online" });
    }

    let hostTarget: RemoteTarget | undefined;
    await expect
      .poll(
        async () => {
          const targets = await client.page.evaluate(() =>
            window.codra.agents.targets(),
          );
          hostTarget = targets
            .map((entry) => entry.target)
            .find((target): target is RemoteTarget => target.kind === "remote");
          return hostTarget === undefined ? 0 : 1;
        },
        { timeout: 60_000, message: "the client never discovered the host" },
      )
      .toBe(1);
    expect(
      await client.page.evaluate(
        (target) => window.codra.agents.connectTarget(target),
        hostTarget!,
      ),
    ).toEqual({ target: hostTarget, state: "connected" });

    const roots = await client.page.evaluate(
      (target) => window.codra.agents.workspaceRoots(target),
      hostTarget!,
    );
    expect(roots.length).toBeGreaterThan(0);
    const page = await client.page.evaluate(
      ({ target, parent }) => window.codra.agents.workspaceList(target, parent),
      { target: hostTarget!, parent: path.dirname(workspaceRoot) },
    );
    expect(page.entries.map((entry) => entry.path)).toContain(workspaceRoot);
    expect(
      await client.page.evaluate(
        ({ target, selected }) =>
          window.codra.agents.workspaceValidate(target, selected),
        { target: hostTarget!, selected: workspaceRoot },
      ),
    ).toEqual({ path: workspaceRoot, label: path.basename(workspaceRoot) });

    const terminal = await client.page.evaluate(
      ({ target, cwd, agentPrompt }) =>
        window.codra.terminal.create({
          target,
          cwd,
          cols: 100,
          rows: 30,
          agent: { kind: "claude", yolo: false, prompt: agentPrompt },
        }),
      { target: hostTarget!, cwd: workspaceRoot, agentPrompt: prompt },
    );
    expect(terminal.origin).toEqual(hostTarget);

    await expect
      .poll(() => replayText(client.page, terminal.id), { timeout: 60_000 })
      .toContain(`CODRA_FAKE_AGENT_READY -- ${prompt}`);

    await client.page.evaluate(
      ({ id, token }) =>
        window.codra.terminal.write({ terminalId: id, data: `${token}\r` }),
      { id: terminal.id, token: inputToken },
    );
    await expect
      .poll(() => replayText(client.page, terminal.id), { timeout: 60_000 })
      .toContain(`CODRA_FAKE_AGENT_ECHO ${inputToken}`);

    await client.page.evaluate(
      (id) => window.codra.terminal.write({ terminalId: id, data: "where\r" }),
      terminal.id,
    );
    await expect
      .poll(() => replayText(client.page, terminal.id), { timeout: 60_000 })
      .toContain(`CODRA_FAKE_AGENT_CWD ${workspaceRoot}`);

    await client.page.evaluate(
      (id) =>
        window.codra.terminal.resize({ terminalId: id, cols: 120, rows: 40 }),
      terminal.id,
    );
    await client.page.evaluate(
      (id) => window.codra.terminal.write({ terminalId: id, data: "size\r" }),
      terminal.id,
    );
    await expect
      .poll(() => replayText(client.page, terminal.id), { timeout: 60_000 })
      .toContain("CODRA_FAKE_AGENT_SIZE 40x120");

    const documents = await scanEveryFirestoreDocument(emulators);
    expect(
      documents.length,
      "the Firestore scan found no documents at all — the scan is broken, not the privacy claim proven",
    ).toBeGreaterThan(0);
    expect(
      documents.some((document) => document.name.includes("/devices/")),
      "the scan never reached users/{uid}/devices",
    ).toBe(true);
    expect(
      documents.some((document) => document.name.includes("/remoteSessions/")),
      "the scan never reached users/{uid}/remoteSessions",
    ).toBe(true);
    expect(
      documents.some((document) => document.name.includes("/signals/")),
      "the scan never recursed into the signals subcollection",
    ).toBe(true);

    for (const needle of [prompt, inputToken, workspaceRoot]) {
      const leaked = documents
        .filter((document) => document.haystack.includes(needle))
        .map((document) => document.name);
      expect(leaked, `Firestore documents leaked ${needle}`).toEqual([]);
    }

    await client.page.evaluate(
      (id) => window.codra.terminal.write({ terminalId: id, data: "quit\r" }),
      terminal.id,
    );
  } finally {
    delete process.env.CODRA_REMOTE_TEST_AUTO_APPROVE;
    process.env.PATH = previousPath;
    try {
      await shutdownRemoteDevices(devices);
    } finally {
      try {
        await emulators.stop();
      } finally {
        await agent.remove();
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }
  }
});
```

- [ ] **Step 2: Run the test and watch the build guard fail**

Run: `rm -rf apps/desktop/out-remote-test && pnpm test:remote-agent-workspace`
Expected: FAIL with `/…/apps/desktop/out-remote-test/main/index.js is missing. Run: pnpm build:remote-test`

- [ ] **Step 3: Build the remote-test bundle the spec requires**

Run: `pnpm build:remote-test`
Expected: exit 0.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm test:remote-agent-workspace`
Expected: PASS — `1 passed`

- [ ] **Step 5: Run the repository checks**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all four exit 0.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/remote-agent-workspace.spec.ts
git commit -m "test(e2e): prove remote agent workspace flow keeps prompts and paths out of Firestore"
```

---

---

### Task 15: Rollout, runbook, and README correction (design Piece G)

**Files:**

- Create: `docs/runbooks/remote-access.md`
- Modify: `README.md:3` and `README.md:44-46`
- Modify: `scripts/verify-remote-build-config.mjs` (append after the file-existence loop that ends at `:186`)
- Test: `scripts/verify-remote-build-config.mjs`, run by `pnpm verify:remote-build-config` — already in the design's verification gate.

**Interfaces:**

- Consumes: `CODRA_PROJECT_ID = "codra-1b3bb"` (`packages/protocol/src/deployment.ts:4`), the `live` alias in `.firebaserc`, the provider rule at `functions/src/auth.ts:26-34` (`google.com` only; `password` accepted only when `FUNCTIONS_EMULATOR === "true"`), and the `auth` block deleted from `firebase.json` by Task 1.
- Produces: `docs/runbooks/remote-access.md` as the sole record of production Identity Platform provider configuration, enforced by the new assertions so it cannot silently disappear.

- [ ] **Step 1: Write the failing test**

Append to the end of `scripts/verify-remote-build-config.mjs`:

```js
const [readmeText, remoteRunbook] = await Promise.all([
  read("README.md"),
  read("docs/runbooks/remote-access.md"),
]);

assert.equal(
  firebaseConfig.auth,
  undefined,
  "firebase.json must not carry an auth block; production providers are recorded in docs/runbooks/remote-access.md",
);

forbidText(readmeText, "does not require an account or login", "README.md");
forbidText(readmeText, "deferred to a future phase", "README.md");
requireText(readmeText, "docs/runbooks/remote-access.md", "README.md");

requireText(
  remoteRunbook,
  "## Production Identity Platform providers",
  "remote access runbook",
);
requireText(
  remoteRunbook,
  "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
  "remote access runbook",
);
requireText(
  remoteRunbook,
  "firebase deploy --only functions --project codra-1b3bb",
  "remote access runbook",
);
requireText(
  remoteRunbook,
  "firebase deploy --only hosting --project codra-1b3bb",
  "remote access runbook",
);
```

- [ ] **Step 2: Run the verifier and watch it fail**

Run: `pnpm verify:remote-build-config`
Expected: FAIL with `Error: ENOENT: no such file or directory, open '/Users/imjunhyeog/Documents/wicklim90/codra/docs/runbooks/remote-access.md'`

- [ ] **Step 3: Write the runbook**

Create `docs/runbooks/remote-access.md`:

````markdown
# Remote access runbook

Remote access lets one CODRA Mac launch and drive agents on another Mac signed
in to the same account. It is optional; local terminals and local agents never
touch it.

## What Firebase carries, and what it never carries

Firebase carries account sign-in, device registration, presence, session
request/approval records, and WebRTC signalling. Terminal bytes, agent prompts,
and workspace paths travel only over the direct peer connection and are never
written to Firestore. `tests/e2e/remote-agent-workspace.spec.ts` enforces this
by scanning every document in the Firestore emulator for the prompt, the input
token, and the workspace path after a full agent session.

## Production Identity Platform providers

`firebase.json` no longer carries an `auth` block. The Auth emulator ignored it
(`AgentProjectState.allowPasswordSignup` is a hardcoded `return true`), so the
block only described the production project. Configure the following in the
Firebase console for project `codra-1b3bb` under
**Authentication → Sign-in method**, and change nothing else:

- **Google** — enabled. This is the only provider CODRA accepts in production;
  `functions/src/auth.ts:26-34` rejects every other `sign_in_provider` with
  `ACCOUNT_PROVIDER_NOT_ALLOWED`, and accepts `password` only when
  `FUNCTIONS_EMULATOR === "true"`.
- **Email/password** — disabled in production. It exists only in the
  `demo-codra` emulator, driven by `account-bootstrap-test-only.ts`.
- OAuth brand display name: `CODRA`
- Support email: `wicklim90@gmail.com`
- Authorized redirect URIs:
  - `http://127.0.0.1`
  - `https://codra-1b3bb.firebaseapp.com/__/auth/handler`
  - `https://codra-1b3bb.web.app/__/auth/handler`

The loopback URI is required: desktop sign-in runs in the system browser and
returns to a loopback listener, never to an embedded browser window.

## Desktop sign-in

1. In CODRA, open the account control in the sidebar and choose Google.
2. The system browser opens `https://codra-1b3bb.firebaseapp.com/desktop-auth`.
3. After consent, the browser lands on the loopback callback page, which
   focuses CODRA and closes itself. If browser policy blocks the close, the
   page shows a **Return to CODRA** button. The page loads no subresource and
   renders no token, session id, or account detail.
4. CODRA's account control shows the signed-in identity.

Failure states: `REMOTE_LOGIN_CANCELLED` (the window was closed or the attempt
was superseded), `AUTH_PROVIDER_UNAVAILABLE` (a non-Google provider was
requested against production).

## Host activation and device registration

Enable **Remote access** in Settings. Activation registers this Mac as a host
device with a display name derived from `os.hostname()`, signs in a device-scoped
Firebase session with a custom token, and starts a heartbeat. The status strip
shows `Remote online`. Deactivating tears down all peer connections and the
device session; terminals keep running.

## Session approval and scopes

When another Mac requests a session, CODRA shows an in-app approval modal —
not a native dialog — naming the requesting device and listing every requested
scope, each independently deniable:

`workspace.read`, `agent.runtimes`, `agent.launch`, `terminal.write`,
`terminal.resize`, `terminal.detach`, `terminal.attach`.

`agent.launch` permits running an agent on this Mac. Denying every scope is a
rejection, not an empty approval. `terminal.attach` only ever applies to
terminals the same peer launched on this host; it never exposes local terminals.
If no window is open when a request arrives, CODRA opens one; if the window
cannot be created, the session is rejected rather than left pending.

## Two-device emulator gate

Every command must exit zero before any deploy.

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:e2e

pnpm build:remote-test
pnpm test:remote-direct
pnpm test:remote-reconnect
pnpm test:remote-agent-workspace

pnpm verify:native-package
pnpm verify:remote-build-config
pnpm verify:firebase-indexes
pnpm scan:client-artifacts
```

Prerequisites: macOS, a JDK for the Firestore emulator, and
`pnpm install --frozen-lockfile`. In zsh, `${PIPESTATUS[0]}` is empty — use
`$pipestatus[1]` or redirect and read `$?`.

## Rollout: deploy only the surfaces that changed

Never run bare `firebase deploy`. Determine what actually changed:

```bash
git diff --stat origin/main...HEAD -- \
  firestore.rules firestore.indexes.json functions packages/protocol apps/web
```

Functions and Hosting both bundle `@codra/protocol`, so a protocol change
requires redeploying both even when `functions/` and `apps/web/` are untouched.
Rules and indexes are deployed only when their own files changed.

```bash
# Functions — required when functions/ or packages/protocol changed
pnpm --filter @codra/protocol build
pnpm --filter @codra/functions build
pnpm run stage:functions-deploy
pnpm --dir functions-deploy-build install --frozen-lockfile
firebase deploy --only functions --project codra-1b3bb

# Hosting (the login bridge) — required when apps/web or packages/protocol changed
pnpm --filter @codra/web build
firebase deploy --only hosting --project codra-1b3bb

# Only when firestore.rules changed
firebase deploy --only firestore:rules --project codra-1b3bb

# Only when firestore.indexes.json changed
firebase deploy --only firestore:indexes --project codra-1b3bb
```

`codra-1b3bb` is also the `live` alias in `.firebaserc`; pass the project id
explicitly anyway so a stale `firebase use` cannot redirect a deploy.

## Post-deploy checks the emulator cannot cover

1. Google sign-in from a release desktop build completes and returns focus to
   CODRA. The emulator only ever exercises email/password.
2. The device appears with its `os.hostname()` display name, and a second Mac
   sees it as an online host.
3. TURN relay: `issueTurnCredentials` returns Cloudflare `iceServers`. The
   two-device harness runs on loopback host candidates and cannot exercise
   relay; force a relay path manually once after deploy.
4. `firebase functions:log --project codra-1b3bb` shows no
   `TURN_GENERATION_AMBIGUOUS`, `ACCOUNT_PROVIDER_NOT_ALLOWED`, or
   `SESSION_NOT_CONNECTABLE` bursts.
5. App Check remains disabled by design (`deployment.ts` pins
   `authAppCheckEnforcement: false`); every callable is reachable by any client
   holding a valid account token.

## Rollback

Hosting has release rollback in the Firebase console. Functions, rules, and
indexes have none: check out the previous commit and redeploy that exact
surface with the same `--only` flag. Rolling back rules while a newer functions
revision is live can strand sessions — roll back functions first.
````

- [ ] **Step 4: Run the verifier and watch the README assertion fail**

Run: `pnpm verify:remote-build-config`
Expected: FAIL with `AssertionError [ERR_ASSERTION]: README.md must not include does not require an account or login`

- [ ] **Step 5: Correct the README**

In `README.md`, replace line 3:

```markdown
CODRA is a standalone macOS desktop terminal. It runs locally, stores terminal metadata and bounded scrollback on the Mac, and does not require an account or login.
```

with:

```markdown
CODRA is a macOS desktop terminal for running agents in parallel. It runs locally and stores terminal metadata and bounded scrollback on the Mac. Local terminals and local agents need no account. Remote access is an optional layer: sign in with a Google account and one CODRA Mac can browse another Mac's workspaces and launch agents there over a direct WebRTC connection.
```

and replace the whole `## Scope` section (lines 44-46):

```markdown
## Scope

This phase is local and standalone. Firebase-backed coordination, WebRTC remote terminal transport, and Cloudflare/TURN remote-access infrastructure are deferred to a future phase; no Firebase or Cloudflare configuration is needed to run CODRA locally.
```

with:

````markdown
## Remote access

Remote access is optional and off until you sign in and enable it. When it is
on, Firebase carries sign-in, device registration, session approval, and WebRTC
signalling only. Terminal bytes, agent prompts, and workspace paths travel
exclusively over the direct peer connection between the two Macs; an end-to-end
test scans every emulator Firestore document to keep that true. Cloudflare TURN
credentials are issued by a Firebase callable when a direct connection is not
possible, and the clients never see the Cloudflare token.

Running CODRA locally needs no Firebase or Cloudflare configuration.

Operating and deploying the remote layer — sign-in, host activation, device
registration, session approval, provider configuration, and rollout — is
documented in `docs/runbooks/remote-access.md`.

The two-device remote suite requires macOS and a JDK for the Firestore
emulator:

```bash
pnpm build:remote-test
pnpm test:remote-direct
pnpm test:remote-reconnect
pnpm test:remote-agent-workspace
```
````

````

- [ ] **Step 6: Run the verifier and watch it pass**

Run: `pnpm verify:remote-build-config`
Expected: PASS — exit 0, no output.

- [ ] **Step 7: Run the repository checks**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all four exit 0. `pnpm format:check` covers the new Markdown.

- [ ] **Step 8: Commit**

```bash
git add docs/runbooks/remote-access.md README.md scripts/verify-remote-build-config.mjs
git commit -m "docs(remote): add the remote access runbook and correct the README's account and Firebase claims"
````

- [ ] **Step 9: Run the full gate before touching the live project**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && pnpm test:e2e && pnpm build:remote-test && pnpm test:remote-direct && pnpm test:remote-reconnect && pnpm test:remote-agent-workspace && pnpm verify:native-package && pnpm verify:remote-build-config && pnpm verify:firebase-indexes && pnpm scan:client-artifacts`
Expected: exit 0. Do not proceed to step 10 on any non-zero exit.

- [ ] **Step 10: Deploy the changed Functions surface**

Run: `pnpm --filter @codra/protocol build && pnpm --filter @codra/functions build && pnpm run stage:functions-deploy && pnpm --dir functions-deploy-build install --frozen-lockfile && firebase deploy --only functions --project codra-1b3bb`
Expected: `Deploy complete!`, and the deployed function list contains `registerDevice`, `heartbeatDevice`, `createRemoteSession`, `approveRemoteSession`, `rejectRemoteSession`, `listHostDevices`, `getSessionPeerDevice`, `issueTurnCredentials` in `asia-northeast3`.

- [ ] **Step 11: Deploy the changed Hosting surface**

Run: `pnpm --filter @codra/web build && firebase deploy --only hosting --project codra-1b3bb`
Expected: `Deploy complete!` with the hosting URL `https://codra-1b3bb.web.app`. Do **not** pass `--only firestore:rules` or `--only firestore:indexes` — neither file changed in this work.

- [ ] **Step 12: Run the post-deploy checks**

Run: `firebase functions:log --project codra-1b3bb --only registerDevice,createRemoteSession,issueTurnCredentials`
Expected: recent entries only, with no `ACCOUNT_PROVIDER_NOT_ALLOWED`, `TURN_GENERATION_AMBIGUOUS`, or `SESSION_NOT_CONNECTABLE`. Then walk the numbered list under "Post-deploy checks the emulator cannot cover" in `docs/runbooks/remote-access.md`, including the manual TURN relay check, which the harness cannot cover.

---

**Cross-task notes for the plan assembler**

- Names introduced here that appear nowhere in `CONTRACT.md`, frozen by this plan, not to be redefined elsewhere: `CODRA_REMOTE_TEST_AUTO_APPROVE`, `HostControlGatewayOptions.ownedTerminals`, `RemoteAgentChannelClient.attach`, `RemoteAgentPeerPort.attach`, `ProxyTerminalRouter.resume`, `DesktopPeerConnectorOptions.terminalOwners`, `tests/e2e/remote-fake-agent.ts` / `installFakeClaudeAgent`.
- Task 13 appends `"terminal.attach"` to `REMOTE_AGENT_SCOPES` (`apps/desktop/src/main/remote/host-control-gateway.ts:35-42`). Whichever task builds `SessionApprovalDialog` must render seven scope rows, not six, and any fixture that hardcodes the six-scope array must be updated in the same change.
- `tests/e2e/*.spec.ts` is not covered by any `tsconfig` `include`, so `pnpm typecheck` does not typecheck the specs; `eslint .` does lint them. That is why Task 13's capability work carries vitest unit tests — they are the only type-checked coverage of the resume path.

---

### Task 16: Sign-in refocus plumbing (completes design Piece A)

Task 2 built the callback page but deliberately left the Electron-side refocus
alone. This task closes it. It has no dependency on Tasks 3–15 and may be
executed immediately after Task 2.

Two gaps exist today. `bootstrapRemoteAccount` — the device-registration path —
takes no `parentWindow` at all (`account-bootstrap-google.ts:48-51`), so
registering a device never brings CODRA forward. And `revealParentWindow`
(`:13-20`) raises the window but never the application, so on macOS CODRA can be
restored behind the browser.

**Files:**

- Modify: `apps/desktop/src/main/remote/account-bootstrap-google.ts:1-60`
- Modify: `apps/desktop/src/main/remote/account-bootstrap-google.test.ts:1-21`
- Modify: `apps/desktop/src/main/remote/remote-bindings.d.ts:16-19`
- Modify: `apps/desktop/src/main/remote/account-bootstrap-test-only.ts:25-28`
- Modify: `apps/desktop/src/main/remote/host-controller.ts:252, 341, 354, 364`
- Modify: `apps/desktop/src/main/ipc/remote-ipc.ts:44, 255-261`
- Modify: `apps/desktop/src/main/ipc/remote-ipc.test.ts:47-134`
- Modify: `apps/desktop/src/main/index.ts` (the `activate` call site)
- Test: `apps/desktop/src/main/remote/account-bootstrap-google.test.ts`

**Interfaces:**

- Consumes: `DesktopAuthParentWindowLike` from `./auth-window` (already a
  type-only import at `account-bootstrap-google.ts:9`).
- Produces:
  - `bootstrapRemoteAccount(runtime, options, parentWindow?)` — a third optional
    parameter. The same signature must appear in `remote-bindings.d.ts` and
    `account-bootstrap-test-only.ts` or `pnpm typecheck` fails.
  - `RemoteHostControllerPort.activate(parentWindow: DesktopAuthParentWindowLike)`
    — Task 7 extends this same interface; both changes land in the port
    declaration at `remote-ipc.ts:36-65`.

---

- [ ] **Step 1: Widen the electron mock, then write the failing focus test**

The existing factory at `account-bootstrap-google.test.ts:19-21` exports only
`shell`. Importing `app` in the implementation without widening this first makes
the module throw on a missing export, which reads as an unrelated failure.

Replace `account-bootstrap-google.test.ts:3-21`:

```ts
const mocks = vi.hoisted(() => ({
  bootstrapProductionDesktopAuth: vi.fn(),
  bootstrapProductionDesktopLogin: vi.fn(),
  openDesktopAuthWindow: vi.fn(async () => undefined),
  shellOpenExternal: vi.fn(async () => undefined),
  appFocus: vi.fn(),
}));

vi.mock("./desktop-login", () => ({
  bootstrapProductionDesktopAuth: mocks.bootstrapProductionDesktopAuth,
  bootstrapProductionDesktopLogin: mocks.bootstrapProductionDesktopLogin,
}));

vi.mock("./auth-window", () => ({
  openDesktopAuthWindow: mocks.openDesktopAuthWindow,
}));

vi.mock("electron", () => ({
  shell: { openExternal: mocks.shellOpenExternal },
  app: { focus: mocks.appFocus },
}));
```

Then append two tests inside the existing `describe` block:

```ts
it("raises the application, not only the window, after sign-in", async () => {
  const parentWindow = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    isVisible: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };

  await bootstrapRemoteAuth(
    { deployment: { mode: "production" } } as never,
    "google",
    undefined,
    parentWindow,
  );

  expect(parentWindow.restore).toHaveBeenCalledOnce();
  expect(parentWindow.show).toHaveBeenCalledOnce();
  expect(parentWindow.focus).toHaveBeenCalledOnce();
  expect(mocks.appFocus).toHaveBeenCalledWith({ steal: true });
});

it("restores CODRA focus after device registration", async () => {
  const parentWindow = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  mocks.bootstrapProductionDesktopLogin.mockResolvedValueOnce({
    token: "device-token",
  });

  await bootstrapRemoteAccount(
    { deployment: { mode: "production" } } as never,
    {} as never,
    parentWindow,
  );

  expect(parentWindow.focus).toHaveBeenCalledOnce();
  expect(mocks.appFocus).toHaveBeenCalledWith({ steal: true });
});
```

Note `app.focus({ steal: true })` is asserted exactly. On macOS a bare
`app.focus()` does not raise an application that lost activation to the browser.

---

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/account-bootstrap-google.test.ts`

Expected: FAIL. The first new test fails with
`AssertionError: expected "spy" to be called with arguments: [ { steal: true } ]`
(`appFocus` received nothing). The second fails with
`expected "spy" to be called once, but got 0 times` on `parentWindow.focus`,
because `bootstrapRemoteAccount` ignores its third argument today.

The three pre-existing tests must still pass. If
`expect(parentWindow.focus).toHaveBeenCalledOnce()` at `:77` or `:125` now fails,
a second refocus path was introduced — remove it rather than relaxing the
assertion.

---

- [ ] **Step 3: Implement the refocus change**

`account-bootstrap-google.ts:2` — widen the electron import:

```ts
import { app, shell } from "electron";
```

`account-bootstrap-google.ts:13-20` — replace `revealParentWindow`:

```ts
function revealParentWindow(
  parentWindow: DesktopAuthParentWindowLike | undefined,
): void {
  app.focus({ steal: true });
  if (!parentWindow || parentWindow.isDestroyed()) return;
  if (parentWindow.isMinimized()) parentWindow.restore();
  if (!parentWindow.isVisible()) parentWindow.show();
  parentWindow.focus();
}
```

`app.focus` runs first and unconditionally: the application must be frontmost
before a window inside it is raised, and the app should come forward even when
the caller passed no window.

`account-bootstrap-google.ts:48-60` — add the parameter and the `finally`:

```ts
export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
  parentWindow?: DesktopAuthParentWindowLike,
): Promise<DesktopLoginBootstrapResult> {
  if (runtime.deployment.mode !== "production")
    throw new Error("DESKTOP_GOOGLE_LOGIN_REQUIRES_PRODUCTION");
  try {
    return await bootstrapProductionDesktopLogin(runtime, options, {
      openExternal: (url, callbackUrl) => {
        if (!callbackUrl) throw new Error("DESKTOP_LOGIN_CALLBACK_URL_MISSING");
        return shell.openExternal(url);
      },
    });
  } finally {
    revealParentWindow(parentWindow);
  }
}
```

`return await` inside `try` is required — a bare `return` would run the `finally`
before the promise settles and refocus while the browser is still open.

---

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @codra/desktop exec vitest run src/main/remote/account-bootstrap-google.test.ts`
Expected: PASS, 5 tests.

---

- [ ] **Step 5: Propagate the signature to the two other declaration sites**

`pnpm typecheck` fails until all three agree. The `.d.ts` is the frozen contract
for the `@codra/remote-account-bootstrap` Vite alias.

`remote-bindings.d.ts:16-19` becomes:

```ts
export function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
  parentWindow?: DesktopAuthParentWindowLike,
): Promise<DesktopLoginBootstrapResult | undefined>;
```

`account-bootstrap-test-only.ts:25-28` becomes:

```ts
export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
  parentWindow?: DesktopAuthParentWindowLike,
): Promise<undefined> {
  void options;
  void parentWindow;
```

The test-only binding keeps its `Promise<undefined>` return; the `.d.ts` union
already accommodates both implementations.

---

- [ ] **Step 6: Thread the window from `activate` down to `startInternal`**

`remote-ipc.ts:44` — the port:

```ts
  activate(parentWindow: DesktopAuthParentWindowLike): Promise<RemoteHostStatus>;
```

`remote-ipc.ts:255-261` — the handler stops discarding `authorize`'s return
value. It already returns the owning window; every other handler ignores it.

```ts
    [
      IPC_CHANNELS.remoteActivate,
      async (event) => {
        const parentWindow = authorize(event);
        return RemoteHostStatusSchema.parse(
          await controller.activate(parentWindow),
        );
      },
    ],
```

`authorize(event)` remains the first statement.

`host-controller.ts:252` and `:341` — carry the window through:

```ts
  async activate(
    parentWindow: DesktopAuthParentWindowLike,
  ): Promise<RemoteHostStatus> {
```

```ts
this.startPromise = this.startInternal(parentWindow);
```

```ts
  private async startInternal(
    parentWindow: DesktopAuthParentWindowLike,
  ): Promise<void> {
```

and both `bootstrapRemoteAccount` call sites (`:354`, `:364`) take it as a third
argument:

```ts
login = await bootstrapRemoteAccount(
  accountRuntime,
  { identity, action, useExistingAuth: true },
  parentWindow,
);
```

```ts
login = await bootstrapRemoteAccount(
  accountRuntime,
  { identity, action: "register", useExistingAuth: true },
  parentWindow,
);
```

Both sites change together — the second is the interrupted-first-run recovery
path and is exactly the case where a user is most likely to be staring at a
browser wondering what happened.

---

- [ ] **Step 7: Extend the hand-written controller fake**

`remote-ipc.test.ts:47-134` builds a structural `RemoteHostControllerPort`.
`pnpm typecheck` includes co-located `.test.ts` files (`apps/desktop/tsconfig.json`
covers `src/main/**/*.ts`), so the fake must accept the parameter:

```ts
    activate: vi.fn(async (_parentWindow: DesktopAuthParentWindowLike) => ({
      state: "online" as const,
    })),
```

Then update any existing assertion that calls `controller.activate()` with no
argument to pass the fake window the file already constructs for the `login`
tests.

---

- [ ] **Step 8: Update the composition root**

`apps/desktop/src/main/index.ts` — the `activate` call now needs a window. It is
wiring only; there is no test for this file.

Locate the `activate` invocation in the `RemoteHostControllerPort` wiring and
pass the main window, matching how `login` already receives one.

---

- [ ] **Step 9: Run the full gate**

```bash
pnpm --filter @codra/desktop exec vitest run src/main/remote src/main/ipc
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: all four exit 0. `pnpm typecheck` is the load-bearing one — it is what
proves all three `bootstrapRemoteAccount` declarations and both `activate`
declarations agree.

---

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/main/remote/account-bootstrap-google.ts \
        apps/desktop/src/main/remote/account-bootstrap-google.test.ts \
        apps/desktop/src/main/remote/remote-bindings.d.ts \
        apps/desktop/src/main/remote/account-bootstrap-test-only.ts \
        apps/desktop/src/main/remote/host-controller.ts \
        apps/desktop/src/main/ipc/remote-ipc.ts \
        apps/desktop/src/main/ipc/remote-ipc.test.ts \
        apps/desktop/src/main/index.ts
git commit -m "fix(auth): raise CODRA after browser sign-in and device registration"
```

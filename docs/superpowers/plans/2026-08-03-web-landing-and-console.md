# CODRA Web Landing and Browser Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `apps/web` from a Korean-only login stub into two real surfaces — a public landing page that explains CODRA without requiring an account, and a browser console that actually connects to a CODRA host, launches an agent on a chosen workspace, and drives its terminal over WebRTC.

**Architecture:** The browser client is not written from scratch. Four files in `apps/desktop/src/main/remote/` are already platform-neutral — they import only `@codra/protocol`, `@codra/firebase`, and `@codra/webrtc` and touch no Node API except one `randomUUID`. They move into a new `@codra/remote-client` package that both the desktop main process and the browser import. What is genuinely new is small: an `RTCPeerConnection` adapter, an `RTCDataChannel` adapter, a browser connector that mirrors `DesktopPeerConnector.connectClient`, and the console UI. The landing page and the console are separate lazy chunks so a visitor who never signs in does not download Firestore.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Zod 4, Firebase 12, xterm.js 6, Vitest 4, Testing Library, Playwright 1.62, pnpm 11.5.2, Node 22.

**Design:** The instrument-deck visual language defined in `docs/superpowers/specs/2026-08-02-operator-console-ux-design.md`. No separate web design spec is written; the web surfaces adopt the desktop's tokens verbatim.

**Supersedes:** Nothing. This is the first plan to touch `apps/web` as a product surface. It closes findings #12, #13, #51, #52, #57 and A5 from `docs/analysis/2026-08-02-codra-project-briefing.md`, and the `signing-key-id-field` follow-up in `docs/remote-access-follow-ups.md`.

## Design coverage

| Piece                               | Tasks          |
| ----------------------------------- | -------------- |
| A — Web shell foundation            | 1, 2, 3, 4     |
| B — Security and build hygiene      | 5, 6, 7, 8     |
| C — Shared remote client extraction | 9, 10, 11      |
| D — Browser peer and console        | 12, 13, 14, 15 |
| E — Verification and rollout        | 16             |

## Global Constraints

Every task's requirements implicitly include this section.

- **Every behavior change starts with a failing test.** Write the test, run it, watch it fail with the expected message, then implement.
- **`pnpm typecheck` is a separate gate from `pnpm test`.** `apps/web`'s `test` script is `vitest run --passWithNoTests`; a broken glob is green. Several changes in this plan break only the type check.
- **Every new Zod schema is `.strict()`, every string `.max(...)`, every array `.max(...)`.** Precedent: `packages/protocol/test/desktop-api.test.ts:36-38`.
- **Firebase carries signalling only.** No path, prompt, runtime catalogue, or terminal byte is ever written to Firestore. `tests/e2e/remote-agent-workspace.spec.ts:104-131` scans every emulator document — including base64-decoded `bytesValue` fields — and re-scans after teardown. Do not stuff data into SDP attributes to evade it.
- **The client artifact scanner bans these case-sensitive substrings from `apps/web/dist`:** `CLOUDFLARE_TURN_CONFIG`, `CLOUDFLARE`, `private_key`, `safe-storage-test-only`, `account-bootstrap-test-only`, `session-auto-approve-test-only`, `signInWithEmailAndPassword`, `CODRA_REMOTE_TEST_EMAIL`, `CODRA_REMOTE_TEST_AUTO_APPROVE`, `com.codra.desktop.remote-test`, `CODRA Remote Test`, `bearerToken`, `keyId`, `node-datachannel`, `sourceMappingURL`. Plus regexes `BEGIN[ _]+(RSA[ _]+)?PRIVATE[ _]+KEY`, `/Users/[A-Za-z0-9._-]+/`, and `\bturns?://`. This applies to **every file** under `apps/web/dist`, read as UTF-8 — including `index.html`, CSS, and anything copied from a future `public/`.
- **Never set `build.sourcemap` for `apps/web`.** It reintroduces `sourceMappingURL` and writes `.map` files whose `sources` arrays trip `developer-home-path`.
- **`node-datachannel` stays out of the web bundle by exactly one thread:** `packages/webrtc/src/channel.ts:6-10` is `import type`. Converting it to a value import breaks `vite build` for `apps/web` and trips scanner rule `native-datachannel-module`. Task 9 hardens this.
- **`scripts/verify-remote-build-config.mjs` is a tripwire, not a formality.** It deep-equals the exact two-element `hosting.rewrites` array (`:160-163`) and counts exactly four six-space-indented `timeout:` lines in `playwright.config.ts` (`:202-206`). Any task adding a route or a Playwright project updates this script in the same commit.
- **Playwright projects require an explicit `testMatch`.** Adding a spec file alone runs nothing (`playwright.config.ts:14-45`).
- **A new workspace package must be added to `externalizeDepsPlugin({ exclude: [...] })` in BOTH electron-vite configs — four sites total.** `apps/desktop/electron.vite.config.ts` and `electron.remote-test.vite.config.ts` each list the workspace packages twice. Miss it and the packaged main process emits `require("@codra/remote-client")`, which resolves to raw TypeScript and dies at runtime. **Nothing in `pnpm test`, `pnpm typecheck`, or `pnpm lint` catches this** — only the `remote-*` Playwright suites would, and only after packaging. Task 9 added a `verify:remote-build-config` assertion covering it; keep that assertion passing. Verify directly with `pnpm --filter @codra/desktop build && grep -c "@codra/remote-client" apps/desktop/out/main/index.js`, which must print `0` (fully inlined).
- **`pnpm install` silently no-ops on a newly added workspace package.** It prints `Already up to date` without linking the package or updating the lockfile. Delete `node_modules/.pnpm-workspace-state-v1.json` and re-run.
- **Prettier settles formatting.** Run `pnpm format:check` before every commit; it currently passes and must keep passing.
- **zsh does not populate `${PIPESTATUS[0]}`.** Redirect to a file and read `$?`, or use `$pipestatus[1]`.

## Baseline

Measured on a clean tree at commit `88b448a` before any task ran:

```
pnpm lint          -> exit 0
pnpm format:check  -> exit 0
pnpm typecheck     -> exit 0
pnpm test          -> 63 files / 417 tests: 416 passed, 1 failed
```

Per project: `packages/protocol` 5/36, `packages/webrtc` 7/12, `packages/firebase` 2/8, `functions` 6/32, `apps/web` 2/9, `apps/desktop` 41/320 (319 passing, 1 failing).

The single failure is `apps/desktop/src/main/terminal/node-pty.test.ts` → "runs zsh and reaps its child after observing real command output", which times out at 5000 ms. It is environment-dependent, not a code defect: `zsh -i -c exit` takes 6.07 s on the machine this plan was written on. On a machine with a fast shell profile the full suite is green. **Do not "fix" this test as part of this plan** and do not treat it as a regression.

**Compare repo totals, not per-project counts.** Pieces C moves test files between projects, so `apps/desktop`'s count necessarily drops — `apps/desktop/vitest.config.ts` globs `src/{main,preload}/**/*.test.ts` and a moved file leaves that glob. The invariant that must hold is the repo total, adjusted for tests a task deliberately adds.

## Execution order

```
Piece A — web shell, no desktop changes
1  routing + catch-all rewrite   (no dependencies)
2  design tokens                 (no dependencies)
3  landing page                  (needs 1, 2)
4  i18n, English default         (needs 3)

Piece B — security and build hygiene
5  CSP + security headers        (needs 1)
6  code splitting                (needs 3)
7  hosting emulator config       (no dependencies)
8  scanner in CI + narrow keyId  (no dependencies)

Piece C — extraction, behaviour-preserving
9  ports + peer session          (no dependencies)
10 signed signal transport       (needs 9)
11 channel client + router       (needs 9, 10)

Piece D — browser peer and console
12 RTCDataChannel adapter        (needs 9)
13 RTCPeerConnection adapter     (needs 12)
14 browser connector + scopes    (needs 10, 11, 13)
15 console UI                    (needs 14, 2, 4)

Piece E
16 web E2E, rollout, docs        (needs everything)
```

Tasks 1, 2, 7, 8, and 9 have no dependencies and can start in parallel. Piece C is a pure move with no behaviour change; if it goes wrong, everything downstream is blocked, so it is gated harder than anything else in this plan.

## Completion gate

Every command must exit zero.

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build

pnpm verify:remote-build-config
pnpm verify:firebase-indexes
pnpm scan:client-artifacts
pnpm test:scan-client-artifacts

pnpm test:e2e
pnpm build:remote-test
pnpm test:remote-direct
pnpm test:remote-reconnect
pnpm test:remote-agent-workspace
pnpm test:web-console
```

`pnpm test:web-console` is created by Task 16. The four `remote-*` suites require macOS and a JDK; they are the regression gate for Piece C.

## Deliberate limitations

Recorded so a later reader does not mistake them for oversights.

- **The browser cannot attach to a host's pre-existing local terminals.** `terminal.attach` requires membership in the host gateway's `owned` set, and ownership is granted only by `agent.launch` or `terminal.create` (`host-control-gateway.ts:439`, `:469`). This is a deliberate security property, not a gap. The console launches its own agent and attaches to that.
- **`terminal.list` is implemented but not used by the console.** The host returns every terminal including ones the client may never attach to (`host-control-gateway.ts:449-462`), which is a confusing surface. The console does not request the scope.
- **Session status never advances past `approved`.** No Cloud Function writes `signaling`, `connected`, `disconnected`, `closed`, or `failed`, and `firestore.rules:77` denies client updates. The browser waits for `approved` exactly as the desktop does (`desktop-peer-connector.ts:308-313`). Closing that gap needs a new callable and a rules change; it is out of scope.
- **Signal documents are never deleted.** No TTL policy exists on `signals`, `remoteSessions`, or `devices`. Out of scope.
- **No ICE restart.** `negotiationId === sessionId` always, on both sides. The browser inherits this.
- **App Check stays disabled.**
- **TURN relay is still verified manually** after deploy, for the reason recorded in `docs/runbooks/remote-access.md`.

## Discovered during implementation: production is relay-only, and two docs say otherwise

Found while fact-checking the landing page copy in Task 3. **In production every remote session is relayed; there is never a direct peer path.**

`DesktopPeerConnector.acquireIceServers` (`desktop-peer-connector.ts:501-510`) returns `relayOnly: true` on every non-emulator path, and `native-peer.ts:208` turns that into `iceTransportPolicy: "relay"`, which restricts ICE to relay candidates only. The method's own comment confirms `issueTurnCredentials` is "unconditionally reachable in production".

Two documents contradict this and are factually wrong:

- `README.md:55` — "travel exclusively over the **direct peer connection** between the two Macs"
- `docs/runbooks/remote-access.md:87-88` — TURN credentials are minted "**only when a direct peer connection is not possible**"

The original design also specified otherwise: `docs/superpowers/specs/2026-08-01-codra-remote-terminal-design.md:337` says "The default policy is `all` … Tests also support `relay` to prove traffic can traverse Cloudflare TURN." Production shipped the test-only policy as the default.

**What is still true:** the relay forwards DTLS-encrypted packets it cannot read, and the Firebase control plane never carries terminal bytes — which is what the end-to-end Firestore scan actually enforces. The privacy claim survives; the _topology_ claim does not.

**Consequences to weigh separately from this plan:** every production session consumes relay bandwidth and pays relay latency, and remote access hard-fails when TURN is unavailable rather than falling back to a direct path. That may be deliberate — relay-only hides each peer's IP from the other — but it is undocumented.

**Task 16 must correct `README.md` and `docs/runbooks/remote-access.md`.** The landing page copy was written accurate to the code, not to the docs: it says traffic flows "end to end, never through the control plane that arranged it", which holds under both topologies. Do not "fix" the landing page to match the incorrect docs.

---

### Task 1: Routing that can serve a public page (design Piece A)

**Files:**

- Modify: `apps/web/src/App.tsx:66-154`, `:282-285`
- Create: `apps/web/src/routing.ts`
- Create: `apps/web/src/routing.test.ts`
- Modify: `firebase.json:11-20`
- Modify: `scripts/verify-remote-build-config.mjs:160-163`
- Delete: `apps/web/src/index.ts` (contents are literally `export {};`; nothing imports it)

**Interfaces:**

- Produces `export type CodraRoute = "landing" | "console" | "desktop-auth"` and `export function routeFromPathname(pathname: string): CodraRoute` in `apps/web/src/routing.ts`. Tasks 3, 5, 6, and 15 all consume it.

**The defect being fixed.** `App.tsx:83-87` rewrites _every_ path to `/login` whenever `state` is undefined:

```tsx
useEffect(() => {
  if (state || path === "/login") return;
  window.history.replaceState({}, "", "/login");
  setPath("/login");
}, [path, state]);
```

A signed-out visitor to `/` is silently moved to `/login`. A landing page cannot exist until this is gone. Separately, `App()` at `:282-284` reads `window.location.pathname` once at render with no `popstate` subscription, while the listener at `:77-81` lives inside `RemoteConsoleApp` — so the route and the render are already decoupled. `path` is never read in JSX; it exists only to feed the redirect effect.

- [ ] **Step 1: Write the failing routing test**

Create `apps/web/src/routing.test.ts` asserting `routeFromPathname` maps `/` and any unknown path to `"landing"`, `/console` to `"console"`, `/desktop-auth` to `"desktop-auth"`, and that `/login` also maps to `"console"` so the existing Firebase Hosting rewrite and any bookmarked URL keep working. Run it and watch it fail on the missing module.

- [ ] **Step 2: Implement `routing.ts`**

Pure function, no DOM access, so it is testable without jsdom.

- [ ] **Step 3: Lift routing into `App` and delete the redirect effect**

`App()` owns a single `useState`/`popstate` pair and switches on `routeFromPathname`. Delete `App.tsx:83-87` entirely. Delete the `replaceState` calls at `:110-111` and `:145-146`; navigation becomes explicit, driven by the landing page's call to action and the console's sign-out.

- [ ] **Step 4: Add the catch-all rewrite**

`firebase.json:11-20` gains a third entry so `/console` and every unknown path serve the SPA instead of 404ing:

```json
      { "source": "/desktop-auth", "destination": "/index.html" },
      { "source": "/login", "destination": "/index.html" },
      { "source": "**", "destination": "/index.html" }
```

- [ ] **Step 5: Update the verifier in the same commit**

`scripts/verify-remote-build-config.mjs:160-163` deep-equals the old two-element array and will fail. Extend it to the new three-element array. Run `pnpm verify:remote-build-config` and confirm exit 0.

**Gate:** `pnpm --filter @codra/web test && pnpm --filter @codra/web typecheck && pnpm verify:remote-build-config`

---

### Task 2: Instrument-deck design tokens (design Piece A)

**Files:**

- Modify: `apps/web/src/styles.css:1-298`

**The defect being fixed.** `apps/web/src/styles.css` contains zero CSS custom properties and hard-codes 22 distinct hex literals across 35 occurrences — `#0b1020` background, `#a5e8c4` mint accent — that belong to no CODRA design system. The approved language (`docs/superpowers/specs/2026-08-02-operator-console-ux-design.md`) is obsidian/deck/signal, and `apps/desktop/src/renderer/src/styles.css:2-16` already defines it. The web app is visually a different product.

- [ ] **Step 1: Port the token block verbatim**

Copy the fifteen custom properties from `apps/desktop/src/renderer/src/styles.css:2-16` into `apps/web/src/styles.css` `:root` — note `:17` is `color: var(--fog)`, not a property. Do not invent new token names; a later task may extract them to a shared file and divergent names would block that.

- [ ] **Step 2: Replace every hex literal with a token reference**

There are 22 distinct literals. Where a web literal has no exact desktop counterpart, pick the nearest token rather than adding a new one, and note the substitution in the commit message. Where nearest-by-colour-distance and the spec's role assignment disagree, the role wins — most importantly `#a5e8c4`, which is nearest to `--live` but is the primary-action fill, and the spec reserves jade for genuinely live state. It becomes `--signal`.

- [ ] **Step 3: Scope the bare element selectors**

`styles.css` styles `h1` (`:88-94`), `h2` (`:95-101`), `h3` (`:102-105`), and `button` (`:15-18`, `:188-194`) globally. These will leak into the landing page and the console. Scope them under the existing shell classes, or convert them to explicit classes.

- [ ] **Step 4: Drop the phantom font**

`styles.css:3` names `Inter` first but nothing loads it — no `@font-face`, no `<link>`. Either load it locally (no remote font dependency is permitted; the desktop spec says so explicitly) or remove the name so the declared stack is the real one. Removing is preferred.

**Gate:** `pnpm --filter @codra/web build && pnpm format:check`

---

### Task 3: The landing page (design Piece A)

**Files:**

- Create: `apps/web/src/landing/LandingPage.tsx`
- Create: `apps/web/src/landing/LandingPage.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**

- Produces `export default function LandingPage(props: { onOpenConsole: () => void }): ReactElement`.

**Content constraints.** The landing page describes what CODRA actually is, and every claim must be true of the shipped product. Source the copy from `README.md` and the product thesis in the UX design spec. Specifically:

- CODRA is a macOS desktop terminal for running agents in parallel. Local terminals and local agents need no account.
- Remote access is optional and off until you sign in and enable it.
- Terminal bytes, agent prompts, and workspace paths never reach Firebase — they travel over a direct WebRTC connection.
- Do **not** claim notarized or signed releases; `docs/runbooks/remote-access.md` records that signing credentials are deliberately absent.
- Do **not** write the uppercase token `CLOUDFLARE` anywhere on the page. Scanner rule `turn-vendor-constant` is a case-sensitive substring ban; "Cloudflare" in mixed case is fine and is explicitly proven allowed by `scripts/test-scan-client-artifacts.mjs:41`.
- Do **not** write a `turn:` or `turns:` URL. Rule `turn-url` matches `\bturns?://`.

- [ ] **Step 1: Write the failing test**

Assert the page renders a heading, states that local use needs no account, states that terminal data does not reach the server, and exposes exactly one primary control whose activation calls `onOpenConsole`. Use `data-testid` or role+accessible-name selectors that do not depend on the copy's exact wording — Task 4 translates this page.

- [ ] **Step 2: Implement the page**

Uses the Task 2 tokens. Must be usable at 320 px (the existing `body { min-width: 320px }`) and respect `prefers-reduced-motion`.

- [ ] **Step 3: Route `/` to it**

`App` renders `LandingPage` for route `"landing"`. Its primary control pushes `/console` and updates route state.

- [ ] **Step 4: Verify no scanner literal was introduced**

```bash
pnpm --filter @codra/web build
node scripts/scan-client-artifacts.mjs --root . 2>&1 | tail -5
```

The scan needs `apps/desktop/out/**` too; run a full `pnpm build` first if it reports a missing tree.

**Gate:** `pnpm --filter @codra/web test && pnpm build && pnpm scan:client-artifacts`

---

### Task 4: English default and message extraction (design Piece A)

**Files:**

- Create: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/landing/LandingPage.tsx`
- Modify: `apps/web/src/remote/DesktopAuthBridgeGoogle.tsx`, `apps/web/src/remote/DesktopAuthBridgeTestOnly.tsx`
- Modify: `apps/web/src/remote/DesktopAuthBridge.test.tsx:134`, `:141`

**No i18n library is added.** A grep of every `package.json` outside `node_modules` for `i18n|intl|react-intl|i18next|lingui|formatjs` returns zero matches, and any new dependency lands in `apps/web/dist` where it must clear the scanner's `keyId` and `sourceMappingURL` rules. A plain typed message record is enough for one locale and adds no bundle risk.

**The blocking hazard.** `apps/web/src/remote/DesktopAuthBridge.test.tsx:134` and `:141` select a button by the Korean accessible name `"이 호스트 허용"`. Translating `DesktopAuthBridgeGoogle.tsx:255` breaks CI's `pnpm test`. Both assertions must migrate to a stable selector in the same commit.

- [ ] **Step 1: Migrate the two test selectors first, and watch tests stay green**

Add a `data-testid` to the Allow button, switch both assertions to it, run `pnpm --filter @codra/web test`. This is a no-op refactor and must pass before any string changes.

- [ ] **Step 2: Extract the 51 Korean strings**

The full inventory is 34 in `App.tsx`, 13 in `DesktopAuthBridgeGoogle.tsx`, 2 in `DesktopAuthBridgeTestOnly.tsx`. Two are structurally interpolated across JSX children and need placeholder-shaped messages rather than string keys: `App.tsx:126` (`${host.displayName}에 연결 요청을...`) and `DesktopAuthBridgeGoogle.tsx:246-249`, whose Korean particle grammar is baked into the JSX structure — restructure that fragment rather than translating it word for word.

- [ ] **Step 3: Write English as the default locale**

`index.html:2` is already `<html lang="en">`, which is currently a lie; this makes it true.

- [ ] **Step 4: Keep the Korean strings as a second locale**

Preserve them in the same record keyed by locale. Do not delete work that already exists; the selection mechanism can be added later.

**Gate:** `pnpm --filter @codra/web test && pnpm --filter @codra/web typecheck`

---

### Task 5: CSP and security headers (design Piece B)

**Files:**

- Modify: `firebase.json` (add `hosting.headers`)
- Create: `apps/web/csp-plugin.ts`
- Modify: `apps/web/vite.config.ts`, `apps/web/vite.remote-test.config.ts`
- Modify: `apps/web/index.html`
- Create: `apps/web/csp-plugin.test.ts`

**The defect being fixed.** Finding A5: `apps/web/index.html` has no meta CSP and `firebase.json`'s hosting block has no `headers` array — yet this origin serves `/desktop-auth`, the page that renders the button approving a device login. There is no `frame-ancestors` and no `X-Frame-Options`, so it is clickjackable.

**Do not copy the desktop renderer's CSP.** `apps/desktop/src/renderer/index.html:8` ships `connect-src 'none'; frame-src 'none'`, which works only because the desktop renderer never touches Firebase — all Firebase traffic runs in the main process. The web app talks to Firebase from the document and needs a genuinely different policy.

**What the web app actually requires**, derived from its call sites:

| Directive     | Value                                                                                                                                                                      | Why                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `connect-src` | `'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://asia-northeast3-codra-1b3bb.cloudfunctions.net` | sign-in, token refresh, `onSnapshot`, callables         |
| `frame-src`   | `https://codra-1b3bb.firebaseapp.com`                                                                                                                                      | `browserPopupRedirectResolver` mounts `/__/auth/iframe` |
| `script-src`  | `'self' https://apis.google.com`                                                                                                                                           | the popup/redirect resolver loads `api.js`              |
| `style-src`   | `'self' 'unsafe-inline'`                                                                                                                                                   | xterm.js sets inline styles extensively                 |
| `img-src`     | `'self' data: https://*.googleusercontent.com`                                                                                                                             | Google profile photos, same allowlist as the desktop    |

Plus `default-src 'self'`, `font-src 'self' data:`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`.

**Two traps.** WebRTC ICE/TURN traffic is **not** governed by `connect-src` — do not try to allowlist it, and do not emit a `turn:` URL into the policy string, because `index.html` is inside the scanned tree and rule `turn-url` would deny the build. If you write the CSP3 `webrtc` directive at all, it must be `webrtc 'allow'`; `webrtc 'block'` kills the console.

- [ ] **Step 1: Write the failing plugin test**

Assert the production policy contains the five origins above and `frame-ancestors 'none'`, that the emulator policy instead allows `http://127.0.0.1:9099 http://127.0.0.1:8080 http://127.0.0.1:5001`, and that neither policy contains the substring `turn:` or the uppercase vendor token.

- [ ] **Step 2: Implement the build-time substitution plugin**

Model it on `apps/desktop/renderer-csp-plugin.ts:6-9`, which replaces a `__CODRA_CONNECT_SRC__` placeholder in the HTML at build time. The web equivalent must vary by config flavour because the emulator build needs loopback origins that must never reach production.

- [ ] **Step 3: Add `hosting.headers` to `firebase.json`**

Serve `Content-Security-Policy` as a real header — a `<meta http-equiv>` cannot express `frame-ancestors`. Mirror the header set already used by the loopback callback page (`apps/desktop/src/main/remote/desktop-login.ts:287-293`): `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, plus `X-Frame-Options: DENY`. Nothing in `verify-remote-build-config.mjs` asserts anything about `hosting.headers`, so this is verifier-safe.

**Gate:** `pnpm --filter @codra/web test && pnpm build && pnpm scan:client-artifacts && pnpm verify:remote-build-config`

---

### Task 6: Code splitting and lazy Firebase (design Piece B)

**Files:**

- Modify: `apps/web/src/App.tsx:9`
- Modify: `apps/web/vite.config.ts`, `apps/web/vite.remote-test.config.ts`

**The defect being fixed.** The bundle is 853.72 kB (gzip 255.79 kB) with no splitting configured — `apps/web/vite.config.ts` has no `build` key at all. Roughly two thirds is Firebase: `@firebase/firestore` alone is ~1.24 MB unminified, `@firebase/auth` ~462 kB. Worse, `App.tsx:9` statically imports `./remote/DesktopAuthBridge`, whose chain reaches `firebase-bridge.ts:17-19` where `initializeApp(...)` runs **at module scope**. A visitor to the landing page today downloads `@firebase/auth` and initialises a second Firebase app before first paint.

- [ ] **Step 1: Record the baseline**

```bash
pnpm --filter @codra/web build 2>&1 | grep -E "dist/assets|kB"
```

Write the numbers into the commit message so the improvement is measurable.

- [ ] **Step 2: `React.lazy` the desktop-auth bridge and the console**

Both become their own chunks. The landing page must not transitively import `firebase-bridge.ts`. Verify by building and grepping the landing chunk for `initializeApp`.

- [ ] **Step 3: Add `manualChunks`**

Split `firebase/firestore`, `firebase/auth`, `react`+`react-dom`, and `@xterm/*` into separate vendor chunks in **both** Vite configs.

- [ ] **Step 4: Confirm no `sourceMappingURL` survives**

`@xterm/xterm@6.0.0/lib/xterm.mjs` and `@xterm/addon-fit@0.11.0/lib/addon-fit.mjs` both ship the comment. Rollup strips it during bundling, but this has never been proven in CI. Build and grep `apps/web/dist` for the literal; it must not appear.

**Gate:** `pnpm build && pnpm scan:client-artifacts`

---

### Task 7: Make the Hosting emulator serve the emulator bundle (design Piece B)

**Files:**

- Create: `firebase.emulator.json`
- Modify: `package.json:17`

**The defect being fixed (finding #51).** `apps/web/vite.remote-test.config.ts:6` writes to `dist-remote-test`, but `firebase.json:10` serves `apps/web/dist` for every alias. So the Hosting emulator on `127.0.0.1:5000` — which `packages/protocol/src/deployment.ts:136-140` declares as the emulator `browserOrigin` — serves the **production** bundle, pointed at the real `codra-1b3bb` project. Compounding it, nothing ever builds `dist-remote-test`: root `build:remote-test` (`package.json:28`) is desktop-only, and `apps/web`'s own `build:remote-test` script has no caller anywhere in the repo.

**Do not "fix" this by dropping `outDir`.** Pointing both flavours at `apps/web/dist` makes a stale emulator build deployable to production carrying `signInWithEmailAndPassword` and `demo-codra` — exactly what the alias seam exists to prevent.

- [ ] **Step 1: Add `firebase.emulator.json`**

Same `firestore`, `functions`, and `emulators` blocks; `hosting.public` is `apps/web/dist-remote-test` with the same rewrites as Task 1 left in `firebase.json`.

- [ ] **Step 2: Point the emulator script at it and build the web bundle first**

`package.json:17` gains `pnpm --filter @codra/web build:remote-test` in its chain and passes `--config firebase.emulator.json`.

- [ ] **Step 3: Confirm the two-device harness is unaffected**

`tests/e2e/remote-harness.ts:211-220` passes `--only auth,firestore,functions` precisely because a `hosting` key would otherwise start the Hosting emulator. Re-read that comment and confirm the change does not disturb it. Do not modify the harness.

**Gate:** `pnpm verify:remote-build-config && pnpm test:remote-direct`

---

### Task 8: Put the scanner in CI and narrow the `keyId` rule (design Piece B)

**Files:**

- Modify: `.github/workflows/ci.yml` (after the Build step)
- Modify: `docs/security/remote-baseline.json:90-95`
- Modify: `scripts/test-scan-client-artifacts.mjs`
- Modify: `docs/remote-access-follow-ups.md`

**Why now.** `pnpm scan:client-artifacts` has never run in CI. Every task in Pieces A–D adds code or dependencies to a bundle the scanner guards, and a regression would go unnoticed until someone ran it by hand.

**The rule to narrow.** `docs/remote-access-follow-ups.md:39-48` records that `signing-key-id-field` bans the bare literal `keyId`, that `keyId`/`kid` are ordinary JWT/JWK/WebAuthn field names, and that the cheapest response to a future false positive is to delete the rule rather than narrow it. Task 15 adds xterm to the bundle and Task 4 considered an i18n dependency; narrow it before it fires.

- [ ] **Step 1: Verify the current bundle is clean, then add the CI step**

`pnpm build` produces every tree the scanner needs, so the step slots in directly after Build.

- [ ] **Step 2: Narrow the rule to a JSON-key-shaped anchor**

Change `signing-key-id-field` from a `literal` to a `regex` matching the key in serialized-object position rather than the bare identifier. Add a case to `scripts/test-scan-client-artifacts.mjs` proving the Cloudflare-shaped payload is still denied **and** that a JWK-shaped `keyId` field name in an unrelated position is allowed.

- [ ] **Step 3: Update the follow-ups doc**

Move the `signing-key-id-field` section from "latent trap" to resolved, keeping the `safe-storage-test-alias` section untouched — that one is still inert and still correct.

**Gate:** `pnpm build && pnpm scan:client-artifacts && pnpm test:scan-client-artifacts`

---

### Task 9: Extract the peer ports and negotiation session (design Piece C)

**Files:**

- Create: `packages/remote-client/package.json`, `tsconfig.json`, `src/index.ts`
- Move: `apps/desktop/src/main/remote/peer-session.ts` → `packages/remote-client/src/peer-session.ts`
- Move: `apps/desktop/src/main/remote/peer-session.test.ts` → `packages/remote-client/src/peer-session.test.ts`
- Modify: importers in `apps/desktop/src/main/remote/**`
- Modify: `pnpm-workspace.yaml` is already `packages/*`; no change needed

**This task changes no behaviour.** It is a move plus import rewrites. `peer-session.ts:1-15` imports only `@codra/protocol` and `@codra/webrtc`; the file is platform-neutral and the four interfaces it defines (`PeerChannelPort`, `PeerConnectionPort`, `PeerSignalPort`, `PeerChannels`) are what the browser adapter in Tasks 12–13 must satisfy. They are currently unreachable from `apps/web`.

**Why a new package rather than `packages/webrtc`.** `packages/webrtc` declares `node-datachannel` as a hard runtime dependency. Tasks 10 and 11 add `@codra/firebase` to the same graph, and piling both into the package the browser already imports makes the one `import type` thread holding `node-datachannel` out of the web bundle even more load-bearing.

- [ ] **Step 1: Create the package with `exports: { ".": "./src/index.ts" }`**

Match `packages/webrtc/package.json:6-8` exactly — raw TypeScript source, no build step, consistent with every other workspace package.

- [ ] **Step 2: Move the file and its test unchanged**

Do not rename `DesktopPeerSession` in this step even though the name is now wrong; a rename in the same commit as a move makes the diff unreviewable. Rename in Step 4.

- [ ] **Step 3: Rewrite importers and run the full desktop suite**

```bash
pnpm --filter @codra/desktop test && pnpm typecheck
```

Test count must match the baseline exactly.

- [ ] **Step 4: Rename `DesktopPeerSession` → `PeerNegotiationSession`**

Separate commit. Keep `DesktopPeerSessionOptions` → `PeerNegotiationSessionOptions` consistent.

- [ ] **Step 5: Harden the `node-datachannel` boundary**

Add a test to `packages/remote-client` asserting that no module in its own `src/` graph value-imports `node-datachannel`. This is the guard the follow-ups doc says is missing everywhere else.

**Gate:** `pnpm typecheck && pnpm test && pnpm test:remote-direct && pnpm test:remote-reconnect`

---

### Task 10: Extract the signed signal transport (design Piece C)

**Files:**

- Move: `apps/desktop/src/main/remote/signal-transport.ts` → `packages/remote-client/src/signal-transport.ts`
- Move: its test alongside
- Modify: `packages/remote-client/package.json` to add `@codra/firebase`
- Modify: importers in `apps/desktop/src/main/remote/**`

`signal-transport.ts:1-15` imports only `@codra/firebase`, `@codra/protocol`, `@codra/webrtc`, and uses `CryptoKey` and `Date.now`. It is browser-safe as written. `SignedSignalTransport` structurally satisfies `PeerSignalPort` and owns the publish serialisation (`:121-158`) that keeps sequence numbers strictly contiguous — the browser must reuse it, not reimplement it, because `SignalVerifier` hard-fails on any gap (`signal-verifier.ts:63-64`).

- [ ] **Step 1: Move, rewrite importers, run the desktop suite**
- [ ] **Step 2: Pin the `expiresAt` clamp interaction with a test**

`functions/src/index.ts:489-496` clamps `expiresAt` to `min(input.expiresAt, now + 3_600_000)` and then verifies a signature that covers `expiresAtMillis`. **Determine empirically whether the signature is verified against the clamped or the original value** — read the function line by line and write a test at the transport level pinning the answer. If the clamp precedes verification, then any client signing an `expiresAt` beyond one hour invalidates its own signature, and `SignedSignalTransport` must never emit one. `SIGNAL_LEASE_MS` is 3 600 000, so the schema already agrees; the risk is a caller passing a longer session lease through.

**Gate:** `pnpm typecheck && pnpm test && pnpm test:remote-direct`

---

### Task 11: Extract the channel client and terminal router (design Piece C)

**Files:**

- Move: `apps/desktop/src/main/remote/remote-agent-client.ts` → `packages/remote-client/src/agent-channel-client.ts`
- Move: `apps/desktop/src/main/remote/proxy-terminal-router.ts` → `packages/remote-client/src/terminal-router.ts`
- Move: both tests alongside
- Modify: importers

`remote-agent-client.ts` is the entire client protocol — hello, request/response correlation, 15 s timeouts, output-frame handling. Its **only** Node dependency is `randomUUID` from `node:crypto` (`:1`, used at **nine** call sites: `:318, 332, 347, 362, 381, 397, 410, 424, 436`). Note its `HandshakeGate` role literal is already `"browser"` (`:274-282`).

**Do not edit by line number — grep for every call site.** An earlier draft of this list omitted `:436` (the `terminal.detach` request); following it literally leaves one bare `randomUUID()` behind and breaks the build the moment the import is dropped.

`proxy-terminal-router.ts` owns the cursor/ack/decode loop the browser must mirror exactly, including the ack-clamp (`:358-370`) and its reset-on-resume rule (`:170-179`).

- [ ] **Step 1: Swap `randomUUID` for `crypto.randomUUID()`**

Do this first, as its own commit, and run the desktop suite. `globalThis.crypto.randomUUID` exists in Node 22 and in every secure browser context.

- [ ] **Step 2: Move both files, rewrite importers, run everything**

The ack-clamp is pinned by three mutation-verified tests at `proxy-terminal-router.test.ts:256`, `:299`, `:362`. They must still pass unchanged.

- [ ] **Step 3: Export the public surface from `packages/remote-client/src/index.ts`**

`start`, `workspaceRoots`, `workspaceList`, `workspaceValidate`, `runtimes`, `launch`, `write`, `resize`, `attach`, `detach`, `acknowledge`, `onOutputFrame`, `onTerminalChanged`, `onDisconnected`, `close`.

**Gate:** `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm test:remote-direct && pnpm test:remote-reconnect && pnpm test:remote-agent-workspace`

This is the hardest gate in the plan. Piece C is finished only when all four remote suites pass.

---

### Task 12: Browser `RTCDataChannel` adapter (design Piece D)

**Files:**

- Create: `apps/web/src/remote/browser-channel.ts`
- Create: `apps/web/src/remote/browser-channel.test.ts`

**Interfaces:**

- Produces `export function adoptBrowserChannel(channel: RTCDataChannel): PeerChannelPort`.

**Three defects that will not surface as type errors.** Model the implementation on `apps/desktop/src/main/remote/native-peer.ts:16-107`, especially its `ListenerSet` at `:16-31`.

1. `channel.binaryType` defaults to `"blob"` in browsers. It must be set to `"arraybuffer"`, or `onMessage` yields a `Blob` and both `decodeRemoteControlMessage` and `decodeOutputFrameBinary` break.
2. `bufferedAmountLowThreshold` defaults to `0`, so `bufferedamountlow` effectively never fires. Set it to `DATA_CHANNEL_LOW_WATERMARK` (`attachment-pump.ts:8`, 256 KiB).
3. `onOpen` must `queueMicrotask(listener)` when `readyState === "open"` already — `native-peer.ts:85-87` has this fix. Without it, `deliverChannelsWhenReady` can deadlock because the second channel opened before its listener was registered.

`bufferedAmount` is a property in the browser and a method in node-datachannel; the port declares a property, so the browser is the easier fit. A default `createDataChannel(label, { ordered: true })` yields `ordered === true`, `maxRetransmits === null`, `maxPacketLifeTime === null`, which passes the reliability assertion at `peer-session.ts:218-224` unchanged.

- [ ] **Step 1: Write failing tests for all three defects**

Use a hand-written fake `RTCDataChannel`. Assert `binaryType` is set, the threshold is set, and that an already-open channel still delivers `onOpen`.

- [ ] **Step 2: Implement, wrapping `RTCErrorEvent` into `Error` for `onError`**
- [ ] **Step 3: Assert every listener registration returns a working unsubscribe**

**Gate:** `pnpm --filter @codra/web test && pnpm --filter @codra/web typecheck`

---

### Task 13: Browser `RTCPeerConnection` adapter (design Piece D)

**Files:**

- Create: `apps/web/src/remote/browser-peer.ts`
- Create: `apps/web/src/remote/browser-peer.test.ts`

**Interfaces:**

- Produces `export function createBrowserPeerConnection(iceServers: RTCIceServer[], options: { relayOnly: boolean }): PeerConnectionPort`.

**The impedance mismatch.** `PeerConnectionPort` is synchronous and void-returning because node-datachannel is; the browser API is Promise-based. The adapter bridges this, and the port has no error return, so every rejection must be routed into the `onStateChange`/error path or it becomes an unhandled rejection.

| Port method              | Browser implementation                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setLocalDescription`    | `createOffer()`/`createAnswer()` then `await pc.setLocalDescription(desc)`; on resolve read `pc.localDescription` and invoke the `onLocalDescription` listener — the browser has no such event |
| `setRemoteDescription`   | Promise; must serialise against queued candidates                                                                                                                                              |
| `addRemoteCandidate`     | **Queue until `remoteDescription` is set**, then `addIceCandidate`                                                                                                                             |
| `onLocalCandidate`       | `pc.onicecandidate`; non-null → `cb(e.candidate.candidate, e.candidate.sdpMid ?? "0")`                                                                                                         |
| `onGatheringStateChange` | `pc.onicegatheringstatechange` → `pc.iceGatheringState`; `peer-session.ts:99` only tests `=== "complete"`, a direct match                                                                      |
| `onStateChange`          | `pc.onconnectionstatechange` → **`pc.connectionState`**, not `iceConnectionState`; its vocabulary matches `peer-session.ts:102-110` exactly                                                    |
| `createDataChannel`      | `pc.createDataChannel(label, { ordered: true })` — no `{unordered}` inversion, unlike node-datachannel                                                                                         |

`peer-session.ts:174-177` passes `sdpMid ?? "0"`; the literal `"0"` is what node-datachannel emits. If the host's SDP uses a different mid, fall back to `sdpMLineIndex`.

- [ ] **Step 1: Write the failing candidate-queue test**

Assert a candidate added before `setRemoteDescription` is not dropped and is applied afterwards, in order.

- [ ] **Step 2: Implement the adapter**
- [ ] **Step 3: Test the synthesised `onLocalDescription`**

**Gate:** `pnpm --filter @codra/web test && pnpm --filter @codra/web typecheck`

---

### Task 14: The browser connector and correct scopes (design Piece D)

**Files:**

- Create: `apps/web/src/remote/browser-peer-connector.ts`
- Create: `apps/web/src/remote/browser-peer-connector.test.ts`
- Modify: `apps/web/src/remote/controller.ts:32-37`

**The scope defect.** `DEFAULT_SCOPES` is currently `["terminal.list", "terminal.attach", "terminal.write", "terminal.resize"]`. This can never produce a working terminal: `terminal.attach` requires membership in the host's `owned` set, granted only by `agent.launch` or `terminal.create`. Replace it with the set the desktop uses (`host-control-gateway.ts:35-43`):

```
workspace.read, agent.runtimes, agent.launch, terminal.write, terminal.resize, terminal.detach, terminal.attach
```

Requesting `terminal.list` or `terminal.create` would also render as an unlabelled raw string in the host's approval modal, because `SessionApprovalDialog.tsx:7-15` has no entry for either.

**Port these four methods from `desktop-peer-connector.ts`:**

| Method              | Source lines | Notes                                                                       |
| ------------------- | ------------ | --------------------------------------------------------------------------- |
| `waitForApproval`   | `:275-326`   | Resolve on `approved`; in practice nothing else ever fires. 2-minute cap.   |
| `verifyApproval`    | `:328-358`   | Verify the host's signature before trusting anything                        |
| `acquireIceServers` | `:501-510`   | **Mirror the emulator branch exactly** — see below                          |
| `negotiateClient`   | `:360-434`   | Client is the offerer; creates both channels _before_ `setLocalDescription` |

**The emulator branch is load-bearing.** When `runtime.deployment.mode === "emulator"`, skip `issueTurnCredentials` entirely and use `iceServers: []` with `iceTransportPolicy: "all"`. `normalizeBrowserIceServers` throws on an empty list, so the call must be guarded, not called-and-filtered. In production, map credentials exactly as `iceInputs` does (`:84-92`), run them through `normalizeBrowserIceServers`, then **strip the `transport` field** — it is not a member of `RTCIceServer` — and set `iceTransportPolicy: "relay"`.

- [ ] **Step 1: Fix `DEFAULT_SCOPES` with a test asserting the exact set**
- [ ] **Step 2: Port `waitForApproval` and `verifyApproval` with tests**
- [ ] **Step 3: Port `acquireIceServers`, testing both the emulator and production branches**
- [ ] **Step 4: Port `negotiateClient`, asserting channel creation precedes the offer**

**Gate:** `pnpm --filter @codra/web test && pnpm --filter @codra/web typecheck && pnpm build && pnpm scan:client-artifacts`

---

### Task 15: The console UI (design Piece D)

**Files:**

- Create: `apps/web/src/console/ConsoleApp.tsx`, `WorkspacePicker.tsx`, `RuntimePicker.tsx`, `WebTerminalPane.tsx`
- Create: co-located tests
- Modify: `apps/web/src/App.tsx`

**The flow, in the only order the host permits:**

1. Sign in, register the browser device, list hosts — already implemented in `controller.ts:52-104`.
2. Request a session with the Task 14 scopes; the host user approves in the desktop modal.
3. Negotiate, handshake.
4. `workspace.roots` → `workspace.list` to browse, `workspace.validate` to confirm.
5. `agent.runtimes` to populate the picker.
6. `agent.launch` with `{ cwd, cols, rows, agent }` — the host **auto-attaches** and output starts flowing _before_ the `agent.ok` response arrives.
7. Render output, send `terminal.write` / `terminal.resize`, ack every frame.

**The auto-attach race is not theoretical.** `host-control-gateway.ts:414-448` attaches at step 5 of its own sequence and replies afterwards. `proxy-terminal-router.ts:296-302` handles this with an `earlyFrames` queue capped at 64 frames per terminal, drained in `create()` at `:151-154`. The console gets this for free by using the extracted router from Task 11 — **do not write a parallel frame path.**

**The xterm integration precedent** is `apps/desktop/src/renderer/src/terminal/TerminalPane.tsx`. Reuse its `FitAddon` wiring, its debounced fit-and-resize, and its 20-colour theme (`:139-166`) — but note the briefing already flags that theme as a second hard-coded source of truth that CSS variables do not reach. Prefer deriving it from the Task 2 tokens if that can be done without behaviour change; otherwise copy it and record the duplication.

**Ack discipline.** Every frame is acked with `max(lastAcknowledged, frameEnd)`, never a bare `frameEnd`. An ack that regresses below the pump's `acknowledgedCursor`, or exceeds its `sentCursor`, throws `OUTPUT_CURSOR_INVALID` inside a message that has no `requestId` — so the error escapes and **kills the whole peer session** over what is usually a harmless duplicate frame.

- [ ] **Step 1: Workspace picker against a faked client**
- [ ] **Step 2: Runtime picker, honouring `available`, `supportsYolo`, and `modelRequired`**

`host-control-gateway.ts:414-448` rejects a launch with `RUNTIME_UNAVAILABLE` if the runtime is unavailable, if `yolo` is requested where unsupported, or if a required model is missing. The UI must not offer a combination the host will refuse. Ollama additionally requires a model and forbids `yolo`.

- [ ] **Step 3: Terminal pane with xterm, wired to the extracted router**
- [ ] **Step 4: Assert the console never sends `terminal.list`**
- [ ] **Step 5: Confirm the bundle still clears the scanner**

xterm enters `apps/web/dist` for the first time here. Build and scan.

**Gate:** `pnpm --filter @codra/web test && pnpm build && pnpm scan:client-artifacts`

---

### Task 16: Web console end-to-end, rollout, and docs (design Piece E)

**Files:**

- Create: `tests/e2e/web-console.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `scripts/verify-remote-build-config.mjs:184-206`
- Modify: `package.json` (add `test:web-console`)
- Modify: `README.md`, `docs/runbooks/remote-access.md`

**Two tripwires this task must clear.** `verify-remote-build-config.mjs:202-206` asserts **exactly four** six-space-indented `timeout:` lines in `playwright.config.ts`; a fifth project breaks it. And `:184-201` requires each remote project to have a matching `test:<project>` root script with an exact command string. Update both.

- [ ] **Step 1: Write the spec**

Drive a real browser against the emulator Hosting origin fixed by Task 7, with a desktop host instance from the existing harness. Prove: session request → approval → negotiation → agent launch on a chosen workspace → terminal output round-trip → input echo.

**Free port 5000 first.** On macOS, Control Center's AirPlay Receiver binds `*:5000`, which collides with the Hosting emulator's `127.0.0.1:5000`. `assertEmulatorPortsFree()` in `tests/e2e/remote-harness.ts` only checks 9099, 8080, and 5001, so the failure surfaces as an unexplained `EADDRINUSE` rather than a clear message. Disable it in System Settings → General → AirDrop & Handoff, and extend `assertEmulatorPortsFree()` to cover 5000 so the next person gets a real error.

**CSP composes by intersection.** The Hosting emulator really does apply `hosting.headers` (superstatic ships `lib/middleware/headers.js`), and a response carrying both a CSP header and the `<meta http-equiv>` CSP that `csp-plugin.ts` bakes into the HTML must satisfy **both**. Task 7 keeps the two byte-identical for the emulator flavour. If this spec starts failing with blocked requests to `127.0.0.1:9099/8080/5001`, suspect drift between `firebase.emulator.json`'s header and the plugin's meta tag before suspecting the console code.

- [ ] **Step 2: Extend the Firestore privacy scan to the browser flow**

Reuse `scanEveryFirestoreDocument` from `remote-agent-workspace.spec.ts:104-131`. Assert the prompt, an input token, and the workspace path appear in **no** document, and — as that spec does at `:292-307` — assert the scan was not vacuous by requiring `/signals/` documents to exist.

- [ ] **Step 3: Add the Playwright project and the root script; update the verifier**
- [ ] **Step 4: Update `README.md`**

The remote-access section currently says one CODRA Mac browses another. Add the browser console as a second client, and state plainly that it launches its own agent rather than attaching to the host's existing terminals.

- [ ] **Step 5: Update `docs/runbooks/remote-access.md`**

Add the Hosting deploy path for the new routes, the CSP header block, and a post-deploy check that the console completes a real session against live Firebase. Note that the scope list in the "Session approval and scopes" section is what the browser now requests.

Correct the two false claims recorded under "Discovered during implementation" above: `README.md:55` and this runbook's `:87-88` both describe a direct peer connection that production never uses.

Add these two post-deploy checks, neither of which any emulator can cover:

1. **The auth relay iframe still frames.** Task 5 applies `X-Frame-Options: DENY` and `frame-ancestors 'none'` at `source: "**"`. Firebase's popup/redirect resolver loads `https://codra-1b3bb.firebaseapp.com/__/auth/iframe` — same Hosting site, reserved namespace — and our page must be able to frame it. Firebase serves `/__/*` from a layer ahead of site config, which is also why the `**` rewrite does not swallow `/__/auth/handler`, so this is expected to work. It is not verifiable before deploy. Check it:

   ```bash
   curl -sI https://codra-1b3bb.firebaseapp.com/__/auth/iframe | grep -iE "x-frame-options|content-security-policy"
   ```

   Neither header may appear. If either does, scope the header block away from `/__/**` rather than dropping the protection from the pages that need it — those headers are the whole point of Task 5, which exists because `/desktop-auth` renders the button that approves a device login.

2. **Google sign-in completes from the deployed console**, end to end, in a real browser.

**Gate:** the full completion gate at the top of this plan.

---

## Open questions to resolve during implementation

These are known unknowns, not oversights. Each has a task that must answer it.

1. ~~**Does `publishSignal` verify the signature before or after clamping `expiresAt`?**~~ **ANSWERED in Task 10 — the clamp runs first.** `functions/src/index.ts:489-496` builds the signal with `expiresAt: Math.min(input.signal.expiresAt, now + 3_600_000)`, and `:497-504` then verifies against that clamped object. `buildSignalSigningPayload` (`packages/protocol/src/remote.ts:1110-1127`) covers `expiresAtMillis`, so a lease past the boundary is rewritten out from under its own signature and rejected with `SIGNAL_SIGNATURE_INVALID`. Established by probe with real P-256 keys, then pinned by two mutation-verified tests in `packages/remote-client/src/signal-transport.test.ts`.

   **The failure mode is sharper than originally written.** The clamp is computed against the **server's** `now`; the transport's lease against the **client's** `createdAt`. So the boundary is not "beyond one hour" but **"at or beyond one hour, combined with any client-ahead clock skew"** — at exactly one hour, 1 ms of skew is enough. No behaviour change was needed: `SignedSignalTransport.publish()` already bounds `expiresAt` to `min(session.expiresAt, createdAt + min(SIGNAL_LEASE_MS, REMOTE_SESSION_MAX_LEASE_MS))`, and today it is safe only because `DesktopPeerConnector` requests a 15-minute session lease (`CLIENT_SESSION_LEASE_MS`), leaving ~45 minutes of slack. **Task 14 must keep the browser's session lease comfortably under an hour** — `apps/web/src/remote/controller.ts:113` currently defaults to 30 minutes, which is safe; pin it with a test and do not let a caller raise it past ~45 minutes. Properly closing this would mean signing `createdAt + SIGNAL_LEASE_MS - skewMargin`, a behaviour change deliberately not made here.

2. ~~**Does the host's SDP use `sdpMid` values a browser accepts?**~~ **ANSWERED in Task 13.** The adapter scans the remote SDP's `a=mid:` lines; a signalled mid the host's SDP does not declare falls back to `{ sdpMLineIndex: 0 }`, which is correct because data-only negotiation has exactly one m-section. Covered by a test using `a=mid:data` against the literal `"0"` that `peer-session.ts:176` substitutes. Local candidates are forwarded as `sdpMid ?? String(sdpMLineIndex ?? 0)`.
3. ~~**Does Rollup reliably strip `sourceMappingURL` from the xterm dist?**~~ **ANSWERED in Task 6 — yes, proven directly.** Because nothing imports xterm yet, a plain grep of `dist` would have passed vacuously. Task 6 temporarily added a probe importing `Terminal`, `FitAddon`, and `xterm.css`, rebuilt (emitting `vendor-xterm-*.js` at 330.51 kB with xterm markers present), and confirmed no `sourceMappingURL` survived; the probe was then reverted. The `vendor-xterm` chunk rule is therefore confirmed working ahead of Task 15.
4. ~~**Can the xterm 20-colour theme be derived from CSS tokens without behaviour change?**~~ **ANSWERED in Task 15 — no, not derivably.** Only 8 of the 21 entries have a token counterpart (`background`/`cursorAccent`→`--obsidian`, `cursor`→`--signal`, `black`→`--deck`, `red`→`--danger`, `green`→`--live`, `yellow`→`--warning`, `brightBlack`→`--muted-dim`). The other 13 — `foreground #dbe1ea`, `selectionBackground #2b3858`, blue/magenta/cyan/white and all eight brights — exist nowhere in the repo except `TerminalPane.tsx:139-166`, and no deterministic rule over the 15 tokens reproduces them.

   Task 15 took a middle path rather than a blind copy: all 21 live in `apps/web/src/styles.css` as `--terminal-*` custom properties — 8 declared as `var(--token)` aliases so they track the design system, 13 copied verbatim with the duplication recorded at the declaration site — and `WebTerminalPane` reads them back via `getComputedStyle`. Zero colour literals in TSX, one source of truth on the web side. A token resolving empty is omitted rather than defaulted, so a second copy cannot creep back in. **The desktop's hardcoded theme is unchanged** and remains a separate source of truth; unifying the two is out of scope.

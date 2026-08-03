# Remote access runbook

Remote access lets a client launch and drive agents on a CODRA Mac signed
in to the same account. The client is either another CODRA Mac or the
browser console at `/console`. It is optional; local terminals and local
agents never touch it.

## What Firebase carries, and what it never carries

Firebase carries account sign-in, device registration, presence, session
request/approval records, and WebRTC signalling. Terminal bytes, agent
prompts, and workspace paths travel only over the encrypted WebRTC data
channel and are never written to Firestore. Two end-to-end specs enforce
this by scanning every document in the Firestore emulator for the prompt,
the input token, and the workspace path — once while the session is live
and again after both ends have torn down:
`tests/e2e/remote-agent-workspace.spec.ts` after a desktop-to-desktop
session, `tests/e2e/web-console.spec.ts` after a browser-console one.

## Every production session is relayed

This is the one place where the topology is easy to get wrong, so state it
plainly: **there is no direct path between the two peers in production.**
`DesktopPeerConnector.acquireIceServers`
(`apps/desktop/src/main/remote/desktop-peer-connector.ts`) and its browser
counterpart (`apps/web/src/remote/browser-peer-connector.ts`) return
`relayOnly: true` on every non-emulator path, and the peer factories turn
that into `iceTransportPolicy: "relay"`
(`apps/desktop/src/main/remote/native-peer.ts`,
`apps/web/src/remote/browser-peer.ts`), which restricts ICE to relay
candidates. Only the emulator path — where the TURN callable cannot work
and two loopback peers need no relay — asks for an unrestricted policy.

Three consequences follow, none of them optional:

1. Every production session consumes Cloudflare relay bandwidth and pays
   relay latency.
2. When TURN is unavailable, remote access fails outright. There is no
   direct path to fall back to.
3. Neither peer learns the other's IP address, which may well be why the
   policy is what it is — the original design
   (`docs/superpowers/specs/2026-08-01-codra-remote-terminal-design.md`)
   specified `all` as the default with `relay` for tests, and production
   shipped the test-only policy. Changing it back is a product decision,
   not a cleanup.

What the relay does **not** change: it forwards DTLS-encrypted packets it
cannot read, and the Firebase control plane still carries no terminal byte.
That is the claim the Firestore scans above enforce, and it survives the
relay.

## Production Identity Platform providers

`firebase.json` no longer carries an `auth` block. The Auth emulator
ignored it (`AgentProjectState.allowPasswordSignup` is a hardcoded
`return true` inside `firebase-tools`), so the block only ever described
the production project, and leaving it in place would let a bare
`firebase deploy` silently provision email/password self-signup on
`codra-1b3bb`. Configure the following in the Firebase console for project
`codra-1b3bb` under **Authentication → Sign-in method**, and change
nothing else:

- **Google** — enabled. This is the only provider CODRA accepts in
  production; `requireAccount` in `functions/src/auth.ts` rejects every
  other `sign_in_provider` with `ACCOUNT_PROVIDER_NOT_ALLOWED`, and accepts
  `password` only when `FUNCTIONS_EMULATOR === "true"`.
- **Email/password** — disabled in production. It exists only in the
  `demo-codra` emulator, driven by `account-bootstrap-test-only.ts`.
- OAuth brand display name: `CODRA`
- Support email: `wicklim90@gmail.com`
- Authorized redirect URIs:
  - `http://127.0.0.1`
  - `https://codra-1b3bb.firebaseapp.com/__/auth/handler`
  - `https://codra-1b3bb.web.app/__/auth/handler`

The loopback URI is required: desktop sign-in runs in the system browser
and returns to a loopback listener, never to an embedded browser window.
This is the console-configuration equivalent of the `auth` block Task 1
deleted from `firebase.json`; this section is now its only record.

## Desktop sign-in

1. In CODRA, open the account control in the sidebar and choose Google.
2. The system browser opens `https://codra-1b3bb.firebaseapp.com/desktop-auth`.
3. After consent, the browser lands on the loopback callback page, which
   focuses CODRA and closes itself. If browser policy blocks the close,
   the page shows a **Return to CODRA** button. The page loads no
   subresource and renders no token, session id, or account detail.
4. CODRA's account control shows the signed-in identity.

Failure states: `REMOTE_LOGIN_CANCELLED` (the window was closed or the
attempt was superseded), `AUTH_PROVIDER_UNAVAILABLE` (a non-Google
provider was requested against production).

## Host activation and device registration

Enable **Remote access** in Settings. Activation registers this Mac as a
host device with a display name derived from `os.hostname()`, signs in a
device-scoped Firebase session with a custom token, and starts a
heartbeat. The status strip shows `Remote online`. Deactivating tears down
all peer connections and the device session; terminals keep running.

## Session approval and scopes

When another Mac or the browser console requests a session, CODRA shows an
in-app approval modal — not a native dialog — naming the requesting device
and listing every requested scope, each independently deniable:

`workspace.read`, `agent.runtimes`, `agent.launch`, `terminal.write`,
`terminal.resize`, `terminal.detach`, `terminal.attach`.

That list is exactly what the browser console requests
(`DEFAULT_SCOPES`, `apps/web/src/remote/controller.ts`), so a modal raised
by a browser session looks the same as one raised by a desktop client; the
requesting device is named `CODRA browser`. `terminal.list` and
`terminal.create` are deliberately not requested — neither has a label in
the modal, so asking for either would show the host user a raw scope
string.

`agent.launch` permits running an agent on this Mac. Denying every scope
is a rejection, not an empty approval. `terminal.attach` only ever applies
to terminals the same peer launched on this host; it never exposes local
terminals, which is why the browser console launches its own agent instead
of attaching to whatever the host already has open. If no window is open
when a request arrives, CODRA opens one; if the window cannot be created,
the session is rejected rather than left pending.

## TURN and its history

Cloudflare TURN credentials are minted per session by the
`issueTurnCredentials` callable (`functions/src/turn.ts`), on every
production session — see "Every production session is relayed" above; this
is not a fallback that only fires when a direct path fails. The desktop and
browser clients never see the Cloudflare bearer token — see
`docs/runbooks/cloudflare-turn.md` for the secret's JSON shape and
provisioning rules.

Record this because it is surprising and easy to rediscover the hard way:
**`issueTurnCredentials` never worked until this plan.** Four separate
defects, all now fixed, combined to break it:

1. The live Cloudflare `generate-ice-servers` endpoint returns the field
   `iceServers` (camelCase). The callable's response schema required
   `ice_servers` (snake_case) under `.strict()`, so every real Cloudflare
   response failed to parse.
2. Cloudflare's response mixes in a credential-less STUN entry alongside
   the TURN relay entry. That entry has no `username`/`credential` and
   uses a `stun:` URL scheme, which the desktop's only ICE consumer
   rejects outright (it forces relay-only UDP TURN and never gathers
   STUN/host candidates).
3. One of the six TURN URLs Cloudflare returns uses port 53. The client's
   URL parser rejected it.
4. Under the old client code, a single unparseable URL inside an
   otherwise-valid credential set discarded the _entire_ set, so defect 3
   alone was enough to fail every session that needed a relay, even with
   defects 1 and 2 fixed.

The fix filters the credential-less STUN entry out at the function
boundary, accepts `iceServers`, and (in `packages/webrtc/src/ice.ts`)
tolerates the known-benign `:53` URL variant within a credential set
instead of discarding the whole set on one bad URL. A future operator
debugging TURN should not have to rediscover any of this.

## CLOUDFLARE_TURN_CONFIG pre-flight

Cloud Functions v2 pins a deployed function to the secret version that
existed at deploy time. Setting a new secret version does **not** update
an already-deployed function — only a redeploy of `issueTurnCredentials`
picks up the new version. `CLOUDFLARE_TURN_CONFIG` is currently set on
`codra-1b3bb` at version 3; confirm the deployed function has actually
picked it up as part of every rollout that touches Functions.

Check that the secret exists and inspect its version history **without
ever printing its value**:

```bash
firebase functions:secrets:get CLOUDFLARE_TURN_CONFIG --project codra-1b3bb
```

This prints the secret's version numbers and each version's state (for
example `ENABLED` or `DESTROYED`); it never prints the JSON payload
itself. Never run `firebase functions:secrets:access` as part of this
runbook or paste its output anywhere — that command prints the raw
`{ "keyId": ..., "bearerToken": ... }` value.

What happens if the secret is absent or stale:

- **Absent** (never bound at deploy time, or the bound version's value
  fails to parse) — `issueTurnCredentials` fails closed immediately with
  `TURN_CONFIG_UNAVAILABLE`, before it ever calls Cloudflare.
- **Stale** (the bound `keyId`/`bearerToken` have been rotated or revoked
  at Cloudflare) — the callable reaches Cloudflare, the request fails,
  and it fails closed with `TURN_GENERATION_AMBIGUOUS`.

In both cases **every** production session fails with one of the two error
codes above. Production is relay-only, so there is no direct path for a
session to fall back to and no class of session that survives a broken
secret. Treat a TURN outage as a total remote-access outage.

## Emulator gate

Every command must exit zero before any deploy. The `remote-*` suites run
two desktop devices against each other; `test:web-console` runs a real
browser against one.

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
pnpm test:web-console

pnpm verify:native-package
pnpm verify:remote-build-config
pnpm verify:firebase-indexes
pnpm scan:client-artifacts
```

Prerequisites: macOS, a JDK for the Firestore emulator, and
`pnpm install --frozen-lockfile`. In zsh, `${PIPESTATUS[0]}` is empty —
redirect a command's output to a file and read `$?`, or use
`$pipestatus[1]`.

`pnpm test:web-console` has two more prerequisites of its own:

- **Port 5000 must be free.** It is the only suite that starts the Hosting
  emulator, and on a stock macOS Control Center's AirPlay Receiver already
  listens on `*:5000`. Turn it off in System Settings → General → AirDrop &
  Handoff. `assertEmulatorPortsFree` in `tests/e2e/remote-harness.ts` checks
  the port and names the holder, so the failure is legible; without that
  check firebase-tools refuses the fixed port with a message about the port
  and nothing about what holds it.
- **A Playwright browser.** The suite drives Chromium rather than Electron:
  `pnpm exec playwright install chromium`.

The suite builds `apps/web/dist-remote-test` itself, with this run's
emulator account baked in — `account-bootstrap-test-only.ts` reads it from
`import.meta.env`, which Vite substitutes at build time — and serves it with
`firebase.emulator.json`, whose CSP is the emulator flavour of
`firebase.json`'s. If the console starts failing with requests blocked to
`127.0.0.1:9099`, `:8080`, or `:5001`, suspect drift between that header and
the `<meta http-equiv>` policy `apps/web/csp-plugin.ts` bakes into the HTML:
the two compose by intersection and a response must satisfy both.

## Rollout: deploy only the surfaces that changed

Never run bare `firebase deploy`. Determine what actually changed:

```bash
git diff --stat origin/main...HEAD -- \
  firestore.rules firestore.indexes.json functions packages/protocol apps/web
```

Functions and Hosting both bundle `@codra/protocol`, so a protocol change
requires redeploying both even when `functions/` and `apps/web/` are
untouched. Rules and indexes are deployed only when their own files
changed.

```bash
# Functions — required when functions/ or packages/protocol changed
pnpm --filter @codra/protocol build
pnpm --filter @codra/functions build
pnpm run stage:functions-deploy
pnpm --dir functions-deploy-build install --frozen-lockfile
firebase deploy --only functions --project codra-1b3bb
```

```bash
# Hosting — required when apps/web or packages/protocol changed
pnpm --filter @codra/web build
pnpm scan:client-artifacts
firebase deploy --only hosting --project codra-1b3bb
```

Hosting now serves three routes, not one: `/` is the public landing page,
`/console` is the browser console, and `/desktop-auth` is the login bridge.
`firebase.json` rewrites `/desktop-auth`, `/login`, and `**` to
`/index.html`, so the client-side router is what distinguishes them and a
deploy that drops a rewrite turns a reload on `/console` into a 404.
`scripts/verify-remote-build-config.mjs` deep-equals that rewrite array; run
it before the deploy, not after.

The same file also serves this header block on `**`:

```json
{
  "key": "Content-Security-Policy",
  "value": "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; font-src 'self' data:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://asia-northeast3-codra-1b3bb.cloudfunctions.net; frame-src https://codra-1b3bb.firebaseapp.com"
}
```

plus `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and
`X-Frame-Options: DENY`. `frame-ancestors` is ignored inside a `<meta>` tag,
which is why the policy is served as a real header as well as baked into the
HTML; the two must stay identical, because a response carrying both has to
satisfy both. Verify the deployed header rather than assuming it:

```bash
curl -sI https://codra-1b3bb.web.app/console | grep -i content-security-policy
```

```bash
# Only when firestore.rules changed
firebase deploy --only firestore:rules --project codra-1b3bb
```

```bash
# Only when firestore.indexes.json changed
firebase deploy --only firestore:indexes --project codra-1b3bb
```

`codra-1b3bb` is also the `live` alias in `.firebaserc`; pass the project
id explicitly anyway so a stale `firebase use` cannot redirect a deploy.

After a Functions deploy, the deployed function list must contain all
thirteen exported callables/requests in `asia-northeast3`:
`registerDevice`, `heartbeatDevice`, `createRemoteSession`,
`approveRemoteSession`, `rejectRemoteSession`, `listHostDevices`,
`publishSignal`, `getSessionPeerDevice`, `issueTurnCredentials`,
`authorizeDesktopLogin`, `desktopLoginStart`, `desktopLoginRedeem`, and
`desktopLoginCancel`.

## Post-deploy checks the emulator cannot cover

1. Google sign-in from a release desktop build completes and returns
   focus to CODRA. The emulator only ever exercises email/password.
2. The device appears with its `os.hostname()` display name, and a second
   Mac sees it as an online host.
3. TURN relay: `issueTurnCredentials` returns Cloudflare `iceServers` and a
   session actually connects through them. No emulator run can cover this —
   the emulator ICE path deliberately asks for an unrestricted policy and
   connects on loopback host candidates, while production is relay-only, so
   the relay is exercised only against the deployed project. Prior to this
   plan this callable had never successfully returned usable credentials
   against live Cloudflare — see "TURN and its history" above — so treat
   this check as load-bearing, not a formality.
4. `firebase functions:log --project codra-1b3bb --only registerDevice,createRemoteSession,issueTurnCredentials`
   shows no `TURN_GENERATION_AMBIGUOUS`, `TURN_CONFIG_UNAVAILABLE`,
   `ACCOUNT_PROVIDER_NOT_ALLOWED`, or `SESSION_NOT_CONNECTABLE` bursts.
5. App Check remains disabled by design (`deployment.ts` pins
   `authAppCheckEnforcement: false`); every callable is reachable by any
   client holding a valid account token.
6. **The auth relay iframe still frames.** The header block above applies
   `X-Frame-Options: DENY` and `frame-ancestors 'none'` at `source: "**"`,
   and Firebase's popup/redirect resolver loads
   `https://codra-1b3bb.firebaseapp.com/__/auth/iframe` — the same Hosting
   site, under the reserved `/__/` namespace. Firebase serves `/__/*` from a
   layer ahead of site config, which is also why the `**` rewrite does not
   swallow `/__/auth/handler`, so this is expected to work; it cannot be
   verified before deploy.

   ```bash
   curl -sI https://codra-1b3bb.firebaseapp.com/__/auth/iframe | grep -iE "x-frame-options|content-security-policy"
   ```

   Neither header may appear. If either does, scope the header block away
   from `/__/**` rather than dropping the protection from the pages that
   need it — those headers exist because `/desktop-auth` renders the button
   that approves a device login.

7. **Google sign-in completes from the deployed console**, end to end, in a
   real browser: open `https://codra-1b3bb.web.app/console`, sign in with
   Google, and confirm the host list loads. The emulator suite only ever
   exercises email/password, and `browserPopupRedirectResolver` is loaded
   from `https://apis.google.com` — a script source no emulator run needs.
8. **The deployed console completes a real session.** With a host Mac
   online, request a session from the deployed console, approve it on the
   host, pick a folder, launch an agent, and type into its terminal. This is
   the only check that exercises the relay-only production ICE path from a
   browser: `pnpm test:web-console` runs against the emulator, whose ICE
   path is deliberately not relay-only.

## Rollback

Hosting has release rollback in the Firebase console. Functions, rules,
and indexes have none: check out the previous commit and redeploy that
exact surface with the same `--only` flag. Rolling back rules while a
newer functions revision is live can strand sessions — roll back
functions first.

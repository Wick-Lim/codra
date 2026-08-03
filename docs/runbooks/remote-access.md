# Remote access runbook

Remote access lets one CODRA Mac launch and drive agents on another Mac
signed in to the same account. It is optional; local terminals and local
agents never touch it.

## What Firebase carries, and what it never carries

Firebase carries account sign-in, device registration, presence, session
request/approval records, and WebRTC signalling. Terminal bytes, agent
prompts, and workspace paths travel only over the direct peer connection
and are never written to Firestore.
`tests/e2e/remote-agent-workspace.spec.ts` enforces this by scanning every
document in the Firestore emulator for the prompt, the input token, and the
workspace path after a full agent session.

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

When another Mac requests a session, CODRA shows an in-app approval
modal — not a native dialog — naming the requesting device and listing
every requested scope, each independently deniable:

`workspace.read`, `agent.runtimes`, `agent.launch`, `terminal.write`,
`terminal.resize`, `terminal.detach`, `terminal.attach`.

`agent.launch` permits running an agent on this Mac. Denying every scope
is a rejection, not an empty approval. `terminal.attach` only ever applies
to terminals the same peer launched on this host; it never exposes local
terminals. If no window is open when a request arrives, CODRA opens one;
if the window cannot be created, the session is rejected rather than left
pending.

## TURN and its history

Cloudflare TURN credentials are minted by the `issueTurnCredentials`
callable (`functions/src/turn.ts`) only when a direct peer connection is
not possible. The desktop and browser clients never see the Cloudflare
bearer token — see `docs/runbooks/cloudflare-turn.md` for the secret's
JSON shape and provisioning rules.

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

In both cases, sessions where the two peers can reach each other directly
are unaffected and connect exactly as before — remote access does not
require TURN. Only sessions that require a relay because no direct path
exists fail, and they fail with one of the two error codes above.

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
`pnpm install --frozen-lockfile`. In zsh, `${PIPESTATUS[0]}` is empty —
redirect a command's output to a file and read `$?`, or use
`$pipestatus[1]`.

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
# Hosting (the login bridge) — required when apps/web or packages/protocol
# changed
pnpm --filter @codra/web build
firebase deploy --only hosting --project codra-1b3bb
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
3. TURN relay: `issueTurnCredentials` returns Cloudflare `iceServers`. The
   two-device harness runs on loopback host candidates and cannot
   exercise relay; force a relay path manually once after deploy. Prior
   to this plan this callable had never successfully returned usable
   credentials against live Cloudflare — see "TURN and its history"
   above — so treat this check as load-bearing, not a formality.
4. `firebase functions:log --project codra-1b3bb --only registerDevice,createRemoteSession,issueTurnCredentials`
   shows no `TURN_GENERATION_AMBIGUOUS`, `TURN_CONFIG_UNAVAILABLE`,
   `ACCOUNT_PROVIDER_NOT_ALLOWED`, or `SESSION_NOT_CONNECTABLE` bursts.
5. App Check remains disabled by design (`deployment.ts` pins
   `authAppCheckEnforcement: false`); every callable is reachable by any
   client holding a valid account token.

## Rollback

Hosting has release rollback in the Firebase console. Functions, rules,
and indexes have none: check out the previous commit and redeploy that
exact surface with the same `--only` flag. Rolling back rules while a
newer functions revision is live can strand sessions — roll back
functions first.

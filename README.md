# CODRA

CODRA is a macOS desktop terminal for running agents in parallel. It runs locally and stores terminal metadata and bounded scrollback on the Mac. Local terminals and local agents need no account. Remote access is an optional layer: sign in with a Google account and another CODRA Mac — or the browser console — can browse a host Mac's workspaces and launch agents there over an encrypted WebRTC data channel.

## Local development

CODRA requires Node.js 22 and pnpm 11.5.2.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the Electron desktop app. Create a pane with **New terminal**; the shell and its persisted scrollback stay on the local machine.

## Window and process lifecycle

On macOS, closing the CODRA window does not quit the app. Existing terminal processes keep running, and reopening CODRA restores the terminal list and scrollback. Choose **Quit CODRA** to stop the application: if terminals are still active, CODRA asks for confirmation before terminating them and exiting.

## Verification and macOS packaging

Run the regular checks on any supported development machine:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

The Electron E2E and packaging commands require macOS:

```bash
pnpm test:e2e
pnpm --filter @codra/desktop package:dir
pnpm test:packaged
```

`package:dir` removes any previous host output and smoke receipts, writes current-build provenance plus a one-use pending smoke receipt, and creates an unsigned, unpacked `CODRA.app` for the host architecture under `apps/desktop/dist/`. A successful packaged smoke consumes that pending receipt; rerunning the smoke without repackaging fails. CI archives only an app with a matching passed receipt, then extracts `CODRA-host.app.tar.gz` again and verifies that the app executable and PTY helper retain mode `0755`.

The release command below declares DMG and ZIP targets for both Apple Silicon and Intel Macs:

```bash
pnpm --filter @codra/desktop package:mac
```

Release signing and notarization credentials are intentionally not configured in the repository.

## Remote access

Remote access is optional and off until you sign in and enable it. A host
Mac accepts two kinds of client:

- **Another CODRA Mac.** It discovers the host in its own window, requests a
  session, and browses and launches there once the host approves.
- **The browser console**, served at `/console` on the Firebase Hosting site.
  It signs in with the same account, appears in the same approval modal, and
  drives the same host. It **launches its own agent and attaches to that
  terminal**; it never attaches to terminals the host was already running.
  That is a property of the host rather than a gap in the console:
  `terminal.attach` is granted only for terminals the same peer owns, and
  ownership comes from `agent.launch` or `terminal.create`.

When remote access is on, Firebase carries sign-in, device registration,
session approval, and WebRTC signalling only. Terminal bytes, agent prompts,
and workspace paths travel over the encrypted WebRTC data channel and are
never written to Firestore; two end-to-end tests scan every emulator
Firestore document — one after a desktop-to-desktop session, one after a
browser-console session — to keep that true.

That channel is not a direct path between the two peers. Production asks for
`iceTransportPolicy: "relay"` on every session, so every production session
is relayed through Cloudflare TURN and there is no direct path to fall back
to: if TURN is unavailable, remote access fails rather than connecting some
other way. The relay forwards DTLS-encrypted packets it cannot read, its
credentials are minted per session by a Firebase callable, and no client
ever sees the Cloudflare token. Everything in this layer except the live
relay is exercised end-to-end against the Firebase and Firestore emulators
on every change; TURN relay against live Cloudflare is checked manually
after each deploy.

Running CODRA locally needs no Firebase or Cloudflare configuration.

Operating and deploying the remote layer — sign-in, host activation, device
registration, session approval, provider configuration, and rollout — is
documented in `docs/runbooks/remote-access.md`.

The remote suites require macOS and a JDK for the Firestore emulator. The
last one drives a real browser against the Hosting emulator and needs port
5000 free, which on a stock macOS means turning AirPlay Receiver off in
System Settings → General → AirDrop & Handoff:

```bash
pnpm build:remote-test
pnpm test:remote-direct
pnpm test:remote-reconnect
pnpm test:remote-agent-workspace
pnpm test:web-console
```

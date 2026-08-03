# CODRA

CODRA is a macOS desktop terminal for running agents in parallel. It runs locally and stores terminal metadata and bounded scrollback on the Mac. Local terminals and local agents need no account. Remote access is an optional layer: sign in with a Google account and one CODRA Mac can browse another Mac's workspaces and launch agents there over a direct WebRTC connection.

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

Remote access is optional and off until you sign in and enable it. When it
is on, Firebase carries sign-in, device registration, session approval, and
WebRTC signalling only. Terminal bytes, agent prompts, and workspace paths
travel exclusively over the direct peer connection between the two Macs; an
end-to-end test scans every emulator Firestore document to keep that true.
Cloudflare TURN credentials are issued by a Firebase callable when a direct
connection is not possible, and the clients never see the Cloudflare token.
This whole layer is exercised end-to-end against the Firebase and Firestore
emulators on every change; TURN relay against live Cloudflare is checked
manually after each deploy rather than by the automated suite.

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

# CODRA

CODRA is a standalone macOS desktop terminal. It runs locally, stores terminal metadata and bounded scrollback on the Mac, and does not require an account or login.

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

`package:dir` creates an unsigned, unpacked `CODRA.app` for the host architecture under `apps/desktop/dist/`. The release command below declares DMG and ZIP targets for both Apple Silicon and Intel Macs:

```bash
pnpm --filter @codra/desktop package:mac
```

Release signing and notarization credentials are intentionally not configured in the repository.

## Scope

This phase is local and standalone. Firebase-backed coordination, WebRTC remote terminal transport, and Cloudflare/TURN remote-access infrastructure are deferred to a future phase; no Firebase or Cloudflare configuration is needed to run CODRA locally.

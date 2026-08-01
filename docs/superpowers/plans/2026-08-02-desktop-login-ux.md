# Desktop Login UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production Electron standalone expose an explicit Google remote-login action and status without requiring `CODRA_ENABLE_REMOTE`.

**Architecture:** Add a small validated remote IPC surface to the frozen desktop API. The Electron main process owns `RemoteHostController` state and invokes Firebase Identity Toolkit's direct Google authorization URI with an ephemeral loopback callback; preload forwards only validated state/actions; the renderer shows a sidebar remote-access panel. Local terminal startup remains independent, and remote-test keeps its compile-time emulator account adapter.

**Tech Stack:** Electron main/preload, React 19 renderer, TypeScript, Zod, Vitest.

## Global Constraints

- Production login uses `shell.openExternal` for the Firebase-generated Google authorization URI and returns directly to the ephemeral `127.0.0.1` callback; the hosted `/desktop-auth` bridge is not part of the Electron flow.
- `CODRA_ENABLE_REMOTE` is not required for production standalone login.
- Device custom tokens and Firebase Auth state remain in Electron main memory.
- Remote login failures must not prevent local terminal creation or input.
- Every code change gets a RED/GREEN test cycle and `git diff --check`.

---

### Task 1: Freeze remote desktop IPC contracts

**Files:**

- Modify: `packages/protocol/src/desktop-api.ts`
- Modify: `packages/protocol/test/desktop-api.test.ts` (or create if absent)

**Interfaces:**

- Add `RemoteHostStateSchema` and `RemoteHostState` values `idle | signing_in | online | error`.
- Add `RemoteHostStatusSchema` with `{ state, message? }`.
- Add IPC channels `remoteGetState`, `remoteLogin`, `remoteState`.
- Extend `CodraDesktopApi.remote` with `getState()`, `login()`, and `onStateChanged(listener)`.

- [ ] Write failing contract tests.
- [ ] Run focused protocol test and observe the missing contract failure.
- [ ] Implement strict schemas/channels/types.
- [ ] Run focused protocol test and `pnpm --filter @codra/protocol typecheck`.
- [ ] Commit `feat: add desktop remote login IPC contract`.

### Task 2: Wire main controller state and IPC

**Files:**

- Modify: `apps/desktop/src/main/remote/host-controller.ts`
- Create: `apps/desktop/src/main/ipc/remote-ipc.ts`
- Create: `apps/desktop/src/main/ipc/remote-ipc.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**

- `RemoteHostController.login(): Promise<void>` starts the direct production Google flow regardless of env.
- `RemoteHostController.getStatus(): RemoteHostStatus` and `onStatusChanged(listener)` expose bounded state.
- `registerRemoteIpc` handles `remoteGetState` and `remoteLogin`, authorizes the trusted renderer, and sends `remoteState` events.

- [ ] Write failing controller/IPC tests for env-independent login, state transitions, and error recovery.
- [ ] Run focused desktop tests and observe failures.
- [ ] Remove the production env gate from the explicit login path; retain remote-test alias behavior.
- [ ] Implement validated IPC registration and status broadcasts.
- [ ] Run focused tests and desktop typecheck.
- [ ] Commit `feat: expose desktop remote login action`.

### Task 3: Expose preload and renderer login panel

**Files:**

- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx`

**Interfaces:**

- Preload validates remote responses/events with protocol schemas.
- Sidebar receives remote status and renders Google login/retry, signing-in, online, and error states.
- Login click invokes `window.codra.remote.login()`; no Firebase code enters renderer.

- [ ] Add failing renderer tests for visible login button and status updates.
- [ ] Run focused renderer tests and observe failures.
- [ ] Implement preload forwarding and minimal accessible panel.
- [ ] Run focused renderer tests, typecheck, production and remote-test builds.
- [ ] Commit `feat: add Electron remote login panel`.

### Task 4: Integration verification and push

- [ ] Run `pnpm test`, `pnpm typecheck`, both desktop builds, `git diff --check`.
- [ ] Run a packaged/dev smoke check proving the renderer shows the login panel without `CODRA_ENABLE_REMOTE`.
- [ ] Commit any final verification-only changes and push `main`.

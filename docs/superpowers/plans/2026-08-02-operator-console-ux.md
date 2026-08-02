# CODRA Operator Console UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Electron desktop feel like a focused CLI and multi-agent operator console while moving authentication and remote-host control into polished supporting surfaces.

**Architecture:** Extend the validated Electron IPC account contract with a bounded Firebase profile and logout operation. Split renderer responsibilities into modal, account, sign-in, and settings components; leave `App` as the state coordinator and keep `TerminalSidebar` focused on sessions.

**Tech Stack:** Electron, React 19, TypeScript, Firebase Auth, Zod, xterm.js, Vitest, Testing Library, CSS.

## Global Constraints

- CLI and session management remain the dominant workspace.
- Local terminals remain fully usable while signed out or when remote access fails.
- Production sign-in offers Google only; email/password remains visibly test-only and disabled.
- Remote access is controlled in Settings with an explicit switch and never starts automatically.
- Account UI never displays the authentication provider.
- No new runtime or UI dependency is added.

---

### Task 1: Add account profile and logout contracts

**Files:**
- Modify: `packages/protocol/src/desktop-api.ts`
- Modify: `packages/protocol/test/desktop-api.test.ts`
- Modify: `apps/desktop/src/main/remote/remote-state.ts`
- Modify: `apps/desktop/src/main/remote/remote-state.test.ts`
- Modify: `apps/desktop/src/main/remote/host-controller.ts`
- Modify: `apps/desktop/src/main/ipc/remote-ipc.ts`
- Modify: `apps/desktop/src/main/ipc/remote-ipc.test.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/desktop-api.test.ts`

**Interfaces:**
- Produce `RemoteAccountProfileSchema` with `displayName`, `email`, and `photoUrl` nullable strings.
- Require `profile` on the `signed_in` account status variant.
- Produce `remote.logout(): Promise<RemoteAccountStatus>` and IPC channel `codra:remote:logout`.
- Produce `remoteSignedInStatus(user)` to convert Firebase user fields into the bounded renderer contract.

- [ ] **Step 1: Write failing protocol, status-conversion, IPC, and preload tests** that reject signed-in state without a profile, preserve nullable profile fields, and observe logout returning `signed_out`.
- [ ] **Step 2: Run focused tests** with `pnpm --filter @codra/protocol test -- --run test/desktop-api.test.ts` and `pnpm --filter @codra/desktop test -- --run src/main/remote/remote-state.test.ts src/main/ipc/remote-ipc.test.ts src/preload/desktop-api.test.ts`; confirm failures are missing contracts.
- [ ] **Step 3: Implement the schemas, profile conversion, logout controller lifecycle, IPC handler, and preload wrapper.** `logout()` calls host cleanup before account `signOut` and publishes `signed_out`.
- [ ] **Step 4: Re-run focused tests** and confirm all pass.

### Task 2: Build real modal, account, sign-in, and settings surfaces

**Files:**
- Create: `apps/desktop/src/renderer/src/components/ModalDialog.tsx`
- Create: `apps/desktop/src/renderer/src/account/AccountControl.tsx`
- Create: `apps/desktop/src/renderer/src/account/SignInDialog.tsx`
- Create: `apps/desktop/src/renderer/src/settings/SettingsDialog.tsx`
- Create: `apps/desktop/src/renderer/src/account/AccountControl.test.tsx`
- Create: `apps/desktop/src/renderer/src/settings/SettingsDialog.test.tsx`
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`

**Interfaces:**
- `ModalDialog({ open, title, description?, onClose, children })` renders through `document.body`, uses native `showModal()` when available, closes on Escape/backdrop, and restores focus.
- `AccountControl` renders profile or sign-in state and emits `onSignIn`, `onOpenSettings`, and `onLogout`.
- `SignInDialog` emits a selected `RemoteAuthProvider` and disables duplicate selection while signing in.
- `SettingsDialog` emits `onRemoteChange(enabled)` and `onSignIn`; the switch is checked only for `online`.

- [ ] **Step 1: Write failing renderer tests** for a centered sign-in dialog, real profile name/email/avatar fallback, account menu actions, Settings remote switch, busy state, signed-out guidance, and removal of the sidebar remote card.
- [ ] **Step 2: Run focused renderer tests** and confirm failures come from missing components and old sidebar behavior.
- [ ] **Step 3: Implement the components and App coordination** with no terminal behavior changes.
- [ ] **Step 4: Re-run focused renderer tests** and confirm all pass.

### Task 3: Apply the Operator Console visual system

**Files:**
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalPane.tsx`
- Modify: `apps/desktop/src/renderer/index.html`

**Interfaces:**
- Replace generic graphite/cyan tokens with the approved instrument-deck palette.
- Replace numeric pane markers with the semantic session signal rail.
- Permit profile images only from `https://*.googleusercontent.com` in renderer CSP.
- Keep the current responsive minimum and reduced-motion behavior.

- [ ] **Step 1: Add behavior assertions** for semantic session state and avatar fallback; avoid brittle exact-style tests.
- [ ] **Step 2: Apply the token system, layout, modal, menu, switch, rail, focus, and xterm theme styles.** Use `Signal` only for selection/focus and `Live` only for running/online state.
- [ ] **Step 3: Run desktop tests, typecheck, and production build.**
- [ ] **Step 4: Inspect the rendered app at desktop and minimum widths** and correct overflow, focus, and contrast issues.
- [ ] **Step 5: Run `git diff --check`, `pnpm test`, `pnpm typecheck`, and `pnpm --filter @codra/desktop build` before committing and pushing `main`.


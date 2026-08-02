# CODRA Operator Console UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Electron desktop feel like a focused CLI and multi-agent operator console while moving authentication and remote-host control into polished supporting surfaces.

**Architecture:** Extend the validated Electron IPC account contract with a bounded Firebase profile and logout operation. Split renderer responsibilities into modal, account, sign-in, settings, and a two-pane New Agent launcher; leave `App` as the state coordinator and keep `TerminalSidebar` focused on sessions. The main-process runtime registry owns CLI capability metadata, local model discovery, and provider/model effort mappings instead of letting the renderer infer command syntax.

**Tech Stack:** Electron, React 19, TypeScript, Firebase Auth, Zod, xterm.js, Vitest, Testing Library, CSS.

## Global Constraints

- CLI and session management remain the dominant workspace.
- Local terminals remain fully usable while signed out or when remote access fails.
- Production sign-in offers Google only; email/password remains visibly test-only and disabled.
- Remote access is controlled in Settings with an explicit switch and never starts automatically.
- Account UI never displays the authentication provider.
- No new runtime or UI dependency is added.
- New Agent uses a searchable vertical runtime catalogue with a right-hand detail/configuration pane, never a fixed provider-card grid.
- Initial runtimes are Codex, Claude, Gemini, and Ollama. Runtime availability, model discovery, YOLO support, and provider/model effort support are capabilities returned from the main process. Gemini Effort remains hidden until an official CLI mapping exists.

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

### Task 4: Return OAuth through an isolated child window

**Files:**

- Create: `apps/desktop/src/main/remote/auth-window.ts`
- Create: `apps/desktop/src/main/remote/auth-window.test.ts`
- Create: `apps/desktop/src/main/remote/account-bootstrap-google.test.ts`
- Modify: `apps/desktop/src/main/remote/account-bootstrap-google.ts`
- Modify: `apps/desktop/src/main/remote/desktop-login.ts`

- [ ] **Step 1: Write failing tests** for modal ownership, browser-chrome removal, navigation confinement, callback close, early cancellation, deadline abort, and parent focus restoration.
- [ ] **Step 2: Implement the isolated BrowserWindow launcher** and pass the exact callback URL and abort signal through the Google bootstrap boundary.
- [ ] **Step 3: Load the production Firebase auth URI in Electron 43** and confirm it reaches the Google account identifier screen rather than `disallowed_useragent`.
- [ ] **Step 4: Re-run main-process tests and typecheck.**

### Task 5: Launch installed CLI agents from the session rail

**Files:**

- Modify: `packages/protocol/src/terminal.ts`
- Modify: `packages/protocol/src/desktop-api.ts`
- Create: `apps/desktop/src/main/terminal/agent-runtime.ts`
- Create: `apps/desktop/src/renderer/src/agent/NewAgentDialog.tsx`
- Modify: terminal IPC, preload, PTY factory, manager, terminal hook, sidebar, App, styles, and their focused tests.

- [ ] **Step 1: Write failing protocol and runtime tests** for bounded runtime/model/effort/prompt input; installed-CLI discovery for Codex, Claude, Gemini, and Ollama; runtime-specific YOLO capabilities and flags; provider/model effort capabilities; fixed Codex `-c model_reasoning_effort=<level>`, Claude `--effort <level>`, and Ollama `--think <level>` mappings; hidden Gemini Effort with no official mapping; argument separation; missing binaries; terminal titles; and Ollama local-model discovery, unavailable-service, and malformed-response handling.
- [ ] **Step 2: Implement the typed runtime registry and direct PTY launch path** for Codex CLI, Claude Code, Gemini CLI, and Ollama without shell interpolation. Expose per-runtime capabilities: executable availability, `Default` model behavior, discovered/recommended models, custom-model support, model-specific effort levels, and whether YOLO is supported. Derive Codex effort levels from its model catalogue; map effort only via the fixed Codex, Claude, and Ollama arguments, and expose no Gemini effort capability until an official CLI mapping exists. Run bounded Codex catalogue and `ollama list` discovery only from the main process; failure returns an empty discovered catalogue rather than failing the launcher.
- [ ] **Step 3: Extend protocol, IPC, and preload contracts** for runtime catalogue/search metadata, model discovery, and effort capability. Represent model choice as a discriminated `default` / `discovered` / `custom` selection, represent effort as an optional catalogue-bounded value, validate both before launch, and keep executable names and flags entirely main-process owned.
- [ ] **Step 4: Write failing renderer tests** for split terminal/New Agent actions; vertical catalogue keyboard search; Codex, Claude, Gemini, and Ollama availability states; selected-runtime detail rendering; Default/discovered/recommended/Custom model selection; Ollama loading/unavailable states; Codex model-specific Effort levels; fixed Claude and Ollama Effort controls; hidden Gemini Effort; per-runtime YOLO visibility and warning; required first prompt; and successful session selection.
- [ ] **Step 5: Implement and style the two-pane New Agent modal** within the Operator Console system. Keep the left catalogue scrollable and searchable, keep launch controls in the right detail pane, and prevent duplicate discovery/launch requests while busy.
- [ ] **Step 6: Run the full workspace verification and inspect the dialog** at desktop and compact window sizes, including a no-Ollama local environment and a runtime without YOLO support.
- [ ] **Step 7: Verify session-tree close semantics** so an explicit successful close removes the item, selects the next running terminal, ignores late exit events for the dismissed ID, and omits stale exited descriptors on initial load.

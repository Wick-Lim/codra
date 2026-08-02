# CODRA Operator Console UX Design

**Date:** 2026-08-02  
**Status:** Approved for implementation  
**Product thesis:** CODRA is a focused environment for running CLI tools and controlling multiple agent sessions. Authentication and remote access are supporting controls, not the workspace.

## Experience hierarchy

1. The active CLI occupies the largest uninterrupted surface.
2. The left rail is a session registry that can grow from terminals into agent sessions without showing fake agent features today.
3. Runtime facts such as shell state, dimensions, and remote-host state live in the compact status strip.
4. Account, authentication, and remote access live behind the bottom account control and Settings.

The current `Remote access` sidebar card is removed. It consumes prime workspace area and makes a secondary feature look like the product's main purpose.

## Operator Console direction

CODRA uses an instrument-deck visual language: dark blue-black surfaces, quiet steel dividers, a periwinkle selection signal, jade only for genuinely live state, and amber only for attention. The interface avoids the common black-and-acid-cyan developer-tool treatment.

- Obsidian `#0b0e14`: terminal field
- Deck `#111722`: primary chrome
- Bulkhead `#1a2230`: raised controls and selected rows
- Steel `#303b4b`: borders and rails
- Fog `#e3e8ef`: primary text, with desaturated secondary text derived from it
- Signal `#91a7ff`: focus and current selection
- Live `#62c7a5`: online/running state
- Warning `#d8a25e`: actionable failure state

Typography uses `Avenir Next` for interface copy, a condensed system face for the CODRA mark, and `SFMono` for paths, state, and terminal data. No remote font dependency is added.

The signature element is the **session signal rail**: each session row is connected to a restrained vertical track and uses a semantic node for running/exited/current state. Meaningless `01 / 02` numbering is removed because list order is not a workflow sequence.

## Account and authentication

Signed out, the bottom account control reads `Sign in` with a short explanation that local CLI work remains available. Activating it opens a centered modal with a backdrop, keyboard dismissal, focus restoration, and a Google provider action. Email/password stays visibly test-only and disabled in production.

Signed in, the control displays the Firebase profile photo when it is a permitted Google-hosted image, otherwise initials, plus the user's display name and email. Activating it opens a compact account menu containing only:

- `Settings`
- `Sign out`

The already-used provider is not displayed. Signing out first disables the remote host, then clears account authentication.

Google authentication opens in a modal Electron child window owned by the CODRA main window, without browser chrome. The child has no preload, Node integration, popup capability, or navigation outside `accounts.google.com` and the exact one-shot loopback callback. Reaching the validated callback closes the child and restores, shows, and focuses the parent window; closing it early cancels the attempt. This flow currently renders the live Google sign-in page in Electron 43, but remains a compatibility risk because Google's published OAuth policy may reject embedded user-agents in the future.

## Agent launch

The sidebar's primary creation control is split into a wide `New agent` action and a compact terminal-icon action. The terminal icon keeps the existing plain login-shell behavior. `New agent` opens a two-pane modal rather than a grid of fixed provider cards. The left pane is a searchable, vertically scrolling runtime catalogue. It has a plain-language empty state and shows local availability for `Codex`, `Claude`, `Gemini`, and `Ollama`; filtering must work by runtime and provider name. The current selection is visible on the rail, but the rail does not carry launch settings.

The right pane is the selected runtime's detail and launch configuration:

- A provider-specific **Model** choice with `Default`, discovered/recommended models, and a `Custom` entry. `Default` is the initial selection. Discovered entries are only displayed when the runtime can report them; a custom value is bounded and validated as an argument value, never executable text. Model catalogue entries may carry supported reasoning/effort levels.
- An **Effort** choice appears only when the selected provider/model has a supported, officially mapped effort capability. For Codex, the model catalogue's supported reasoning levels are the available choices and the selected value maps to `-c model_reasoning_effort=<level>`. Claude maps its supported selection to `--effort <level>` and Ollama maps it to `--think <level>`. Gemini's official CLI has no approved effort mapping at this time, so Effort is hidden for Gemini rather than guessed or emitted as an unsupported argument.
- Ollama discovers locally installed models with a bounded `ollama list` subprocess on demand. Its detail pane exposes those models as discovered choices; discovery failure leaves Custom model available without blocking the other runtimes.
- An explicit `YOLO mode` switch, off by default, appears only where the selected runtime supports an unrestricted-action flag. A runtime that does not support it presents clear unavailable copy instead of a misleading disabled universal switch. Enabling a supported switch shows the unrestricted-action warning.
- A required, bounded first prompt.

The renderer sends a typed runtime, model-selection mode/value, optional supported effort choice, supported permission choice, and prompt; it never constructs shell text. The main process resolves a known executable, validates runtime-specific model and effort values, maps effort only to its fixed provider/runtime argument, and maps YOLO only for runtimes with a fixed supported flag. The prompt is passed after an argument separator so prompt text cannot become a CLI option. A successful launch creates and selects a normal terminal session titled with the chosen runtime, keeping agent sessions compatible with the existing terminal registry.

## Settings and remote access

Settings opens as a modal workspace above the terminal. The first implemented section is `Remote access`; empty future categories are not shown. It contains:

- A switch whose checked state is the actual host `online` state.
- A busy state while activation is in progress.
- Clear signed-out guidance and a sign-in action.
- Plain-language online, offline, and actionable error copy.

The main workspace keeps only a small remote-state control in the bottom status strip. Selecting it opens Settings. No `CODRA_ENABLE_REMOTE` environment flag is introduced.

## Component boundaries

- `RemoteAccountStatus` carries a bounded public profile only while signed in.
- `RemoteHostController.logout()` owns deactivate-then-sign-out ordering.
- `ModalDialog` owns portal rendering, native modal behavior, backdrop dismissal, Escape handling, and focus restoration.
- `SignInDialog` owns provider selection.
- `AccountControl` owns signed-in/signed-out presentation and the account menu.
- `SettingsDialog` owns remote toggle presentation and user-facing state copy.
- `TerminalSidebar` owns the CLI session registry and delegates account presentation.
- `NewAgentDialog` owns catalogue filtering, selection, provider model and effort choices, YOLO disclosure, and first-prompt validation.
- `agent-runtime` owns installed-CLI discovery, Ollama local-model discovery, model/effort and runtime capability metadata, and the fixed executable/argument mapping.
- `auth-window` owns the isolated provider child and parent-window restoration.
- `App` coordinates IPC state and which modal is open.

## Quality contract

- Explicitly closing a terminal removes it from the session tree after the close IPC succeeds, selects the next running session, and ignores a late exit event for the dismissed terminal. Stale exited descriptors are omitted from the initial tree after an app restart while their persisted replay data remains main-process owned.
- Dialogs are keyboard operable and expose accessible names.
- Account profile images have a fallback and a narrow CSP allowlist.
- Busy controls cannot submit duplicate activation or login actions.
- The layout remains usable at the existing 760px minimum window width.
- Reduced-motion preferences remain respected.
- Plain terminal creation and agent creation remain distinct keyboard-operable actions.
- Agent prompts and custom model values are never interpolated into a shell command string.
- The catalogue remains keyboard searchable and usable at the existing 760px minimum window width; its detail pane does not require a fixed provider-card layout.
- YOLO availability is determined by runtime capability, not a UI-wide assumption.
- Effort availability is determined by the selected provider/model capability. Unsupported mappings, including Gemini's current CLI, are hidden and never synthesized.

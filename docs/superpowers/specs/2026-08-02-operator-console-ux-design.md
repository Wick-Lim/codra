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
- `App` coordinates IPC state and which modal is open.

## Quality contract

- Local terminal creation, selection, input, resize, replay, and close behavior remain unchanged.
- Dialogs are keyboard operable and expose accessible names.
- Account profile images have a fallback and a narrow CSP allowlist.
- Busy controls cannot submit duplicate activation or login actions.
- The layout remains usable at the existing 760px minimum window width.
- Reduced-motion preferences remain respected.


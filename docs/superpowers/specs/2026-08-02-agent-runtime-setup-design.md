# CODRA Agent Runtime Setup Design

**Date:** 2026-08-02

**Status:** Approved for implementation

**Product thesis:** Installing and authenticating a CLI is supporting toolchain setup. Writing the first prompt and starting an agent remain the primary New Agent workflow.

## Experience hierarchy

`New agent` assumes the machine is ready. Its first focus and largest editable surface are the first prompt. Runtime, model, effort, and permission choices remain compact launch configuration. Installation and account setup do not expand inside this dialog.

Agent prerequisites live in `Settings → Agent runtimes`. The section shows Codex, Claude, Gemini, and Ollama as a quiet toolchain rack with three facts per runtime: availability, authentication requirement, and the next setup action. A missing npm runtime offers `Install & sign in`; an installed authenticated runtime still offers `Sign in / switch account`; Ollama is explicitly identified as a local runtime that needs no provider authentication.

If a missing runtime is selected in New Agent, the detail pane shows one short message and `Open Agent settings`. It does not embed install progress, authentication controls, package-manager output, or troubleshooting. Ready runtimes keep the prompt visually dominant.

## Visual direction

The existing Operator Console instrument-deck system remains unchanged:

- Obsidian `#0b0e14`
- Deck `#111722`
- Bulkhead `#1a2230`
- Steel `#303b4b`
- Fog `#e3e8ef`
- Signal `#91a7ff`
- Live `#62c7a5`
- Warning `#d8a25e`

The Agent runtimes section reuses the semantic session node as a toolchain status signal rather than adding colorful provider cards. Provider marks, runtime names, status copy, and one contextual action form a dense vertical list. Installation output deliberately moves into a normal terminal session, so long-running progress, errors, browser URLs, and retry instructions use the product's strongest surface instead of a modal progress bar.

In New Agent, the first-prompt field moves above detailed model and effort controls and receives focus when the dialog opens. The visual signature remains the session signal rail; setup adds no competing decorative motif.

## Managed npm installation

Electron supplies the Node runtime but not the npm CLI. CODRA therefore packages npm as a desktop runtime dependency and runs its CLI with the packaged Electron executable in Node mode (`ELECTRON_RUN_AS_NODE=1`). It does not depend on a system `node`, `npm`, Homebrew, or `sudo` for npm-based agents.

CODRA installs npm agents into `<userData>/agent-tools` with fixed package mappings owned by the main process:

- Codex: `@openai/codex`
- Claude: `@anthropic-ai/claude-code`
- Gemini: `@google/gemini-cli`

The renderer sends only an `AgentKind` and a fixed setup action. It never sends a package name, executable, URL, argument list, install directory, or shell text. npm runs with audit and funding prompts disabled, optional dependencies enabled, and no global installation. The shared managed prefix persists across CODRA application updates.

Existing user-installed CLIs remain supported. Discovery checks the inherited executable path, the CODRA-managed bin directory, and the existing bounded common locations. A managed JavaScript CLI is launched through Electron's Node mode so its `#!/usr/bin/env node` shebang does not create a hidden system-Node dependency. A managed native executable, including Claude's platform package, is launched directly.

## Authentication setup

`Install & sign in` is a sequential PTY workflow. The setup terminal first runs the fixed npm install. Only exit code `0` advances to authentication in the same terminal:

- Codex: `codex login`
- Claude: `claude auth login`
- Gemini: `gemini`, which owns its first-run authentication selector and browser flow
- Ollama: no authentication step

For an already installed npm agent, `Sign in / switch account` starts only the provider authentication command in a setup terminal. CODRA does not collect provider credentials, inject API keys, parse OAuth callbacks, copy credential files, or persist tokens. Each CLI owns its browser flow and its established credential storage under the user's normal home directory.

The setup terminal is an ordinary CODRA session titled `Setup <runtime>`. It supports input, resize, scrollback, explicit close, and visible exit status. Closing it terminates the active installer or authentication subprocess. A failed install never starts authentication.

## Ollama setup

Ollama is a native macOS application and local model service rather than an npm CLI. `Get Ollama` opens the official macOS download page from the main process using a fixed HTTPS URL. CODRA does not pipe a downloaded shell script into a shell or silently modify `/Applications` and `/usr/local/bin`.

After Ollama is installed, reopening Agent runtimes or New Agent triggers normal executable and local-model discovery. The runtime reports that no cloud sign-in is required.

## Main-process boundaries

- `agent-runtime` owns runtime discovery, fixed npm package mappings, managed executable resolution, authentication commands, and setup-command construction.
- A focused setup runner owns sequential install-then-auth process execution and forwards stdio and exit codes without interpreting credentials.
- `NodePtyFactory` launches either a shell, an agent, or a setup runner from a validated terminal request. These variants are mutually exclusive.
- Terminal IPC owns `agents.list` and `agents.setup`. The setup handler validates the runtime/action, creates a setup terminal for fixed local operations, or opens the fixed Ollama download URL.
- The preload validates setup requests and discriminated setup results before exposing them to React.
- `SettingsDialog` coordinates sections; a focused `AgentRuntimeSettings` component owns runtime setup presentation.
- `NewAgentDialog` owns launch intent only and can route an unavailable runtime to Agent settings.

## State and refresh behavior

Runtime discovery runs when the app starts, when New Agent opens, when Agent settings opens, and after a setup terminal exits. A setup terminal returned from IPC is inserted and selected through the same terminal-state hook used by normal sessions.

The UI does not claim authentication success merely because an installer exited. Codex and Claude may expose bounded status checks, but Gemini has no separate non-interactive status contract in the selected integration. Consequently the stable UI language is action-oriented (`Sign in / switch account`) rather than a universal authenticated badge. Availability is always based on executable discovery.

## Error handling

- Missing or damaged bundled npm produces `AGENT_INSTALLER_UNAVAILABLE` before a terminal is created.
- Unsupported runtime/action pairs produce `AGENT_SETUP_UNSUPPORTED`.
- npm failure leaves its exact output and nonzero exit status in the setup terminal and skips authentication.
- Missing managed bin output after a successful npm command produces a visible runner error and nonzero exit.
- Authentication cancellation or failure remains visible as the provider CLI's own output and exit status.
- External Ollama setup accepts only the fixed official URL and reports an IPC error if Electron cannot open it.
- Duplicate clicks are disabled while the setup request is being created; parallel setup sessions for the same runtime are rejected by the main process.

## Quality contract

- New Agent remains prompt-first and does not become an installer wizard.
- Runtime setup is keyboard operable at the existing 760px minimum width.
- No provider credential crosses the renderer IPC boundary.
- No user-controlled string becomes an executable, package, URL, install path, or shell command.
- npm installation does not require system Node/npm, global writes, or administrator access.
- A failed installer cannot fall through into authentication.
- Setup terminals participate in the existing close/removal and persisted-scrollback behavior.
- Existing system-installed runtimes keep working unchanged.
- Unit tests cover command allowlists, managed executable selection, sequential exit behavior, IPC validation, preload parsing, Settings actions, prompt-first layout, and unavailable-runtime routing.
- Full lint, format, typecheck, unit/integration tests, Electron development E2E, production build, remote-test build, and packaged smoke verification pass before pushing `main`.

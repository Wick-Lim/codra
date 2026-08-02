# CODRA Agent Runtime Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let CODRA install missing npm-based agent CLIs and continue into their official authentication flow while keeping New Agent focused on the first prompt.

**Architecture:** The main process owns a fixed runtime-to-package/authentication allowlist. A packaged npm CLI runs under Electron's Node mode into a CODRA-managed prefix, and a separate bundled setup-runner entry performs install-then-auth sequentially inside a normal PTY. Setup presentation lives in Settings; New Agent only routes unavailable runtimes there and keeps prompt entry visually primary.

**Tech Stack:** Electron 43, Electron Node mode, npm CLI, node-pty, React 19, TypeScript, Zod, Vitest, Testing Library, electron-vite.

## Global Constraints

- New Agent remains prompt-first and does not contain installer or authentication workflows.
- Codex, Claude, and Gemini install under `<userData>/agent-tools`; installation never uses `-g`, `sudo`, or a system Node/npm prerequisite.
- Fixed packages are `@openai/codex`, `@anthropic-ai/claude-code`, and `@google/gemini-cli`.
- Fixed authentication commands are `codex login`, `claude auth login`, and first-run `gemini`.
- Ollama has no authentication action and opens only `https://ollama.com/download/mac` for installation.
- The renderer can send only a validated runtime kind and `install` or `authenticate` action.
- Credentials and provider OAuth callbacks never cross renderer IPC or CODRA storage.
- Failed installation never starts authentication.
- Existing user-installed CLIs continue to work.
- Every production behavior is implemented test-first after observing the intended failure.

---

### Task 1: Define runtime setup contracts and fixed command plans

**Files:**

- Modify: `packages/protocol/src/terminal.ts`
- Modify: `packages/protocol/src/desktop-api.ts`
- Modify: `packages/protocol/test/terminal.test.ts`
- Modify: `packages/protocol/test/desktop-api.test.ts`
- Modify: `apps/desktop/src/main/terminal/agent-runtime.ts`
- Modify: `apps/desktop/src/main/terminal/agent-runtime.test.ts`

**Interfaces:**

- Produce `AgentSetupActionSchema = z.enum(["install", "authenticate"])`.
- Produce `AgentSetupRequestSchema` with `{ kind: AgentKind; action: AgentSetupAction }` and reject `ollama/authenticate`.
- Add mutually exclusive `agent` and `agentSetup` variants to `CreateTerminalRequestSchema`.
- Add `setup: { installMethod: "managed_npm" | "external"; authentication: "required" | "not_required" }` to every `AgentRuntime`.
- Extend `AgentCommand` with optional `env` and produce `resolveAgentSetupCommand(request, dependencies)`.
- Add managed executable fields to `AgentRuntimeDependencies`: `managedBinDirectory`, `electronExecutable`, `npmCliPath`, `setupRunnerPath`, `isNodeScript(path)`, and a command-aware `runCommand(command)`.

- [ ] **Step 1: Write failing protocol tests**

  Add literal assertions that accept:

  ```ts
  AgentSetupRequestSchema.parse({ kind: "codex", action: "install" });
  AgentSetupRequestSchema.parse({ kind: "gemini", action: "authenticate" });
  ```

  Reject `{ kind: "ollama", action: "authenticate" }`, a renderer-supplied package field, and a terminal request containing both `agent` and `agentSetup`. Assert the runtime schema requires setup metadata.

- [ ] **Step 2: Run protocol tests and verify RED**

  Run `pnpm --filter @codra/protocol test -- --run test/terminal.test.ts test/desktop-api.test.ts`.

  Expected: imports or schema parses fail because setup contracts do not exist.

- [ ] **Step 3: Implement the minimal schemas and exported types**

  Add the setup request/action schemas, the mutual-exclusion refinement, runtime setup metadata, `AgentSetupResultSchema`, and `agents.setup(request)` to `CodraDesktopApi`.

- [ ] **Step 4: Run protocol tests and verify GREEN**

  Re-run the command from Step 2 and confirm both files pass.

- [ ] **Step 5: Write failing runtime command tests**

  Extend the dependency fake with managed paths and assert these hand-derived plans:

  ```ts
  expect(
    resolveAgentSetupCommand({ kind: "codex", action: "install" }, deps),
  ).toMatchObject({
    executable: "/Applications/CODRA.app/Contents/MacOS/CODRA",
    args: [
      "/app/agent-setup-runner.js",
      "codex",
      "/data/agent-tools",
      "/app/npm-cli.js",
    ],
    env: { ELECTRON_RUN_AS_NODE: "1", CODRA_AGENT_SETUP_RUNNER: "1" },
    title: "Setup Codex",
  });
  ```

  Assert fixed auth argv for Codex and Claude, bare Gemini launch, rejected Ollama authentication, fixed Ollama external install metadata, and Electron Node-mode invocation for a managed JavaScript CLI.

- [ ] **Step 6: Run runtime tests and verify RED**

  Run `pnpm --filter @codra/desktop test -- --run src/main/terminal/agent-runtime.test.ts`.

  Expected: setup resolver and managed executable support are absent.

- [ ] **Step 7: Implement fixed setup profiles and managed invocation**

  Keep package names, auth argv, titles, and install mode in main-process profiles. Build agent/model discovery through the same command-aware managed invocation so a managed JavaScript executable is run with Electron Node mode while a managed native file is executed directly.

- [ ] **Step 8: Run runtime tests and verify GREEN**

  Re-run Step 6 and confirm all existing provider/model/effort tests remain green.

- [ ] **Step 9: Commit Task 1**

  ```bash
  git add packages/protocol apps/desktop/src/main/terminal/agent-runtime.ts apps/desktop/src/main/terminal/agent-runtime.test.ts
  git commit -m "feat: define agent setup contracts"
  ```

### Task 2: Bundle npm and execute install-then-auth in one PTY

**Files:**

- Create: `apps/desktop/src/main/terminal/agent-setup-runner.ts`
- Create: `apps/desktop/src/main/terminal/agent-setup-runner.test.ts`
- Modify: `apps/desktop/electron.vite.config.ts`
- Modify: `apps/desktop/electron.remote-test.vite.config.ts`
- Modify: `apps/desktop/src/main/terminal/node-pty.ts`
- Modify: `apps/desktop/src/main/terminal/node-pty.test.ts`
- Modify: `apps/desktop/src/main/terminal/manager.ts`
- Modify: `apps/desktop/src/main/terminal/manager.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produce `runAgentSetup(args, dependencies): Promise<number>` in the runner.
- Runner dependencies provide `run(command): Promise<number>`, `isNodeScript(path)`, and `realpath(path)` so sequencing is tested without network or real credentials.
- Add the runner as a second main build entry named `agent-setup-runner`.
- `NodePtyFactory` accepts resolvers for agent launch and agent setup and merges fixed command environment overrides.
- `TerminalManager.create()` titles setup requests `Setup Codex`, `Setup Claude`, or `Setup Gemini`.

- [ ] **Step 1: Write failing setup-runner tests**

  Cover four observable branches with literal commands:

  1. npm exit `0` starts the fixed auth command.
  2. npm exit `7` returns `7` and never invokes auth.
  3. a managed JavaScript bin uses Electron Node mode.
  4. a managed native bin executes directly.

  The assertion must inspect the real sequence returned by `runAgentSetup`, not source text.

- [ ] **Step 2: Run runner tests and verify RED**

  Run `pnpm --filter @codra/desktop test -- --run src/main/terminal/agent-setup-runner.test.ts`.

  Expected: module import fails because the runner is missing.

- [ ] **Step 3: Implement the runner**

  Parse exactly three positional inputs: runtime kind, managed install root, and npm CLI path. Use the runner's `process.execPath` as the Electron Node executable. Invoke npm with:

  ```ts
  [
    npmCliPath,
    "install",
    "--prefix",
    installRoot,
    "--save-exact",
    "--no-audit",
    "--no-fund",
    `${packageName}@latest`,
  ];
  ```

  Use inherited stdio. On success resolve `<installRoot>/node_modules/.bin/<runtime>` and execute its fixed authentication command. Set `process.exitCode` to the returned status. No shell is used.

- [ ] **Step 4: Run runner tests and verify GREEN**

  Re-run Step 2 and confirm all four branches pass.

- [ ] **Step 5: Write failing PTY and manager tests**

  Assert `agentSetup` selects the setup resolver, forwards `ELECTRON_RUN_AS_NODE`, creates the correct title, and remains mutually exclusive with agent launch. Mutation target: routing setup through the login shell must fail the tests.

- [ ] **Step 6: Run PTY/manager tests and verify RED**

  Run `pnpm --filter @codra/desktop test -- --run src/main/terminal/node-pty.test.ts src/main/terminal/manager.test.ts`.

  Expected: setup requests are not routed or titled.

- [ ] **Step 7: Implement PTY/manager routing and runtime dependency wiring**

  Resolve the managed prefix from `app.getPath("userData")`, resolve npm's packaged `bin/npm-cli.js`, and resolve the adjacent built runner. Pass the same runtime dependencies into agent listing, agent launch, and setup launch.

- [ ] **Step 8: Add npm as an exact desktop runtime dependency**

  Run `pnpm --filter @codra/desktop add --save-exact npm`. Do not add npm to the workspace root or dev dependencies.

- [ ] **Step 9: Configure both Electron builds with the runner entry and verify GREEN**

  Re-run Step 6, `pnpm --filter @codra/desktop typecheck`, `pnpm --filter @codra/desktop build`, and `pnpm --filter @codra/desktop build:remote-test`. Confirm both outputs contain `main/agent-setup-runner.js`.

- [ ] **Step 10: Commit Task 2**

  ```bash
  git add apps/desktop pnpm-lock.yaml
  git commit -m "feat: run managed agent setup"
  ```

### Task 3: Expose safe setup IPC and select its terminal

**Files:**

- Modify: `apps/desktop/src/main/ipc/terminal-ipc.ts`
- Modify: `apps/desktop/src/main/ipc/terminal-ipc.test.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/desktop-api.test.ts`
- Modify: `apps/desktop/src/renderer/src/terminal/useTerminals.ts`
- Modify: `apps/desktop/src/renderer/src/terminal/useTerminals.test.tsx`

**Interfaces:**

- Register `IPC_CHANNELS.agentSetup = "codra:agent:setup"`.
- `agents.setup(request)` returns `{ kind: "terminal", terminal }` or `{ kind: "external" }`.
- `RegisterTerminalIpcOptions` receives `openExternal(url): Promise<void>`.
- `useTerminals.setupAgent(request)` inserts and selects setup terminal results and returns the discriminated result.

- [ ] **Step 1: Write failing IPC tests**

  Verify an authorized Codex install creates exactly:

  ```ts
  { cols: 100, rows: 30, agentSetup: { kind: "codex", action: "install" } }
  ```

  Verify Ollama install opens only `https://ollama.com/download/mac`, Ollama auth is rejected by schema, duplicate active setup for the same kind rejects with `AGENT_SETUP_IN_PROGRESS`, and an exited setup descriptor releases the guard.

- [ ] **Step 2: Run IPC tests and verify RED**

  Run `pnpm --filter @codra/desktop test -- --run src/main/ipc/terminal-ipc.test.ts`.

  Expected: the setup channel and handler are absent.

- [ ] **Step 3: Implement IPC handler and per-runtime active guard**

  Reuse the manager's existing changed subscription to clear the guard when the matching terminal exits. Remove a guard immediately if terminal creation rejects. External Ollama setup never enters the terminal guard.

- [ ] **Step 4: Write failing preload and hook tests**

  Assert malformed setup results are rejected, validated results pass, terminal results enter the left tree and become active, and external results do not create a fake terminal.

- [ ] **Step 5: Run preload/hook tests and verify RED**

  Run `pnpm --filter @codra/desktop test -- --run src/preload/desktop-api.test.ts src/renderer/src/terminal/useTerminals.test.tsx`.

- [ ] **Step 6: Implement preload and hook setup methods**

  Parse request and result at both IPC boundaries. Reuse `replaceDescriptor()` and the existing selection behavior for terminal results.

- [ ] **Step 7: Run focused tests and verify GREEN**

  Re-run Steps 2 and 5 and confirm all pass.

- [ ] **Step 8: Commit Task 3**

  ```bash
  git add packages/protocol apps/desktop/src/main/ipc apps/desktop/src/preload apps/desktop/src/renderer/src/terminal
  git commit -m "feat: expose agent setup sessions"
  ```

### Task 4: Move setup into Settings and keep New Agent prompt-first

**Files:**

- Create: `apps/desktop/src/renderer/src/settings/AgentRuntimeSettings.tsx`
- Create: `apps/desktop/src/renderer/src/settings/AgentRuntimeSettings.test.tsx`
- Modify: `apps/desktop/src/renderer/src/settings/SettingsDialog.tsx`
- Modify: `apps/desktop/src/renderer/src/settings/SettingsDialog.test.tsx`
- Modify: `apps/desktop/src/renderer/src/agent/NewAgentDialog.tsx`
- Modify: `apps/desktop/src/renderer/src/agent/NewAgentDialog.test.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`

**Interfaces:**

- `SettingsDialog` accepts `initialSection: "remote" | "agents"`, runtime data, `setupKind`, and `onAgentSetup(request)`.
- `AgentRuntimeSettings` renders availability and action-oriented setup copy without credential values.
- `NewAgentDialog` accepts `onOpenAgentSettings()` and never emits a setup request.
- `App` refreshes runtime discovery when either surface opens and after a tracked setup terminal exits.

- [ ] **Step 1: Write failing Agent settings tests**

  Assert missing Gemini exposes `Install & sign in`, installed Claude exposes `Sign in / switch account`, missing Ollama exposes `Get Ollama`, ready Ollama says `No sign-in required`, busy setup disables repeat actions, and clicking each action emits only `{ kind, action }`.

- [ ] **Step 2: Run Agent settings tests and verify RED**

  Run `pnpm --filter @codra/desktop test -- --run src/renderer/src/settings/AgentRuntimeSettings.test.tsx src/renderer/src/settings/SettingsDialog.test.tsx`.

  Expected: the component and Settings section are absent.

- [ ] **Step 3: Implement Agent settings and Settings navigation**

  Use a compact vertical toolchain rack with semantic status nodes, runtime name, one-line state, and one action. Preserve the Remote access section unchanged.

- [ ] **Step 4: Write failing prompt-first New Agent tests**

  Assert the first prompt receives focus when opened, appears before model controls in document order, and remains the only required primary input. Selecting missing Gemini shows `Open Agent settings`; clicking it calls only `onOpenAgentSettings` and never `onStart` or `onAgentSetup`.

- [ ] **Step 5: Run New Agent tests and verify RED**

  Run `pnpm --filter @codra/desktop test -- --run src/renderer/src/agent/NewAgentDialog.test.tsx src/renderer/src/terminal/TerminalSidebar.test.tsx`.

  Expected: prompt order/focus and settings routing do not match.

- [ ] **Step 6: Implement prompt-first hierarchy and App coordination**

  Move the prompt immediately below the runtime identity, compact model/effort under `Run configuration`, and keep YOLO last. Opening Agent settings closes New Agent. A setup terminal result closes Settings, inserts/selects the terminal, and records its ID; exit triggers `agents.list()` once.

- [ ] **Step 7: Apply frontend-design critique**

  At 900×720 and the 760px minimum width, confirm the prompt is the dominant surface, the Settings list does not resemble a provider-card marketplace, focus is visible, status colors stay semantic, and reduced-motion behavior remains unchanged. Remove any decorative element that competes with the prompt or session rail.

- [ ] **Step 8: Run focused tests and verify GREEN**

  Re-run Steps 2 and 5 and confirm all pass.

- [ ] **Step 9: Commit Task 4**

  ```bash
  git add apps/desktop/src/renderer
  git commit -m "feat: add agent runtime settings"
  ```

### Task 5: Verify packaged setup and push main

**Files:**

- Modify only files required by failures found in this task.

- [ ] **Step 1: Run repository static checks**

  Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `git diff --check`. All must exit `0`.

- [ ] **Step 2: Run all unit and integration tests**

  Run `pnpm test`. All existing tests plus setup tests must pass without unhandled rejections.

- [ ] **Step 3: Run Electron builds and E2E**

  Run `pnpm test:e2e` and `pnpm --filter @codra/desktop build:remote-test`. Confirm the dev Electron tests pass and both builds contain the setup-runner output.

- [ ] **Step 4: Package and smoke-test the real app**

  Run `pnpm --filter @codra/desktop package:dir` and `pnpm test:packaged`. Inspect the packaged app to confirm npm and the setup runner are included, no system npm lookup occurs for managed setup, and normal shell startup still works.

- [ ] **Step 5: Perform a non-mutating UI smoke**

  Open Settings → Agent runtimes, verify action labels for ready/missing providers, route a missing provider from New Agent to Settings, and confirm the first prompt autofocuses. Do not perform a live provider install or alter existing credentials during smoke verification.

- [ ] **Step 6: Scan staged content for secrets and unsafe command construction**

  Confirm no provider token, Firebase private credential, Cloudflare bearer value, user-controlled executable, package name, URL, or shell pipeline is present.

- [ ] **Step 7: Commit remaining verification adjustments and push**

  ```bash
  git add -A
  git commit -m "feat: install and authenticate agent runtimes"
  git push origin main
  ```

- [ ] **Step 8: Confirm clean synchronization**

  Verify `git status --porcelain` is empty and `git rev-parse HEAD` equals `git rev-parse origin/main`.

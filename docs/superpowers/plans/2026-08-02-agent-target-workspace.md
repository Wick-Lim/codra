# CODRA Agent Target and Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task by task. Follow red-green-refactor, keep the renderer unprivileged, and use `superpowers:verification-before-completion` before claiming completion.

**Goal:** Make the first prompt the dominant `New agent` action while letting a user choose `This Mac` or another online CODRA desktop, browse a validated workspace on that device, select the target-specific runtime/model/effort, and launch a real local or WebRTC-backed remote agent terminal.

**Architecture:** Electron main owns launch-target discovery, Firebase session setup, node-datachannel WebRTC peers, remote workspace reads, and local/remote terminal routing. Firebase stores only device/session/SDP/ICE control-plane records. Paths, prompts, runtime catalogs, terminal input, and terminal output travel only over the authenticated WebRTC channels. The sandboxed renderer receives strict Zod-validated IPC contracts and presents compact device/workspace chips under the prompt.

**Tech stack:** Existing Electron 43, React 19, TypeScript 5.9, Zod 4, Firebase 12, node-datachannel 0.32, Vitest, Testing Library, and Playwright.

**Execution mode:** Inline execution on `main`, as explicitly requested. Each independent green milestone is committed and pushed without another approval prompt.

## Non-negotiable contracts

- `This Mac` remains the default and keeps the current native directory picker and local `TerminalManager` behavior.
- A remote choice is offered only for an online, same-account host other than the current device.
- A remote error never falls back to local execution.
- The renderer never imports Firebase, WebRTC, Node, or filesystem modules.
- Remote directory operations return directory metadata only. They do not read file contents, search, mutate, accept arbitrary commands, or accept environment maps.
- Every remote path is canonicalized and validated on the host immediately before launch.
- Every remote operation is authorized against the approved session scopes.
- Paths, prompts, runtime catalogs, and terminal bytes are never written to Firebase.
- Existing browser remote protocol operations remain valid; additions are strict and backward compatible.
- Existing local terminals and persisted descriptors continue to load without migration.
- Production source files should remain focused; extract protocol, transport, workspace, and proxy responsibilities instead of growing one controller indefinitely.

## Task 1: Freeze target, workspace, and remote-agent contracts

**Files**

- Modify `packages/protocol/src/terminal.ts`
- Modify `packages/protocol/src/desktop-api.ts`
- Modify `packages/protocol/src/remote.ts`
- Modify `packages/protocol/test/terminal.test.ts`
- Modify `packages/protocol/test/remote.test.ts`
- Create `packages/protocol/test/desktop-api.test.ts`

### Step 1: Write failing strict-schema tests

Cover:

- local and remote execution targets, with remote UUID/display-name bounds;
- workspace labels for POSIX root, Windows drive root, ordinary paths, and trailing separators;
- target listing, connection state, workspace roots/list/validate, target runtime listing, and target launch IPC payloads;
- directory pages bounded by 250 entries and 64 KiB of encoded metadata;
- rejection of files, unknown fields, traversal-only path fragments, arbitrary executable fields, environment fields, and oversized prompts;
- remote `workspace.roots`, `workspace.list`, `workspace.validate`, `agent.runtimes`, and `agent.launch` request/success/error correlations;
- terminal descriptors retaining optional local/remote origin metadata while old local descriptors still parse.

Run:

```bash
pnpm --filter @codra/protocol test
```

Expected: new tests fail because the contracts do not exist.

### Step 2: Implement the minimal schemas

Add:

- `AgentExecutionTargetSchema` and `AgentWorkspaceSchema`;
- `AgentLaunchTargetSchema`, `AgentTargetConnectionSchema`, `WorkspaceRootSchema`, `WorkspaceDirectoryEntrySchema`, and bounded request/result schemas;
- target-aware desktop API channels and methods;
- optional `origin` on renderer-facing `TerminalDescriptor`;
- strict remote control messages for the five new operations;
- stable remote failure codes for approval, disconnect, invalid workspace, unavailable runtime, and unsupported scope.

Do not add arbitrary command, environment, file-content, search, or mutation fields.

### Step 3: Run the focused suite and commit

```bash
pnpm --filter @codra/protocol test
pnpm --filter @codra/protocol typecheck
git add packages/protocol
git commit -m "feat(protocol): add remote agent workspace contracts"
git push origin main
```

## Task 2: Add a bounded host workspace service

**Files**

- Create `apps/desktop/src/main/remote/workspace-service.ts`
- Create `apps/desktop/src/main/remote/workspace-service.test.ts`

### Step 1: Write failing service tests

Use injected filesystem/OS dependencies and temporary fixtures to prove:

- home is first and duplicate filesystem roots are removed;
- child listings contain directories only, are locale-sorted, and are capped;
- a canonical path outside the advertised roots is rejected;
- missing paths, files, unreadable directories, malformed paths, and symlink escapes return stable errors;
- validation re-runs `realpath` and `stat` immediately before launch;
- no service method reads file contents or mutates the filesystem;
- aborting a request prevents stale results from being returned.

Run:

```bash
pnpm --filter @codra/desktop test -- workspace-service
```

Expected: fail because the service does not exist.

### Step 2: Implement the service

Implement an injected `WorkspaceService` with:

- canonical roots from the current user home and traversable platform filesystem/mount roots;
- `roots()`, `list(path, signal)`, and `validate(path)`;
- canonical boundary checks, bounded entry count/encoded bytes, directory-only metadata, and stable error translation;
- no shell invocation and no renderer-visible raw Node errors.

### Step 3: Verify and commit

```bash
pnpm --filter @codra/desktop test -- workspace-service
pnpm --filter @codra/desktop typecheck
git add apps/desktop/src/main/remote/workspace-service.ts apps/desktop/src/main/remote/workspace-service.test.ts
git commit -m "feat(desktop): add bounded workspace browser service"
git push origin main
```

## Task 3: Add the authenticated host control gateway

**Files**

- Create `apps/desktop/src/main/remote/host-control-gateway.ts`
- Create `apps/desktop/src/main/remote/host-control-gateway.test.ts`
- Modify `apps/desktop/src/main/terminal/manager.ts`
- Modify `apps/desktop/src/main/terminal/manager.test.ts`

### Step 1: Write failing gateway tests

Cover:

- no request is handled before the signed hello/hello-ack gate authorizes the peer;
- every operation requires its exact approved scope;
- workspace methods delegate only to `WorkspaceService`;
- runtime metadata comes from the host resolver;
- `agent.launch` validates the workspace again, validates the agent request, and calls `TerminalManager.create` with no arbitrary executable or environment;
- terminal attach/write/resize/detach routes only terminal IDs owned by that approved session;
- terminal output is framed on the terminal channel and cursor acknowledgements are bounded;
- disconnect detaches pumps without killing the host PTY;
- malformed/oversized messages return a stable correlated error and cannot crash the host.

### Step 2: Implement the gateway

Build a session-scoped gateway around the existing `HandshakeGate`, `AttachmentPump`, `TerminalManager`, `FileTerminalOutputStore`, runtime resolver, and workspace service. Add only the smallest manager adapter needed to expose cursor-backed output safely.

### Step 3: Verify and commit

```bash
pnpm --filter @codra/desktop test -- host-control-gateway manager
pnpm --filter @codra/desktop typecheck
git add apps/desktop/src/main/remote apps/desktop/src/main/terminal/manager.ts apps/desktop/src/main/terminal/manager.test.ts
git commit -m "feat(desktop): serve scoped remote agent operations"
git push origin main
```

## Task 4: Complete Firebase signaling and node-datachannel transport

**Files**

- Modify `packages/firebase/src/auth-client.ts`
- Modify `packages/firebase/src/index.ts`
- Modify `packages/firebase/src/index.test.ts`
- Create `apps/desktop/src/main/remote/signal-transport.ts`
- Create `apps/desktop/src/main/remote/signal-transport.test.ts`
- Create `apps/desktop/src/main/remote/peer-session.ts`
- Create `apps/desktop/src/main/remote/peer-session.test.ts`
- Modify `functions/src/index.ts`
- Modify `functions/src/auth.test.ts`

### Step 1: Write failing transport and authorization tests

Cover:

- a signed-in host device may act as a remote client while still being excluded from selecting itself;
- unauthenticated, inactive, wrong-owner, and unknown device kinds remain denied;
- signal publishing is signed, contiguous per direction/negotiation, and participant-bound;
- signal subscriptions ignore stale negotiations and stop cleanly;
- the client creates reliable ordered control/terminal channels, publishes an offer/candidates, and accepts only the bound answer/candidates;
- the host accepts only the approved session offer, publishes an answer/candidates, and rejects mismatched device/key/generation fields;
- TURN normalization stays Cloudflare UDP on node-datachannel and credentials never enter logs;
- a 20-second deadline, disconnect, or channel failure closes peer resources.

### Step 2: Implement the signaling boundary

Add typed Firebase helpers for `publishSignal`, `getDevice`, and live signal subscription. Permit active `host` devices as session clients in `listHostDevices` and `createRemoteSession`, but reject a self-target and retain all same-account/device-generation/key checks.

### Step 3: Implement peer sessions

Wrap native node-datachannel callbacks behind testable ports. Import the stored JWK into WebCrypto for signed hello/ack. Keep SDP and ICE in Firestore only until negotiation completes; keep every workspace/agent/terminal payload on the DataChannels.

### Step 4: Verify and commit

```bash
pnpm --filter @codra/firebase test
pnpm --filter @codra/functions test
pnpm --filter @codra/desktop test -- signal-transport peer-session
pnpm --filter @codra/firebase typecheck
pnpm --filter @codra/functions typecheck
pnpm --filter @codra/desktop typecheck
git add packages/firebase functions/src apps/desktop/src/main/remote
git commit -m "feat(remote): connect desktop peers over authenticated WebRTC"
git push origin main
```

## Task 5: Add remote client routing and proxy terminals

**Files**

- Create `apps/desktop/src/main/remote/remote-agent-client.ts`
- Create `apps/desktop/src/main/remote/remote-agent-client.test.ts`
- Create `apps/desktop/src/main/remote/proxy-terminal-router.ts`
- Create `apps/desktop/src/main/remote/proxy-terminal-router.test.ts`
- Modify `apps/desktop/src/main/remote/host-controller.ts`
- Modify `apps/desktop/src/main/remote/host-controller.test.ts`
- Modify `apps/desktop/src/main/bootstrap.ts`
- Modify `apps/desktop/src/main/bootstrap.test.ts`
- Modify `apps/desktop/src/main/index.ts`
- Modify `apps/desktop/src/main/ipc/terminal-ipc.ts`
- Modify `apps/desktop/src/main/ipc/terminal-ipc.test.ts`

### Step 1: Write failing routing tests

Prove:

- signed-out or disabled remote state lists only `This Mac`;
- online same-account hosts are listed and the current device is removed;
- selecting a remote host creates one scoped session and exposes approval/connecting/connected/rejected/disconnected states;
- target-specific runtime and workspace requests use only the selected peer;
- remote launch returns a renderer-safe descriptor with remote origin, selected cwd, and device name;
- write/resize/replay/close route by an internal terminal-origin registry, not renderer-supplied target fields;
- remote close detaches the proxy without killing the host PTY;
- disconnect marks proxy descriptors exited and never invokes local manager fallback;
- bootstrap wires the same local manager/output store into the host gateway after storage recovery and cleans remote peers before process exit.

### Step 2: Implement the client and router

Use the active host identity/device auth as a dual-role desktop client. Keep per-device peer/session/workspace/runtime state in main. Translate remote output frames into monotonically sequenced existing renderer chunks and cache bounded replay locally for the current app lifetime.

### Step 3: Verify and commit

```bash
pnpm --filter @codra/desktop test -- remote-agent-client proxy-terminal-router host-controller bootstrap terminal-ipc
pnpm --filter @codra/desktop typecheck
git add apps/desktop/src/main
git commit -m "feat(desktop): route agent terminals to remote hosts"
git push origin main
```

## Task 6: Expose strict target/workspace IPC through preload

**Files**

- Modify `apps/desktop/src/main/ipc/remote-ipc.ts`
- Modify `apps/desktop/src/main/ipc/remote-ipc.test.ts`
- Modify `apps/desktop/src/preload/desktop-api.ts`
- Modify `apps/desktop/src/preload/desktop-api.test.ts`
- Modify `apps/desktop/src/renderer/src/codra-api.typecheck.ts`

### Step 1: Write failing IPC/preload tests

Cover every new method, malformed request rejection before side effects, malformed response rejection, renderer authorization, stale request cancellation, and event listener cleanup.

### Step 2: Implement the bridge

Expose target list/connection, per-target runtime list, local/remote workspace browsing/validation, and target-aware launch through the existing `window.codra` surface. Keep Firebase/WebRTC/fs objects out of returned values.

### Step 3: Verify and commit

```bash
pnpm --filter @codra/desktop test -- remote-ipc desktop-api codra-api
pnpm --filter @codra/desktop typecheck
git add apps/desktop/src/main/ipc apps/desktop/src/preload apps/desktop/src/renderer/src/codra-api.typecheck.ts
git commit -m "feat(desktop): expose agent target workspace API"
git push origin main
```

## Task 7: Rebuild `New agent` around prompt and compact launch controls

**Required skill:** `frontend-design:frontend-design`

**Files**

- Modify `apps/desktop/src/renderer/src/agent/NewAgentDialog.tsx`
- Modify `apps/desktop/src/renderer/src/agent/NewAgentDialog.test.tsx`
- Create `apps/desktop/src/renderer/src/agent/RemoteWorkspaceDialog.tsx`
- Create `apps/desktop/src/renderer/src/agent/RemoteWorkspaceDialog.test.tsx`
- Modify `apps/desktop/src/renderer/src/App.tsx`
- Modify `apps/desktop/src/renderer/src/terminal/useTerminals.ts`
- Modify `apps/desktop/src/renderer/src/terminal/useTerminals.test.tsx`
- Modify `apps/desktop/src/renderer/src/styles.css`
- Modify `tests/e2e/desktop.spec.ts`

### Step 1: Write failing component tests

Assert:

- the first prompt is first and receives focus;
- immediately below it, `This Mac` and basename-only workspace chips are left aligned while `YOLO`, switch, and focusable help icon are right aligned;
- the workspace chip title/accessible name includes full path and device;
- root labels work on POSIX and Windows;
- device switching restores per-device workspace/runtime choices;
- a selected offline device remains visible, disables launch, and never falls back local;
- the remote picker supports roots, breadcrumbs, lazy child loading, empty/loading/permission/disconnected states, validation, cancellation, and stale response suppression;
- target runtime loading preserves the prompt and reports an unavailable prior choice;
- unsupported YOLO is disabled and its hover/focus tooltip explains why;
- the former large workspace input and YOLO explanation panel are absent;
- submission includes the exact target and validated workspace.

### Step 2: Implement the UI

Use compact native-feeling chips, a calm dark tool aesthetic consistent with the existing shell, restrained borders, visible keyboard focus, and no decorative card stack. The prompt remains the visual anchor; runtime/model/effort are one secondary row. The tree dialog uses a single breadcrumb header and dense folder rows.

### Step 3: Verify at target size and commit

```bash
pnpm --filter @codra/desktop test -- NewAgentDialog RemoteWorkspaceDialog useTerminals
pnpm --filter @codra/desktop typecheck
pnpm --filter @codra/desktop build
pnpm test:e2e -- --grep "new agent"
git add apps/desktop/src/renderer tests/e2e/desktop.spec.ts
git commit -m "feat(desktop): add compact local and remote agent launcher"
git push origin main
```

## Task 8: Polish browser sign-in completion and app return

**Files**

- Modify `apps/desktop/src/main/remote/desktop-login.ts`
- Modify `apps/desktop/src/main/remote/desktop-login.test.ts`
- Modify `apps/desktop/src/main/remote/account-bootstrap-google.ts`
- Modify `apps/desktop/src/main/remote/account-bootstrap-google.test.ts`

### Step 1: Write failing login UX tests

Assert that success and cancellation callbacks return a branded, accessible CODRA page with:

- a clear completion state;
- an automatic close attempt;
- a visible `Return to CODRA` fallback button;
- a concise instruction if the browser blocks closing;
- a restrictive CSP and no remote assets;
- Electron parent restore/show/focus plus application focus after completion.

### Step 2: Implement the page and foreground behavior

Generate static nonce-bound callback HTML with inline local CSS/script only. Attempt `window.close()` after the app is focused, retain a button that retries close/focus semantics, and keep the page useful when browser policy prevents programmatic closing.

### Step 3: Verify and commit

```bash
pnpm --filter @codra/desktop test -- desktop-login account-bootstrap-google
pnpm --filter @codra/desktop typecheck
git add apps/desktop/src/main/remote/desktop-login.ts apps/desktop/src/main/remote/desktop-login.test.ts apps/desktop/src/main/remote/account-bootstrap-google.ts apps/desktop/src/main/remote/account-bootstrap-google.test.ts
git commit -m "fix(auth): improve browser return to CODRA"
git push origin main
```

## Task 9: End-to-end verification and live Firebase rollout

**Files**

- Create or modify `tests/e2e/remote-agent-workspace.spec.ts`
- Modify `docs/superpowers/specs/2026-08-02-agent-target-workspace-design.md`
- Modify deployment files only if tests prove an index/rule change is required

### Step 1: Run two-device emulator coverage

Launch two isolated remote-test Electron profiles. Verify host discovery, approval, remote tree navigation, runtime discovery, agent launch, input/resize/output, disconnect behavior, and absence of path/prompt/terminal content from emulator Firestore documents.

```bash
pnpm build:remote-test
pnpm test:remote-direct
pnpm test:remote-reconnect
pnpm exec playwright test tests/e2e/remote-agent-workspace.spec.ts
```

### Step 2: Run the full repository gate

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test:e2e
pnpm verify:native-package
pnpm verify:remote-build-config
pnpm verify:firebase-indexes
pnpm scan:client-artifacts
```

Every command must exit zero. Fix regressions at their owning layer and rerun the focused test before rerunning the full gate.

### Step 3: Deploy only changed Firebase surfaces

If Task 4 changed callable authorization, deploy the exact changed Functions to the explicit project after the full local/emulator gate:

```bash
pnpm --filter @codra/functions build
pnpm stage:functions-deploy
firebase deploy --project codra-1b3bb --only functions:createRemoteSession,functions:listHostDevices
```

Do not print, copy, or modify configured Firebase/Cloudflare secrets.

### Step 4: Finalize documentation, commit, and push

Mark the approved design as implemented, record verified commands and any deliberately retained limitations, then:

```bash
git add docs tests apps packages functions
git commit -m "test: verify remote agent workspace flow"
git push origin main
git status --short --branch
```

Expected final status: `main...origin/main` with no worktree changes.

## Self-review checklist

- All file paths exist or are explicitly created by a task.
- Every behavior change starts with a failing test.
- Protocol additions are strict and size-bounded.
- The renderer receives no privileged object.
- Local behavior stays backward compatible.
- Remote failures never trigger local fallback.
- Firebase contains signaling only.
- Callback HTML has no remote asset or token exposure.
- Each milestone has a focused commit and push on `main`.
- Completion is claimed only after fresh verification output.

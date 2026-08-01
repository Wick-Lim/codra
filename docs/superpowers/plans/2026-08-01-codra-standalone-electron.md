# CODRA Standalone Electron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS-first standalone CODRA Electron application that runs local PTYs without login, keeps them alive while the window is closed, restores terminal state on reopen, and establishes the secure main/preload/renderer boundary needed by the later Firebase/WebRTC phase.

**Architecture:** Electron main owns `node-pty`, SQLite metadata, bounded file scrollback, lifecycle, and all privileged operations. A context-isolated preload exposes a versioned terminal API to a sandboxed React renderer, which renders xterm.js. There is no separate daemon, launch agent, background service, Unix socket, Firebase dependency, or remote transport in this plan.

**Tech Stack:** Node.js 22.22+, pnpm 11.5.2, Electron 43.2.0, electron-vite 5.0.0, React 19.2.8, TypeScript 5.9.3, Vite 7.3.6, Vitest 4.1.10, Playwright 1.62.1, node-pty 1.1.0, xterm.js 6.0.0, Zod 4.4.3, better-sqlite3 13.0.2, electron-builder 26.15.3.

## Global Constraints

- Initial platform is macOS; code boundaries must not assume a separately installed daemon.
- Electron main owns PTYs, scrollback, session state, and future WebRTC connections.
- Renderer settings are `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- Local terminal creation and operation must work with no login and with Firebase and Cloudflare unreachable.
- Closing the last window keeps Electron main and active PTYs alive; explicit Quit warns and then ends them.
- Renderer receives only the methods and events declared by `CodraDesktopApi`.
- Terminal output is persisted locally in bounded files; local metadata uses SQLite WAL.
- No source code, prompt, terminal input, terminal output, environment value, or credential is logged to cloud services.
- Production source files should remain focused; split a file before it exceeds roughly 250 lines of implementation.
- Every behavior change follows red-green-refactor and every task ends in a focused commit.
- The Firebase/WebRTC implementation is a separate dependent plan and begins only after Task 7 passes.

## Dependency and Parallelization Map

```text
Task 1: workspace + secure Electron shell
  ↓
Task 2: shared protocol + preload contracts
  ├──────────────┬──────────────┐
  ↓              ↓              ↓
Task 3           Task 4         Task 5
PTY manager      persistence    renderer/xterm
  └──────────────┴──────────────┘
                 ↓
Task 6: IPC + lifecycle integration
                 ↓
Task 7: E2E + packaging + CI
```

After Task 2 is reviewed, Tasks 3, 4, and 5 may run concurrently because they edit disjoint file sets and consume frozen interfaces from Task 2. Task 6 is the integration gate. Do not begin the remote-access plan until Task 7 passes on macOS.

## Planned File Structure

```text
codra/
├─ package.json                         workspace scripts and pinned package manager
├─ pnpm-workspace.yaml                  workspace membership
├─ pnpm-lock.yaml                       reproducible dependency graph
├─ tsconfig.base.json                   shared strict TypeScript options
├─ eslint.config.mjs                    flat ESLint configuration
├─ prettier.config.mjs                  formatting rules
├─ .gitignore                           generated, build, log, DB, and secret exclusions
├─ packages/
│  └─ protocol/
│     ├─ package.json                   shared protocol package metadata
│     ├─ tsconfig.json                  declaration build
│     ├─ src/index.ts                   public exports
│     ├─ src/terminal.ts                terminal schemas and types
│     ├─ src/desktop-api.ts             IPC names and CodraDesktopApi
│     └─ test/terminal.test.ts          schema and channel contract tests
├─ apps/
│  └─ desktop/
│     ├─ package.json                   Electron app dependencies and scripts
│     ├─ electron.vite.config.ts        main/preload/renderer build
│     ├─ electron-builder.yml           macOS application packaging
│     ├─ tsconfig.json                  project references
│     ├─ tsconfig.node.json             main and preload typing
│     ├─ tsconfig.web.json              renderer typing
│     ├─ vitest.config.ts               node/jsdom test configuration
│     ├─ test/setup.ts                   jsdom matchers and shared test cleanup
│     ├─ src/main/index.ts              Electron application composition root
│     ├─ src/main/window-options.ts     secure BrowserWindow configuration
│     ├─ src/main/lifecycle.ts          window-close, activate, and quit behavior
│     ├─ src/main/ipc/terminal-ipc.ts   validated IPC handlers and output fanout
│     ├─ src/main/terminal/contracts.ts PTY and persistence dependency interfaces
│     ├─ src/main/terminal/node-pty.ts  node-pty adapter
│     ├─ src/main/terminal/manager.ts   terminal lifecycle orchestration
│     ├─ src/main/terminal/sqlite.ts    SQLite WAL terminal repository
│     ├─ src/main/terminal/scrollback.ts bounded local output files
│     ├─ src/preload/index.ts           contextBridge entrypoint
│     ├─ src/preload/desktop-api.ts     testable IPC adapter
│     ├─ src/preload/global.d.ts        window.codra declaration
│     ├─ src/renderer/index.html        renderer entry document
│     ├─ src/renderer/src/main.tsx      React bootstrap
│     ├─ src/renderer/src/App.tsx       desktop application shell
│     ├─ src/renderer/src/styles.css    CODRA visual system
│     ├─ src/renderer/src/terminal/TerminalSidebar.tsx
│     ├─ src/renderer/src/terminal/TerminalPane.tsx
│     ├─ src/renderer/src/terminal/useTerminals.ts
│     └─ test/                          unit and integration tests
├─ tests/e2e/standalone-terminal.spec.ts
├─ playwright.config.ts
└─ .github/workflows/ci.yml
```

---

### Task 1: Bootstrap the Workspace and Secure Electron Shell

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `prettier.config.mjs`
- Create: `.gitignore`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsconfig.node.json`
- Create: `apps/desktop/tsconfig.web.json`
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/test/setup.ts`
- Create: `apps/desktop/src/main/window-options.test.ts`
- Create: `apps/desktop/src/main/window-options.ts`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/src/main.tsx`
- Create: `apps/desktop/src/renderer/src/App.tsx`
- Create: `apps/desktop/src/renderer/src/styles.css`

**Interfaces:**
- Consumes: none.
- Produces: workspace package `@codra/desktop`; `buildBrowserWindowOptions(preloadPath: string): BrowserWindowConstructorOptions`; root scripts `dev`, `build`, `test`, `typecheck`, `lint`, and `format:check`.

- [ ] **Step 1: Create workspace manifests with exact compatible versions**

Root `package.json` must include:

```json
{
  "name": "codra",
  "version": "0.0.1",
  "private": true,
  "packageManager": "pnpm@11.5.2",
  "engines": { "node": ">=22.22.0" },
  "scripts": {
    "dev": "pnpm --filter @codra/desktop dev",
    "build": "pnpm -r --if-present build",
    "test": "pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "lint": "eslint .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "eslint": "10.8.0",
    "prettier": "3.9.6",
    "typescript": "5.9.3",
    "typescript-eslint": "8.65.0"
  }
}
```

`apps/desktop/package.json` must pin Electron 43.2.0, electron-vite 5.0.0, Vite 7.3.6, React 19.2.8, `@vitejs/plugin-react` 5.2.0, Vitest 4.1.10, jsdom 30.0.1, `@testing-library/react` 16.3.2, `@testing-library/user-event` 14.6.1, `@testing-library/jest-dom` 7.0.0, `@types/react` 19.2.18, `@types/react-dom` 19.2.4, and `@types/node` 22.20.1. Native terminal and persistence dependencies are added in Tasks 3 and 4.

Configure electron-vite with `externalizeDepsPlugin({ exclude: ["@codra/protocol"] })` for main and preload, and the React plugin for renderer. Vitest uses Node by default, switches renderer tests to jsdom by file glob, and loads `test/setup.ts`, which imports `@testing-library/jest-dom/vitest` and calls Testing Library cleanup after each test.

- [ ] **Step 2: Install dependencies and generate the lockfile**

Run: `pnpm install`

Expected: exit 0 and a new `pnpm-lock.yaml`; no peer error for Vite 8 because this plan pins Vite 7.3.6.

- [ ] **Step 3: Write the failing BrowserWindow security test**

```ts
import { describe, expect, it } from "vitest";
import { buildBrowserWindowOptions } from "./window-options";

describe("buildBrowserWindowOptions", () => {
  it("isolates and sandboxes the renderer", () => {
    const options = buildBrowserWindowOptions("/tmp/preload.js");
    expect(options.webPreferences).toMatchObject({
      preload: "/tmp/preload.js",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  });
});
```

- [ ] **Step 4: Run the focused test and verify RED**

Run: `pnpm --filter @codra/desktop test -- src/main/window-options.test.ts`

Expected: FAIL because `./window-options` does not exist.

- [ ] **Step 5: Implement the secure window options and minimal Electron shell**

```ts
import type { BrowserWindowConstructorOptions } from "electron";

export function buildBrowserWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0d10",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}
```

`src/main/index.ts` creates one `BrowserWindow`, uses the electron-vite development URL when present, loads the built HTML otherwise, and shows only on `ready-to-show`. Preload remains empty in this task. Renderer displays `CODRA` and `Local workspace` without calling Node APIs.

- [ ] **Step 6: Verify test, typecheck, and production build**

Run:

```bash
pnpm --filter @codra/desktop test -- src/main/window-options.test.ts
pnpm --filter @codra/desktop typecheck
pnpm --filter @codra/desktop build
```

Expected: all commands exit 0 and `apps/desktop/out/main/index.js` exists.

- [ ] **Step 7: Commit the workspace shell**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.mjs prettier.config.mjs .gitignore apps/desktop
git commit -m "feat: bootstrap secure Electron desktop shell"
```

---

### Task 2: Freeze the Terminal Protocol and Preload Contracts

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/terminal.ts`
- Create: `packages/protocol/src/desktop-api.ts`
- Create: `packages/protocol/test/terminal.test.ts`
- Create: `apps/desktop/src/main/terminal/contracts.ts`
- Create: `apps/desktop/src/preload/desktop-api.test.ts`
- Create: `apps/desktop/src/preload/desktop-api.ts`
- Create: `apps/desktop/src/preload/global.d.ts`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Electron IPC from Task 1.
- Produces: `TerminalDescriptor`, terminal request schemas, `TerminalOutputChunk`, `IPC_CHANNELS`, `CodraDesktopApi`, `PtyFactory`, `TerminalRepository`, and `TerminalOutputStore`. Tasks 3–6 must use these names unchanged.

- [ ] **Step 1: Create the internal protocol package manifest**

Create `@codra/protocol` as a private ESM workspace package with `exports: { ".": "./src/index.ts" }`, `test: "vitest run"`, and `typecheck: "tsc --noEmit"`. Add `zod: "4.4.3"`, Vitest 4.1.10, and TypeScript 5.9.3. Add `@codra/protocol: "workspace:*"` to the desktop app, then run `pnpm install` so the lockfile records the workspace link.

- [ ] **Step 2: Write failing protocol tests**

```ts
import { describe, expect, it } from "vitest";
import {
  CreateTerminalRequestSchema,
  ResizeTerminalRequestSchema,
  WriteTerminalRequestSchema,
} from "../src/terminal";

describe("terminal protocol", () => {
  it("accepts a bounded terminal creation request", () => {
    expect(
      CreateTerminalRequestSchema.parse({ cols: 120, rows: 32 }),
    ).toEqual({ cols: 120, rows: 32 });
  });

  it("rejects unsafe resize and oversized input", () => {
    expect(() =>
      ResizeTerminalRequestSchema.parse({ terminalId: crypto.randomUUID(), cols: 2, rows: 2 }),
    ).toThrow();
    expect(() =>
      WriteTerminalRequestSchema.parse({ terminalId: crypto.randomUUID(), data: "x".repeat(65_537) }),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run the protocol test and verify RED**

Run: `pnpm --filter @codra/protocol test -- test/terminal.test.ts`

Expected: FAIL because package `@codra/protocol` and its schemas do not exist.

- [ ] **Step 4: Implement exact shared terminal types and schemas**

```ts
import { z } from "zod";

export const TerminalIdSchema = z.string().uuid();
export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
});
export const CreateTerminalRequestSchema = TerminalSizeSchema.extend({
  cwd: z.string().min(1).max(4096).optional(),
});
export const WriteTerminalRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  data: z.string().min(1).max(65_536),
});
export const ResizeTerminalRequestSchema = TerminalSizeSchema.extend({
  terminalId: TerminalIdSchema,
});
export const ReplayTerminalRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  afterSequence: z.number().int().min(0),
  limit: z.number().int().min(1).max(1000).default(500),
});

export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>;
export type WriteTerminalRequest = z.infer<typeof WriteTerminalRequestSchema>;
export type ResizeTerminalRequest = z.infer<typeof ResizeTerminalRequestSchema>;
export type ReplayTerminalRequest = z.infer<typeof ReplayTerminalRequestSchema>;

export interface TerminalDescriptor {
  id: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  state: "running" | "exited";
  createdAt: string;
  exitCode?: number;
}

export interface TerminalOutputChunk {
  terminalId: string;
  sequence: number;
  data: string;
}

export const TerminalDescriptorSchema: z.ZodType<TerminalDescriptor> = z.object({
  id: TerminalIdSchema,
  title: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096),
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
  state: z.enum(["running", "exited"]),
  createdAt: z.string().datetime(),
  exitCode: z.number().int().optional(),
});

export const TerminalOutputChunkSchema: z.ZodType<TerminalOutputChunk> = z.object({
  terminalId: TerminalIdSchema,
  sequence: z.number().int().positive(),
  data: z.string(),
});
```

Define the desktop API exactly as follows:

```ts
export const IPC_CHANNELS = {
  terminalList: "codra:terminal:list",
  terminalCreate: "codra:terminal:create",
  terminalWrite: "codra:terminal:write",
  terminalResize: "codra:terminal:resize",
  terminalReplay: "codra:terminal:replay",
  terminalClose: "codra:terminal:close",
  terminalOutput: "codra:terminal:output",
  terminalChanged: "codra:terminal:changed",
} as const;

export interface CodraDesktopApi {
  terminal: {
    list(): Promise<TerminalDescriptor[]>;
    create(request: CreateTerminalRequest): Promise<TerminalDescriptor>;
    write(request: WriteTerminalRequest): Promise<void>;
    resize(request: ResizeTerminalRequest): Promise<void>;
    replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]>;
    close(terminalId: string): Promise<void>;
    onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void;
    onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void;
  };
}
```

`global.d.ts` declares `window.codra: CodraDesktopApi`. No other object is exposed on `window`.

- [ ] **Step 5: Define frozen main-process dependency interfaces**

```ts
export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exitCode: number) => void): () => void;
}

export interface PtyFactory {
  spawn(request: CreateTerminalRequest): PtyHandle;
}

export interface TerminalRepository {
  save(descriptor: TerminalDescriptor): Promise<void>;
  update(descriptor: TerminalDescriptor): Promise<void>;
  list(): Promise<TerminalDescriptor[]>;
  markRunningExited(exitCode: number): Promise<void>;
}

export interface TerminalOutputStore {
  append(terminalId: string, data: string): Promise<TerminalOutputChunk>;
  readAfter(terminalId: string, afterSequence: number, limit: number): Promise<TerminalOutputChunk[]>;
  remove(terminalId: string): Promise<void>;
}
```

- [ ] **Step 6: Test and implement the testable preload adapter**

The preload test uses an `IpcRendererLike` fake and verifies every invocation uses `IPC_CHANNELS`, validates output events, and removes only its own listener. Implement `createDesktopApi(ipc: IpcRendererLike): CodraDesktopApi`; do not call `contextBridge` from this testable module.

- [ ] **Step 7: Verify the contract packages**

Run:

```bash
pnpm --filter @codra/protocol test
pnpm --filter @codra/protocol typecheck
pnpm --filter @codra/desktop test -- src/preload/desktop-api.test.ts
pnpm --filter @codra/desktop typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Pin dependencies shared by the parallel implementation wave**

Install the native/runtime dependencies needed by Tasks 3–5 before those tasks branch into parallel work, so their file sets remain disjoint:

```bash
pnpm --filter @codra/desktop add node-pty@1.1.0 better-sqlite3@13.0.2 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
pnpm --filter @codra/desktop add -D @types/better-sqlite3@7.6.13
```

- [ ] **Step 9: Commit the frozen contracts and shared dependency pins**

```bash
git add packages/protocol apps/desktop/src/main/terminal/contracts.ts apps/desktop/src/preload apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: define desktop terminal contracts"
```

---

### Task 3: Implement the Main-process PTY Manager

**Files:**
- Create: `apps/desktop/src/main/terminal/manager.test.ts`
- Create: `apps/desktop/src/main/terminal/manager.ts`
- Create: `apps/desktop/src/main/terminal/node-pty.test.ts`
- Create: `apps/desktop/src/main/terminal/node-pty.ts`

**Interfaces:**
- Consumes: `PtyFactory`, `TerminalRepository`, and `TerminalOutputStore` from Task 2.
- Produces: `TerminalManager` with `list()`, `create()`, `write()`, `resize()`, `replay()`, `close()`, `closeAll()`, `onOutput()`, and `onChanged()`; `NodePtyFactory` implements `PtyFactory`.

- [ ] **Step 1: Write failing manager tests with in-memory fakes**

```ts
it("persists output before publishing it", async () => {
  const { manager, pty, outputStore, published } = createHarness();
  const terminal = await manager.create({ cols: 80, rows: 24 });
  pty.emitData("hello\r\n");
  await outputStore.whenAppended();

  expect(outputStore.chunks).toEqual([
    { terminalId: terminal.id, sequence: 1, data: "hello\r\n" },
  ]);
  expect(published).toEqual(outputStore.chunks);
});

it("routes validated input and resize to the selected PTY", async () => {
  const { manager, pty } = createHarness();
  const terminal = await manager.create({ cols: 80, rows: 24 });
  await manager.write({ terminalId: terminal.id, data: "pwd\r" });
  await manager.resize({ terminalId: terminal.id, cols: 120, rows: 40 });
  expect(pty.writes).toEqual(["pwd\r"]);
  expect(pty.sizes).toContainEqual([120, 40]);
});
```

- [ ] **Step 2: Run manager tests and verify RED**

Run: `pnpm --filter @codra/desktop test -- src/main/terminal/manager.test.ts`

Expected: FAIL because `TerminalManager` is missing.

- [ ] **Step 3: Implement the terminal manager**

`TerminalManager.create()` chooses the requested cwd or `os.homedir()`, generates a UUID, spawns the user's shell, saves a `running` descriptor, subscribes to data/exit, and returns the descriptor. Output handling must await `outputStore.append()` before notifying listeners. `close()` kills the PTY, marks the descriptor exited, removes in-memory listeners, and leaves scrollback available for replay. Unknown IDs throw `TerminalError("TERMINAL_NOT_FOUND")`.

```ts
export class TerminalManager {
  constructor(
    private readonly ptyFactory: PtyFactory,
    private readonly repository: TerminalRepository,
    private readonly outputStore: TerminalOutputStore,
  ) {}

  async create(request: CreateTerminalRequest): Promise<TerminalDescriptor>;
  async list(): Promise<TerminalDescriptor[]>;
  async write(request: WriteTerminalRequest): Promise<void>;
  async resize(request: ResizeTerminalRequest): Promise<void>;
  async replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]>;
  async close(terminalId: string): Promise<void>;
  async closeAll(): Promise<void>;
  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void;
  onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void;
}
```

Publish `onChanged` after creation, resize, process exit, and explicit close. Exit handling is idempotent so a close followed by a native exit event cannot publish conflicting descriptors.

- [ ] **Step 4: Implement and test `NodePtyFactory`**

Use the `node-pty@1.1.0` dependency pinned by Task 2. Use the user's `SHELL`, falling back to `/bin/zsh`; pass `TERM=xterm-256color`, the bounded columns/rows, and a copied environment. The adapter returns unsubscribe closures for data and exit listeners. Its integration test spawns `/bin/zsh -l`, writes `printf '__CODRA_PTY__\\n'`, observes the marker, and kills the PTY in `finally`.

- [ ] **Step 5: Verify PTY manager tests**

Run:

```bash
pnpm --filter @codra/desktop test -- src/main/terminal/manager.test.ts src/main/terminal/node-pty.test.ts
pnpm --filter @codra/desktop typecheck
```

Expected: all tests pass and the real PTY test exits without a child process leak.

- [ ] **Step 6: Commit the PTY manager**

```bash
git add apps/desktop/src/main/terminal
git commit -m "feat: add Electron PTY manager"
```

---

### Task 4: Implement SQLite Metadata and Bounded Scrollback

**Files:**
- Create: `apps/desktop/src/main/terminal/sqlite.test.ts`
- Create: `apps/desktop/src/main/terminal/sqlite.ts`
- Create: `apps/desktop/src/main/terminal/scrollback.test.ts`
- Create: `apps/desktop/src/main/terminal/scrollback.ts`

**Interfaces:**
- Consumes: `TerminalRepository` and `TerminalOutputStore` from Task 2.
- Produces: `SqliteTerminalRepository` and `FileTerminalOutputStore` with a default 10 MiB limit per terminal.

- [ ] **Step 1: Write failing SQLite WAL tests**

```ts
it("persists descriptors in WAL mode", async () => {
  const repository = new SqliteTerminalRepository(databasePath);
  await repository.save(descriptor);
  expect(await repository.list()).toEqual([descriptor]);
  expect(repository.journalMode()).toBe("wal");
  repository.close();
});

it("marks stale running descriptors exited after an abnormal restart", async () => {
  const repository = new SqliteTerminalRepository(databasePath);
  await repository.save(descriptor);
  await repository.markRunningExited(-1);
  expect(await repository.list()).toEqual([
    { ...descriptor, state: "exited", exitCode: -1 },
  ]);
  repository.close();
});
```

- [ ] **Step 2: Run the SQLite test and verify RED**

Run: `pnpm --filter @codra/desktop test -- src/main/terminal/sqlite.test.ts`

Expected: FAIL because `SqliteTerminalRepository` does not exist.

- [ ] **Step 3: Implement the SQLite repository**

Use the `better-sqlite3@13.0.2` and `@types/better-sqlite3@7.6.13` dependencies pinned by Task 2. Create table `terminals(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, cols INTEGER, rows INTEGER, state TEXT, created_at TEXT, exit_code INTEGER)`, enable `journal_mode = WAL`, and map rows explicitly to `TerminalDescriptor`. Use prepared insert/update/list and `UPDATE terminals SET state = 'exited', exit_code = ? WHERE state = 'running'` statements. The constructor accepts a DB path and creates its parent directory.

- [ ] **Step 4: Write failing scrollback replay and bound tests**

```ts
it("replays monotonically sequenced chunks", async () => {
  const store = new FileTerminalOutputStore(root, 1024);
  await store.append(id, "one");
  await store.append(id, "two");
  expect(await store.readAfter(id, 1, 10)).toEqual([
    { terminalId: id, sequence: 2, data: "two" },
  ]);
});

it("compacts to the configured byte limit", async () => {
  const store = new FileTerminalOutputStore(root, 96);
  for (let index = 0; index < 20; index += 1) {
    await store.append(id, `line-${index}\n`);
  }
  expect((await fs.stat(store.pathFor(id))).size).toBeLessThanOrEqual(96);
  expect((await store.readAfter(id, 0, 100)).at(-1)?.data).toBe("line-19\n");
});
```

- [ ] **Step 5: Implement JSONL scrollback with atomic compaction**

Each line is `{ "sequence": number, "data": string }`. Maintain the next sequence per terminal by scanning once on first access. Append before publish. When the file exceeds the limit, retain the newest complete records that fit, write them to `<id>.compact`, `fsync`, and atomically rename over `<id>.jsonl`. Serialize operations per terminal with a promise chain so concurrent PTY output cannot reorder sequences.

- [ ] **Step 6: Verify persistence tests**

Run:

```bash
pnpm --filter @codra/desktop test -- src/main/terminal/sqlite.test.ts src/main/terminal/scrollback.test.ts
pnpm --filter @codra/desktop typecheck
```

Expected: all tests pass; every test uses a fresh `mkdtemp` directory and removes it in teardown.

- [ ] **Step 7: Commit persistence**

```bash
git add apps/desktop/src/main/terminal
git commit -m "feat: persist terminal metadata and scrollback"
```

---

### Task 5: Build the Local Terminal Renderer

**Files:**
- Create: `apps/desktop/src/renderer/src/terminal/useTerminals.test.tsx`
- Create: `apps/desktop/src/renderer/src/terminal/useTerminals.ts`
- Create: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.test.tsx`
- Create: `apps/desktop/src/renderer/src/terminal/TerminalSidebar.tsx`
- Create: `apps/desktop/src/renderer/src/terminal/TerminalPane.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `window.codra: CodraDesktopApi` from Task 2.
- Produces: local terminal workspace UI and `useTerminals()` state hook. No renderer file imports Electron, Node, `node-pty`, or filesystem modules.

- [ ] **Step 1: Invoke `frontend-design` before editing renderer files**

Read and apply the available frontend-design skill. Preserve this direction: dense desktop tool, matte graphite surfaces, warm off-white text, one restrained electric-cyan status accent, clear terminal focus, compact 220 px sidebar, no gradients, no oversized marketing typography, and no dashboard cards.

- [ ] **Step 2: Write failing hook and sidebar tests**

```tsx
it("loads terminals and selects a newly created terminal", async () => {
  const api = createDesktopApiFake();
  api.terminal.list.mockResolvedValue([]);
  api.terminal.create.mockResolvedValue(descriptor);
  render(<TestHarness api={api} />);
  await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  expect(await screen.findByText(descriptor.title)).toBeVisible();
  expect(screen.getByTestId("active-terminal")).toHaveAttribute("data-terminal-id", descriptor.id);
});

it("marks exited terminals without removing their scrollback", async () => {
  render(<TerminalSidebar terminals={[exitedDescriptor]} activeId={exitedDescriptor.id} />);
  expect(screen.getByText("Exited")).toBeVisible();
});
```

- [ ] **Step 3: Run renderer tests and verify RED**

Run: `pnpm --filter @codra/desktop test -- src/renderer/src/terminal`

Expected: FAIL because the hook and components do not exist.

- [ ] **Step 4: Implement terminal state and sidebar**

`useTerminals()` subscribes to both `onOutput` and `onChanged` before its initial replay, loads once, tracks descriptors by ID, selects the first running terminal, creates terminals at 100×30, deduplicates output by `(terminalId, sequence)`, replaces descriptors received from `onChanged`, exposes `createTerminal`, `selectTerminal`, and `closeTerminal`, and unsubscribes on unmount. Sidebar has one primary “New terminal” control, terminal title, cwd basename, running/exited state, and keyboard-focus styling.

- [ ] **Step 5: Implement xterm.js pane**

Use the `@xterm/xterm@6.0.0` and `@xterm/addon-fit@0.11.0` dependencies pinned by Task 2. `TerminalPane` creates one `Terminal` and `FitAddon` per active terminal, imports `@xterm/xterm/css/xterm.css`, replays from sequence 0 on first attach, calls `terminal.write(chunk.data)`, forwards `onData` to `window.codra.terminal.write`, and forwards debounced fit dimensions to `resize`. Dispose terminal, addon, resize observer, and listeners on terminal change or unmount.

- [ ] **Step 6: Implement the desktop visual shell**

Use CSS custom properties for graphite backgrounds, hairline borders, text hierarchy, focus rings, and status accent. Layout is sidebar + terminal stage + 28 px status strip. At 900 px width the sidebar may collapse to 176 px; below the declared application minimum no responsive mode is required.

- [ ] **Step 7: Verify renderer behavior**

Run:

```bash
pnpm --filter @codra/desktop test -- src/renderer/src/terminal
pnpm --filter @codra/desktop typecheck
pnpm --filter @codra/desktop build
```

Expected: all commands exit 0; renderer bundle contains no Node built-ins.

- [ ] **Step 8: Commit the renderer**

```bash
git add apps/desktop/src/renderer
git commit -m "feat: add local terminal workspace UI"
```

---

### Task 6: Integrate IPC and Electron Lifecycle

**Files:**
- Create: `apps/desktop/src/main/ipc/terminal-ipc.test.ts`
- Create: `apps/desktop/src/main/ipc/terminal-ipc.ts`
- Create: `apps/desktop/src/main/lifecycle.test.ts`
- Create: `apps/desktop/src/main/lifecycle.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: `TerminalManager`, persistence implementations, `CodraDesktopApi`, and renderer from Tasks 2–5.
- Produces: a functioning standalone application composition root; `registerTerminalIpc()`; `DesktopLifecycle`.

- [ ] **Step 1: Write failing IPC validation tests**

```ts
it("validates create requests before invoking the manager", async () => {
  const { handlers, manager } = createIpcHarness();
  await expect(handlers.invoke(IPC_CHANNELS.terminalCreate, { cols: 1, rows: 1 })).rejects.toThrow();
  expect(manager.create).not.toHaveBeenCalled();
});

it("fans persisted output to every open renderer", async () => {
  const { manager, windows } = createIpcHarness();
  manager.emitOutput(chunk);
  expect(windows[0].webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.terminalOutput, chunk);
});

it("fans descriptor changes to every open renderer", () => {
  const { manager, windows } = createIpcHarness();
  manager.emitChanged(exitedDescriptor);
  expect(windows[0].webContents.send).toHaveBeenCalledWith(
    IPC_CHANNELS.terminalChanged,
    exitedDescriptor,
  );
});
```

- [ ] **Step 2: Run IPC tests and verify RED**

Run: `pnpm --filter @codra/desktop test -- src/main/ipc/terminal-ipc.test.ts`

Expected: FAIL because `registerTerminalIpc` is missing.

- [ ] **Step 3: Implement validated IPC handlers**

Register one handler for each request channel. Parse every raw payload with the Task 2 Zod schema before calling `TerminalManager`. Send output only after manager publication and send descriptor changes on `terminalChanged`. Return an unregister function that removes handlers and both subscriptions, enabling isolated tests and clean application shutdown.

- [ ] **Step 4: Write failing lifecycle tests**

```ts
it("keeps the app alive when the last macOS window closes", () => {
  const lifecycle = createLifecycleHarness({ platform: "darwin", activeTerminals: 1 });
  lifecycle.onWindowAllClosed();
  expect(lifecycle.app.quit).not.toHaveBeenCalled();
});

it("asks before quitting with active terminals", async () => {
  const lifecycle = createLifecycleHarness({ platform: "darwin", activeTerminals: 2, confirmQuit: false });
  const event = createBeforeQuitEvent();
  await lifecycle.onBeforeQuit(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(lifecycle.manager.closeAll).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Implement lifecycle and composition root**

`DesktopLifecycle` keeps the app running on macOS after all windows close, recreates the window on `activate`, and shows a native warning before explicit quit when terminals are running. Confirmed quit sets an internal `quitting` guard, awaits `manager.closeAll()`, closes SQLite, unregisters IPC, then calls `app.quit()` once.

The composition root creates data paths under `app.getPath("userData")`, constructs `SqliteTerminalRepository`, `FileTerminalOutputStore`, `NodePtyFactory`, and `TerminalManager`, calls `repository.markRunningExited(-1)` to recover stale records from an abnormal previous exit, registers IPC, exposes `createDesktopApi(ipcRenderer)` through `contextBridge.exposeInMainWorld("codra", ...)`, and then creates the window.

- [ ] **Step 6: Verify integrated unit tests and build**

Run:

```bash
pnpm --filter @codra/desktop test
pnpm --filter @codra/desktop typecheck
pnpm --filter @codra/desktop build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit IPC and lifecycle integration**

```bash
git add apps/desktop/src/main apps/desktop/src/preload
git commit -m "feat: integrate terminal IPC and desktop lifecycle"
```

---

### Task 7: Verify Standalone E2E, Package macOS, and Add CI

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/standalone-terminal.spec.ts`
- Create: `tests/e2e/packaged-terminal.spec.ts`
- Create: `apps/desktop/electron-builder.yml`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the complete standalone Electron application from Tasks 1–6.
- Produces: `pnpm test:e2e`, `pnpm test:packaged`, `pnpm package:mac`, a macOS CI gate, and the handoff point for the remote-access plan.

- [ ] **Step 1: Write the failing Electron E2E test**

Add `@playwright/test@1.62.1`, `playwright@1.62.1`, and `electron-builder@26.15.3` as root development dependencies before creating the test and configuration.

```ts
import path from "node:path";
import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";

const desktopMainEntry = path.resolve("apps/desktop/out/main/index.js");

test("creates a terminal and restores it after closing the window", async () => {
  const electronApp = await electron.launch({ args: [desktopMainEntry] });
  let page = await electronApp.firstWindow();
  await page.getByRole("button", { name: "New terminal" }).click();
  const terminalId = await page.getByTestId("active-terminal").getAttribute("data-terminal-id");

  await page.evaluate(async ({ id }) => {
    await window.codra.terminal.write({ terminalId: id!, data: "printf '__CODRA_E2E__\\n'\r" });
  }, { id: terminalId });

  await expect.poll(async () => page.evaluate(async ({ id }) => {
    const chunks = await window.codra.terminal.replay({ terminalId: id!, afterSequence: 0, limit: 500 });
    return chunks.map((chunk) => chunk.data).join("");
  }, { id: terminalId })).toContain("__CODRA_E2E__");

  await page.close();
  const reopenedWindow = electronApp.waitForEvent("window");
  await electronApp.evaluate(({ app }) => app.emit("activate"));
  page = await reopenedWindow;
  await expect(page.getByTestId("active-terminal")).toHaveAttribute("data-terminal-id", terminalId!);
  await page.evaluate(async ({ id }) => window.codra.terminal.close(id!), { id: terminalId });
  await electronApp.close();
});
```

- [ ] **Step 2: Run E2E and verify RED**

Run: `pnpm build && pnpm test:e2e`

Expected: FAIL until root scripts, packaged entry resolution, and test data-directory isolation are implemented.

- [ ] **Step 3: Implement deterministic E2E launch support**

Add `CODRA_USER_DATA_DIR` handling in the composition root only when `app.isPackaged === false`; the test supplies a new temporary directory. A separate `CODRA_PACKAGED_SMOKE=1` opt-in may allow the packaged smoke test to supply its own temporary user-data directory without changing normal packaged behavior. Add `test:e2e` that builds and invokes Playwright. Ensure E2E teardown explicitly confirms Quit so no Electron or shell process remains.

- [ ] **Step 4: Configure macOS packaging**

`electron-builder.yml` uses `appId: com.codra.desktop`, `productName: CODRA`, category `public.app-category.developer-tools`, hardened runtime, and `mac` targets `dmg` and `zip` for `arm64` and `x64`. Explicitly ASAR-unpack both `node-pty` and `better-sqlite3` so the selected `spawn-helper` remains a directly executable file and native bindings remain loadable. Add `postinstall: electron-builder install-app-deps` so both modules are rebuilt for Electron. CI packages an unsigned directory artifact; release signing/notarization credentials remain outside this plan.

After `package:dir`, `packaged-terminal.spec.ts` locates the generated `CODRA.app/Contents/MacOS/CODRA` executable, launches that binary with an isolated smoke-test data directory, creates a real shell, observes a marker that is not present in terminal echo, closes it, quits the packaged app, and verifies the PTY PID no longer exists. This test must fail if `spawn-helper` is still inside ASAR or loses executable permissions.

- [ ] **Step 5: Add macOS CI**

The workflow runs on `macos-14`, installs Node 22 and pnpm 11.5.2, then runs:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm --filter @codra/desktop package:dir
pnpm test:packaged
```

Upload the unpacked application only after every check passes.

- [ ] **Step 6: Document local development and lifecycle semantics**

README must state: `pnpm dev` starts CODRA; local mode requires no account; closing the window keeps terminals running on macOS; Quit stops them after confirmation; Firebase/WebRTC is not yet part of this phase; `pnpm test:e2e` and `pnpm test:packaged` require macOS.

- [ ] **Step 7: Run the full standalone verification gate**

Run the exact CI command sequence locally. Expected: zero lint errors, zero formatting differences, zero type errors, all unit/integration/E2E tests pass, production build exits 0, and the unpacked macOS app is created.

- [ ] **Step 8: Commit the standalone release gate**

```bash
git add package.json pnpm-lock.yaml playwright.config.ts tests .github apps/desktop/electron-builder.yml apps/desktop/package.json apps/desktop/src/main/index.ts README.md .gitignore
git commit -m "test: gate standalone Electron release"
```

## Standalone Completion Gate

Before starting the remote-access plan, verify all of these from fresh command output:

- Electron launches without Firebase configuration or network access.
- Renderer has no Node integration and exposes only `window.codra`.
- Local PTY create/input/output/resize/close works.
- Window close and reopen preserve the main process, PTY, terminal list, and scrollback.
- Explicit Quit warns and then leaves no PTY child process.
- SQLite reports WAL mode and scrollback remains at or below 10 MiB per terminal.
- Full lint, format, typecheck, unit, integration, E2E, build, and package gates pass.

When this gate passes, create `docs/superpowers/plans/2026-08-01-codra-remote-access.md` from the approved design. Its parallel lanes will be Firebase rules/functions, Electron host WebRTC, and the web remote client, converging at direct-ICE and forced-TURN integration tests.

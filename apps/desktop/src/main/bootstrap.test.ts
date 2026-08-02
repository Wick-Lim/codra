import type { TerminalDescriptor } from "@codra/protocol";
import { describe, expect, it, vi } from "vitest";
import type { TerminalOutputStore } from "./terminal/contracts";
import {
  bootstrapDesktop,
  type DesktopBootstrapManager,
  type DesktopBootstrapRepository,
} from "./bootstrap";

const descriptor: TerminalDescriptor = {
  id: "f4b0f73d-3406-48ec-a5c2-2cf290905e99",
  title: "Terminal",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  state: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
};

function managerFake(): DesktopBootstrapManager {
  return {
    list: vi.fn(async () => [descriptor]),
    create: vi.fn(async () => descriptor),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    replay: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
    onOutput: vi.fn(() => () => undefined),
    onChanged: vi.fn(() => () => undefined),
  };
}

function repositoryFake(
  markRunningExited: () => Promise<void>,
): DesktopBootstrapRepository {
  return {
    save: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    find: vi.fn(async () => undefined),
    markRunningExited: vi.fn(markRunningExited),
    close: vi.fn(),
  };
}

function outputStoreFake(): TerminalOutputStore {
  return {
    append: vi.fn(),
    readAfter: vi.fn(async () => []),
    readFromCursor: vi.fn(async () => ({
      chunks: [],
      earliestCursor: 0n,
      latestCursor: 0n,
      truncated: false,
    })),
    remove: vi.fn(async () => undefined),
  };
}

function bootstrapBase() {
  return {
    app: { quit: vi.fn() },
    platform: "darwin" as const,
    ipc: { handle: vi.fn(), removeHandler: vi.fn() },
  };
}

describe("bootstrapDesktop", () => {
  it("configures host services before routing terminal IPC", async () => {
    const repository = repositoryFake(async () => undefined);
    const outputStore = outputStoreFake();
    const localManager = managerFake();
    const routedManager = managerFake();
    const configureTerminalServices = vi.fn();
    const createTerminalRouter = vi.fn(() => routedManager);
    const registerIpc = vi.fn(() => vi.fn());

    await bootstrapDesktop({
      ...bootstrapBase(),
      userDataPath: "/data/codra",
      createRepository: vi.fn(() => repository),
      createOutputStore: vi.fn(() => outputStore),
      createPtyFactory: vi.fn(),
      createManager: vi.fn(() => localManager),
      configureTerminalServices,
      createTerminalRouter,
      registerIpc,
      createLifecycle: vi.fn(() => ({ start: vi.fn() })),
      createWindow: vi.fn(),
      getWindowCount: () => 1,
      confirmQuit: vi.fn(),
      reportError: vi.fn(),
      fatal: vi.fn(),
      windows: () => [],
      isTrustedRendererUrl: vi.fn(() => true),
    });

    expect(configureTerminalServices).toHaveBeenCalledWith(
      localManager,
      outputStore,
    );
    expect(createTerminalRouter).toHaveBeenCalledWith(localManager);
    expect(registerIpc).toHaveBeenCalledWith(
      expect.objectContaining({ manager: routedManager }),
    );
    expect(configureTerminalServices.mock.invocationCallOrder[0]).toBeLessThan(
      createTerminalRouter.mock.invocationCallOrder[0]!,
    );
    expect(createTerminalRouter.mock.invocationCallOrder[0]).toBeLessThan(
      registerIpc.mock.invocationCallOrder[0]!,
    );
  });

  it("closes the repository and terminates fatally when stale recovery fails", async () => {
    const staleRecoveryFailure = new Error("database is unavailable");
    const repository = repositoryFake(async () => {
      throw staleRecoveryFailure;
    });
    const reportError = vi.fn();
    const fatal = vi.fn();
    const createManager = vi.fn(managerFake);
    const registerIpc = vi.fn();
    const createWindow = vi.fn();

    await bootstrapDesktop({
      ...bootstrapBase(),
      userDataPath: "/data/codra",
      createRepository: vi.fn(() => repository),
      createOutputStore: vi.fn(),
      createPtyFactory: vi.fn(),
      createManager,
      registerIpc,
      createLifecycle: vi.fn(),
      createWindow,
      getWindowCount: () => 0,
      confirmQuit: vi.fn(),
      reportError,
      fatal,
      windows: () => [],
      isTrustedRendererUrl: vi.fn(() => true),
    });

    expect(repository.close).toHaveBeenCalledOnce();
    expect(createManager).not.toHaveBeenCalled();
    expect(registerIpc).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(staleRecoveryFailure);
    expect(fatal).toHaveBeenCalledWith(staleRecoveryFailure);
  });

  it("unregisters IPC, closes manager sessions, and closes storage after later startup failure", async () => {
    const failure = new Error("lifecycle registration failed");
    const repository = repositoryFake(async () => undefined);
    const manager = managerFake();
    const unregisterIpc = vi.fn();
    const reportError = vi.fn();
    const fatal = vi.fn();

    await bootstrapDesktop({
      ...bootstrapBase(),
      userDataPath: "/data/codra",
      createRepository: vi.fn(() => repository),
      createOutputStore: vi.fn(),
      createPtyFactory: vi.fn(),
      createManager: vi.fn(() => manager),
      registerIpc: vi.fn(() => unregisterIpc),
      createLifecycle: vi.fn(() => ({
        start: () => {
          throw failure;
        },
      })),
      createWindow: vi.fn(),
      getWindowCount: () => 0,
      confirmQuit: vi.fn(),
      reportError,
      fatal,
      windows: () => [],
      isTrustedRendererUrl: vi.fn(() => true),
    });

    expect(unregisterIpc).toHaveBeenCalledOnce();
    expect(manager.closeAll).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(fatal).toHaveBeenCalledWith(failure);
  });
});

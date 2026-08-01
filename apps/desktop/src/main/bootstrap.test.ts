import type { TerminalDescriptor } from "@codra/protocol";
import { describe, expect, it, vi } from "vitest";
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

function bootstrapBase() {
  return {
    app: { quit: vi.fn() },
    platform: "darwin" as const,
    ipc: { handle: vi.fn(), removeHandler: vi.fn() },
  };
}

describe("bootstrapDesktop", () => {
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
    });

    expect(unregisterIpc).toHaveBeenCalledOnce();
    expect(manager.closeAll).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(fatal).toHaveBeenCalledWith(failure);
  });
});

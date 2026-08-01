import { join } from "node:path";
import type {
  PtyFactory,
  TerminalOutputStore,
  TerminalRepository,
} from "./terminal/contracts";
import type {
  DesktopAppLike,
  DesktopLifecycleManager,
  DesktopLifecycleOptions,
} from "./lifecycle";
import type {
  BrowserWindowLike,
  IpcMainLike,
  RegisterTerminalIpcOptions,
  TerminalManagerIpcPort,
} from "./ipc/terminal-ipc";
import { TerminalAdmissionGate } from "./ipc/admission";

export interface DesktopBootstrapRepository extends TerminalRepository {
  close(): void | Promise<void>;
}

export interface DesktopBootstrapManager
  extends TerminalManagerIpcPort, DesktopLifecycleManager {}

export interface DesktopLifecycleInstance {
  start(): void;
}

export interface DesktopBootstrapOptions {
  app: DesktopAppLike;
  userDataPath: string;
  platform: NodeJS.Platform;
  ipc: IpcMainLike;
  windows(): readonly BrowserWindowLike[];
  isTrustedRendererUrl(url: string): boolean;
  getWindowCount(): number;
  createRepository(databasePath: string): DesktopBootstrapRepository;
  createOutputStore(outputPath: string): TerminalOutputStore;
  createPtyFactory(): PtyFactory;
  createManager(
    ptyFactory: PtyFactory,
    repository: TerminalRepository,
    outputStore: TerminalOutputStore,
  ): DesktopBootstrapManager;
  registerIpc(options: RegisterTerminalIpcOptions): () => void;
  createLifecycle(options: DesktopLifecycleOptions): DesktopLifecycleInstance;
  createWindow(): void | Promise<void>;
  startRemoteHost?(): void | Promise<void>;
  stopRemoteHost?(): void | Promise<void>;
  confirmQuit(
    activeTerminals: readonly import("@codra/protocol").TerminalDescriptor[],
  ): Promise<boolean>;
  reportError(error: unknown): void;
  fatal(error: unknown): void;
}

async function runCleanup(
  cleanup: () => void | Promise<void>,
  reportError: (error: unknown) => void,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    reportError(error);
  }
}

export async function bootstrapDesktop(
  options: DesktopBootstrapOptions,
): Promise<void> {
  let repository: DesktopBootstrapRepository | undefined;
  let manager: DesktopBootstrapManager | undefined;
  let unregisterIpc: (() => void) | undefined;
  let remoteHostStarted = false;

  try {
    repository = options.createRepository(
      join(options.userDataPath, "terminals.sqlite3"),
    );
    await repository.markRunningExited(-1);

    const outputStore = options.createOutputStore(
      join(options.userDataPath, "terminal-output"),
    );
    manager = options.createManager(
      options.createPtyFactory(),
      repository,
      outputStore,
    );
    const admission = new TerminalAdmissionGate();
    unregisterIpc = options.registerIpc({
      ipc: options.ipc,
      manager,
      windows: options.windows,
      isTrustedRendererUrl: options.isTrustedRendererUrl,
      admission,
      reportError: options.reportError,
    });
    const lifecycle = options.createLifecycle({
      app: options.app,
      manager,
      platform: options.platform,
      getWindowCount: options.getWindowCount,
      createWindow: options.createWindow,
      confirmQuit: options.confirmQuit,
      closeDatabase: () => repository?.close(),
      closeRemoteHost: options.stopRemoteHost,
      unregisterIpc,
      admission,
      reportError: options.reportError,
    });
    lifecycle.start();
    await options.createWindow();
    if (options.startRemoteHost) {
      remoteHostStarted = true;
      void Promise.resolve(options.startRemoteHost()).catch(
        options.reportError,
      );
    }
  } catch (error) {
    options.reportError(error);
    if (remoteHostStarted && options.stopRemoteHost) {
      await runCleanup(options.stopRemoteHost, options.reportError);
    }
    if (unregisterIpc) {
      await runCleanup(unregisterIpc, options.reportError);
    }
    if (manager) {
      await runCleanup(() => manager?.closeAll(), options.reportError);
    }
    if (repository) {
      await runCleanup(() => repository?.close(), options.reportError);
    }
    options.fatal(error);
  }
}

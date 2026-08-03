import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { bootstrapDesktop } from "./bootstrap";
import { registerTerminalIpc } from "./ipc/terminal-ipc";
import { registerRemoteIpc } from "./ipc/remote-ipc";
import { DesktopLifecycle } from "./lifecycle";
import { TerminalManager } from "./terminal/manager";
import { NodePtyFactory } from "./terminal/node-pty";
import {
  createAgentRuntimeDependencies,
  listAgentRuntimes,
  resolveAgentCommand,
  resolveAgentSetupCommand,
} from "./terminal/agent-runtime";
import { FileTerminalOutputStore } from "./terminal/scrollback";
import { SqliteTerminalRepository } from "./terminal/sqlite";
import {
  createRendererUrlPolicy,
  loadTrustedRenderer,
  type RendererUrlPolicy,
} from "./renderer-security";
import { startSingleInstanceApplication } from "./single-instance";
import { buildBrowserWindowOptions } from "./window-options";
import { RemoteHostController } from "./remote/host-controller";
import {
  createNativePeerConnection,
  type NativeDataChannelModule,
} from "./remote/native-peer";
import { ProxyTerminalRouter } from "./remote/proxy-terminal-router";
import { WorkspaceService } from "./remote/workspace-service";

let mainWindow: BrowserWindow | undefined;
let rendererUrlPolicy: RendererUrlPolicy | undefined;
const requireFromMain = createRequire(__filename);

const isolatedUserDataPath = process.env.CODRA_USER_DATA_DIR;
if (
  isolatedUserDataPath &&
  (!app.isPackaged || process.env.CODRA_PACKAGED_SMOKE === "1")
) {
  app.setPath("userData", isolatedUserDataPath);
}

async function createWindow(): Promise<void> {
  if (!rendererUrlPolicy) {
    throw new Error("Renderer URL policy is not initialized");
  }
  const window = new BrowserWindow(
    buildBrowserWindowOptions(join(__dirname, "../preload/index.js")),
  );
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });

  try {
    await loadTrustedRenderer(window, rendererUrlPolicy);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

async function confirmQuitWithActiveTerminals(
  activeTerminalCount: number,
): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Quit"],
    defaultId: 0,
    cancelId: 0,
    title: "Quit Codra?",
    message: `Close ${activeTerminalCount} active terminal${activeTerminalCount === 1 ? "" : "s"}?`,
    detail: "Their running processes will be terminated.",
  });
  return result.response === 1;
}

function reportFatal(error: unknown): void {
  console.error("Codra failed to start", error);
  app.exit(1);
}

function resolveBundledNpmCliPath(): string {
  return join(
    dirname(requireFromMain.resolve("npm/package.json")),
    "bin",
    "npm-cli.js",
  );
}

async function startPrimaryInstance(): Promise<void> {
  rendererUrlPolicy = createRendererUrlPolicy({
    rendererHtmlPath: join(__dirname, "../renderer/index.html"),
    isPackaged: app.isPackaged,
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
  });

  const remoteHost = new RemoteHostController({
    userDataPath: app.getPath("userData"),
    reportError: (error) => console.error("Remote host error", error),
    createPeer: (peerName, iceServers, options) =>
      createNativePeerConnection(
        requireFromMain("node-datachannel") as NativeDataChannelModule,
        peerName,
        iceServers,
        options,
      ),
    ensureWindow: async () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        return;
      }
      await createWindow();
    },
  });
  registerRemoteIpc({
    ipc: ipcMain,
    controller: remoteHost,
    windows: () => BrowserWindow.getAllWindows(),
    isTrustedRendererUrl: rendererUrlPolicy.isTrusted,
    reportError: (error) => console.error("Remote IPC error", error),
  });

  const agentRuntimeDependencies = createAgentRuntimeDependencies({
    managedInstallDirectory: join(app.getPath("userData"), "agent-tools"),
    electronExecutable: process.execPath,
    npmCliPath: resolveBundledNpmCliPath(),
    setupRunnerPath: join(__dirname, "agent-setup-runner.js"),
  });

  await bootstrapDesktop({
    app,
    userDataPath: app.getPath("userData"),
    platform: process.platform,
    ipc: ipcMain,
    windows: () => BrowserWindow.getAllWindows(),
    isTrustedRendererUrl: rendererUrlPolicy.isTrusted,
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    createRepository: (databasePath) =>
      new SqliteTerminalRepository(databasePath),
    createOutputStore: (outputPath) => new FileTerminalOutputStore(outputPath),
    createPtyFactory: () =>
      new NodePtyFactory(
        (launch) => resolveAgentCommand(launch, agentRuntimeDependencies),
        (request) =>
          resolveAgentSetupCommand(request, agentRuntimeDependencies),
      ),
    createManager: (ptyFactory, repository, outputStore) =>
      new TerminalManager(ptyFactory, repository, outputStore),
    configureTerminalServices: (manager, outputStore) => {
      const readFromCursor = outputStore.readFromCursor?.bind(outputStore);
      if (!readFromCursor) {
        throw new Error("TERMINAL_CURSOR_OUTPUT_UNAVAILABLE");
      }
      remoteHost.configureHostServices({
        workspace: new WorkspaceService(),
        listRuntimes: () => listAgentRuntimes(agentRuntimeDependencies),
        manager,
        outputStore: { readFromCursor },
      });
    },
    createTerminalRouter: (manager) => {
      const router = new ProxyTerminalRouter(manager, (target) =>
        remoteHost.peerFor(target),
      );
      remoteHost.onTargetsChanged((targets) => {
        for (const entry of targets) {
          if (entry.target.kind !== "remote" || entry.state !== "connected") {
            continue;
          }
          void router
            .resume(entry.target)
            .catch((error) => console.error("Remote resume failed", error));
        }
      });
      return router;
    },
    registerIpc: (options) =>
      registerTerminalIpc({
        ...options,
        listAgents: () => listAgentRuntimes(agentRuntimeDependencies),
        chooseDirectory: async (parentWindow, defaultPath) => {
          const result = await dialog.showOpenDialog(
            parentWindow as BrowserWindow,
            {
              title: "Choose agent working directory",
              buttonLabel: "Choose",
              defaultPath,
              properties: ["openDirectory", "createDirectory"],
            },
          );
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        openExternal: (url) => shell.openExternal(url),
      }),
    createLifecycle: (options) => new DesktopLifecycle(options),
    createWindow,
    stopRemoteHost: () => remoteHost.stop(),
    confirmQuit: (activeTerminals) =>
      confirmQuitWithActiveTerminals(activeTerminals.length),
    reportError: (error) => console.error("Desktop lifecycle error", error),
    fatal: reportFatal,
  });
}

startSingleInstanceApplication({
  app,
  getWindow: () => mainWindow,
  createWindow,
  startPrimary: startPrimaryInstance,
  reportStartupError: reportFatal,
  reportWindowError: (error) =>
    console.error("Second-instance window error", error),
});

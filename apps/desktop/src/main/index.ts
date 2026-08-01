import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { bootstrapDesktop } from "./bootstrap";
import { registerTerminalIpc } from "./ipc/terminal-ipc";
import { DesktopLifecycle } from "./lifecycle";
import { TerminalManager } from "./terminal/manager";
import { NodePtyFactory } from "./terminal/node-pty";
import { FileTerminalOutputStore } from "./terminal/scrollback";
import { SqliteTerminalRepository } from "./terminal/sqlite";
import { buildBrowserWindowOptions } from "./window-options";

let mainWindow: BrowserWindow | undefined;

const isolatedUserDataPath = process.env.CODRA_USER_DATA_DIR;
if (
  isolatedUserDataPath &&
  (!app.isPackaged || process.env.CODRA_PACKAGED_SMOKE === "1")
) {
  app.setPath("userData", isolatedUserDataPath);
}

async function createWindow(): Promise<void> {
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
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl) {
      await window.loadURL(devServerUrl);
    } else {
      await window.loadFile(join(__dirname, "../renderer/index.html"));
    }
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

void app
  .whenReady()
  .then(() =>
    bootstrapDesktop({
      app,
      userDataPath: app.getPath("userData"),
      platform: process.platform,
      ipc: ipcMain,
      windows: () => BrowserWindow.getAllWindows(),
      getWindowCount: () => BrowserWindow.getAllWindows().length,
      createRepository: (databasePath) =>
        new SqliteTerminalRepository(databasePath),
      createOutputStore: (outputPath) =>
        new FileTerminalOutputStore(outputPath),
      createPtyFactory: () => new NodePtyFactory(),
      createManager: (ptyFactory, repository, outputStore) =>
        new TerminalManager(ptyFactory, repository, outputStore),
      registerIpc: registerTerminalIpc,
      createLifecycle: (options) => new DesktopLifecycle(options),
      createWindow,
      confirmQuit: (activeTerminals) =>
        confirmQuitWithActiveTerminals(activeTerminals.length),
      reportError: (error) => console.error("Desktop lifecycle error", error),
      fatal: reportFatal,
    }),
  )
  .catch(reportFatal);

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { registerTerminalIpc } from "./ipc/terminal-ipc";
import { DesktopLifecycle } from "./lifecycle";
import { TerminalManager } from "./terminal/manager";
import { NodePtyFactory } from "./terminal/node-pty";
import { FileTerminalOutputStore } from "./terminal/scrollback";
import { SqliteTerminalRepository } from "./terminal/sqlite";
import { buildBrowserWindowOptions } from "./window-options";

function createWindow(): void {
  const window = new BrowserWindow(
    buildBrowserWindowOptions(join(__dirname, "../preload/index.js")),
  );

  window.once("ready-to-show", () => {
    window.show();
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
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

app.whenReady().then(async () => {
  const userDataPath = app.getPath("userData");
  const repository = new SqliteTerminalRepository(
    join(userDataPath, "terminals.sqlite3"),
  );
  await repository.markRunningExited(-1);

  const manager = new TerminalManager(
    new NodePtyFactory(),
    repository,
    new FileTerminalOutputStore(join(userDataPath, "terminal-output")),
  );
  const unregisterIpc = registerTerminalIpc({
    ipc: ipcMain,
    manager,
    windows: () => BrowserWindow.getAllWindows(),
  });
  const lifecycle = new DesktopLifecycle({
    app,
    manager,
    platform: process.platform,
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    createWindow,
    confirmQuit: (activeTerminals) =>
      confirmQuitWithActiveTerminals(activeTerminals.length),
    closeDatabase: () => repository.close(),
    unregisterIpc,
    reportError: (error) => console.error("Desktop lifecycle error", error),
  });
  lifecycle.start();
  createWindow();
});

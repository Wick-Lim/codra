import { app, BrowserWindow } from "electron";
import { join } from "node:path";
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

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./desktop-api";

contextBridge.exposeInMainWorld("codra", createDesktopApi(ipcRenderer));

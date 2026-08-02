import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import { CODRA_PROJECT_ID } from "@codra/protocol";

export interface DesktopAuthParentWindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface DesktopAuthWindowLike {
  webContents: {
    on(
      event: "will-navigate" | "will-redirect" | "did-navigate",
      listener: (event: { preventDefault(): void }, url: string) => void,
    ): unknown;
    setWindowOpenHandler(handler: () => { action: "deny" }): unknown;
  };
  once(event: "ready-to-show" | "closed", listener: () => void): unknown;
  loadURL(url: string): Promise<unknown>;
  show(): void;
  close(): void;
  isDestroyed(): boolean;
  setMenuBarVisibility(visible: boolean): void;
}

export interface DesktopAuthWindowOptions {
  parent: DesktopAuthParentWindowLike;
  modal: boolean;
  show: boolean;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  title: string;
  autoHideMenuBar: boolean;
  backgroundColor: string;
  webPreferences: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
    webSecurity: boolean;
    allowRunningInsecureContent: boolean;
  };
}

export interface DesktopAuthWindowDependencies {
  createWindow(options: DesktopAuthWindowOptions): DesktopAuthWindowLike;
}

export interface OpenDesktopAuthWindowOptions {
  authHandlerUrl?: string;
  dependencies?: DesktopAuthWindowDependencies;
  parent?: DesktopAuthParentWindowLike;
  signal?: AbortSignal;
}

const productionDependencies: DesktopAuthWindowDependencies = {
  createWindow: (options) =>
    new BrowserWindow(
      options as BrowserWindowConstructorOptions,
    ) as unknown as DesktopAuthWindowLike,
};

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isGoogleAccountUrl(value: string): boolean {
  const url = parseUrl(value);
  return (
    url?.protocol === "https:" &&
    url.hostname === "accounts.google.com" &&
    url.username === "" &&
    url.password === ""
  );
}

function isLoopbackCallback(value: string, callbackUrl: URL): boolean {
  const url = parseUrl(value);
  return (
    url?.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port === callbackUrl.port &&
    url.pathname === callbackUrl.pathname &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function isValidAuthHandlerTarget(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === `${CODRA_PROJECT_ID}.firebaseapp.com` &&
    url.pathname === "/__/auth/handler" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function isAuthHandlerNavigation(value: string, authHandlerUrl: URL): boolean {
  const url = parseUrl(value);
  return (
    url?.protocol === authHandlerUrl.protocol &&
    url.hostname === authHandlerUrl.hostname &&
    url.port === authHandlerUrl.port &&
    url.pathname === authHandlerUrl.pathname &&
    url.username === "" &&
    url.password === ""
  );
}

function isValidCallbackTarget(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.pathname === "/auth/callback" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function callbackNavigationError(
  value: string,
  callbackUrl: URL,
): Error | undefined {
  const url = parseUrl(value);
  if (!url || !isLoopbackCallback(value, callbackUrl))
    return new Error("DESKTOP_LOGIN_CALLBACK_INVALID");
  if (url.searchParams.has("error"))
    return new Error("DESKTOP_LOGIN_CANCELLED");
  const codes = url.searchParams.getAll("code");
  const states = url.searchParams.getAll("state");
  if (
    codes.length !== 1 ||
    codes[0] === "" ||
    states.length !== 1 ||
    states[0] === ""
  ) {
    return new Error("DESKTOP_LOGIN_CALLBACK_INVALID");
  }
  return undefined;
}

function revealParent(parent: DesktopAuthParentWindowLike | undefined): void {
  if (!parent || parent.isDestroyed()) return;
  if (parent.isMinimized()) parent.restore();
  if (!parent.isVisible()) parent.show();
  parent.focus();
}

export function openDesktopAuthWindow(
  authUrl: string,
  callbackUrlValue: string,
  options: OpenDesktopAuthWindowOptions = {},
): Promise<void> {
  const dependencies = options.dependencies ?? productionDependencies;
  const callbackUrl = parseUrl(callbackUrlValue);
  const authHandlerUrl = options.authHandlerUrl
    ? parseUrl(options.authHandlerUrl)
    : undefined;
  if (
    !isGoogleAccountUrl(authUrl) ||
    !callbackUrl ||
    !isValidCallbackTarget(callbackUrl) ||
    !isLoopbackCallback(callbackUrlValue, callbackUrl) ||
    !authHandlerUrl ||
    !isValidAuthHandlerTarget(authHandlerUrl)
  ) {
    return Promise.reject(new Error("DESKTOP_LOGIN_AUTH_URL_INVALID"));
  }

  const parent = options.parent;
  if (!parent || parent.isDestroyed()) {
    return Promise.reject(new Error("DESKTOP_LOGIN_PARENT_WINDOW_MISSING"));
  }
  const child = dependencies.createWindow({
    parent,
    modal: true,
    show: false,
    width: 520,
    height: 720,
    minWidth: 440,
    minHeight: 560,
    title: "Sign in to CODRA",
    autoHideMenuBar: true,
    backgroundColor: "#111722",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  child.setMenuBarVisibility(false);
  child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return new Promise<void>((resolve, reject) => {
    let callbackReached = false;
    let callbackError: Error | undefined;
    let loadError: unknown;
    let settled = false;

    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      revealParent(parent);
      if (error) reject(error);
      else resolve();
    };
    const closeChild = (): void => {
      if (!child.isDestroyed()) child.close();
    };
    const onAbort = (): void => closeChild();
    const guardNavigation = (
      event: { preventDefault(): void },
      url: string,
    ): void => {
      if (
        !isGoogleAccountUrl(url) &&
        !isAuthHandlerNavigation(url, authHandlerUrl) &&
        !isLoopbackCallback(url, callbackUrl)
      )
        event.preventDefault();
    };

    child.webContents.on("will-navigate", guardNavigation);
    child.webContents.on("will-redirect", guardNavigation);
    child.webContents.on("did-navigate", (_event, url) => {
      if (!isLoopbackCallback(url, callbackUrl)) return;
      callbackReached = true;
      callbackError = callbackNavigationError(url, callbackUrl);
      closeChild();
    });
    child.once("ready-to-show", () => {
      if (!child.isDestroyed()) child.show();
    });
    child.once("closed", () => {
      if (loadError) {
        finish(loadError);
        return;
      }
      if (callbackError) {
        finish(callbackError);
        return;
      }
      if (!callbackReached) {
        finish(new Error("DESKTOP_LOGIN_CANCELLED"));
        return;
      }
      finish();
    });

    if (options.signal?.aborted) {
      closeChild();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void child.loadURL(authUrl).catch((error: unknown) => {
      loadError = error;
      closeChild();
    });
  });
}

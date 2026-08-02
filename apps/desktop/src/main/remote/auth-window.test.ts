import { describe, expect, it, vi } from "vitest";
import {
  openDesktopAuthWindow,
  type DesktopAuthWindowDependencies,
  type DesktopAuthWindowLike,
} from "./auth-window";

type WindowEvent = "ready-to-show" | "closed";
type NavigationEvent = "will-navigate" | "will-redirect" | "did-navigate";

function createHarness() {
  const windowListeners = new Map<WindowEvent, () => void>();
  const navigationListeners = new Map<
    NavigationEvent,
    (event: { preventDefault(): void }, url: string) => void
  >();
  const parent = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    isVisible: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  let destroyed = false;
  const child = {
    webContents: {
      on: vi.fn(
        (
          event: NavigationEvent,
          listener: (event: { preventDefault(): void }, url: string) => void,
        ) => {
          navigationListeners.set(event, listener);
        },
      ),
      setWindowOpenHandler: vi.fn(),
    },
    once: vi.fn((event: WindowEvent, listener: () => void) => {
      windowListeners.set(event, listener);
    }),
    loadURL: vi.fn(async () => undefined),
    show: vi.fn(),
    close: vi.fn(() => {
      destroyed = true;
      windowListeners.get("closed")?.();
    }),
    isDestroyed: vi.fn(() => destroyed),
    setMenuBarVisibility: vi.fn(),
  } satisfies DesktopAuthWindowLike;
  const createWindow = vi.fn(() => child);
  const dependencies: DesktopAuthWindowDependencies = {
    getParentWindow: () => parent,
    createWindow,
  };

  return {
    child,
    createWindow,
    dependencies,
    navigationListeners,
    parent,
    windowListeners,
  };
}

describe("desktop OAuth child window", () => {
  it("rejects a provider URL outside the Google account origin", async () => {
    const harness = createHarness();

    await expect(
      openDesktopAuthWindow(
        "https://example.com/fake-google-login",
        "http://127.0.0.1:45831/auth/callback",
        { dependencies: harness.dependencies },
      ),
    ).rejects.toThrow("DESKTOP_LOGIN_AUTH_URL_INVALID");
    expect(harness.createWindow).not.toHaveBeenCalled();
  });

  it("rejects a callback target outside CODRA's fixed loopback route", async () => {
    const harness = createHarness();

    await expect(
      openDesktopAuthWindow(
        "https://accounts.google.com/o/oauth2/v2/auth",
        "http://127.0.0.1:45831/not-codra",
        { dependencies: harness.dependencies },
      ),
    ).rejects.toThrow("DESKTOP_LOGIN_AUTH_URL_INVALID");
    expect(harness.createWindow).not.toHaveBeenCalled();
  });

  it("opens Google sign-in as a locked modal child without browser chrome", async () => {
    const harness = createHarness();
    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=codra";
    const callbackUrl = "http://127.0.0.1:45831/auth/callback";
    const opened = openDesktopAuthWindow(authUrl, callbackUrl, {
      dependencies: harness.dependencies,
    });

    expect(harness.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: harness.parent,
        modal: true,
        show: false,
        autoHideMenuBar: true,
        title: "Sign in to CODRA",
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        }),
      }),
    );
    expect(harness.child.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(harness.child.loadURL).toHaveBeenCalledWith(authUrl);
    harness.windowListeners.get("ready-to-show")?.();
    expect(harness.child.show).toHaveBeenCalledOnce();

    harness.navigationListeners.get("did-navigate")?.(
      { preventDefault: vi.fn() },
      `${callbackUrl}?code=google-code&state=opaque-state`,
    );
    await expect(opened).resolves.toBeUndefined();
    expect(harness.child.close).toHaveBeenCalledOnce();
    expect(harness.parent.restore).toHaveBeenCalledOnce();
    expect(harness.parent.show).toHaveBeenCalledOnce();
    expect(harness.parent.focus).toHaveBeenCalledOnce();
  });

  it("blocks top-level navigation outside Google and the exact loopback callback", async () => {
    const harness = createHarness();
    const callbackUrl = "http://127.0.0.1:45831/auth/callback";
    const opened = openDesktopAuthWindow(
      "https://accounts.google.com/o/oauth2/v2/auth",
      callbackUrl,
      { dependencies: harness.dependencies },
    );
    const preventDefault = vi.fn();

    harness.navigationListeners.get("will-navigate")?.(
      { preventDefault },
      "https://example.com/phishing",
    );
    harness.navigationListeners.get("will-redirect")?.(
      { preventDefault },
      `${callbackUrl}?code=google-code&state=opaque-state`,
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    harness.navigationListeners.get("did-navigate")?.(
      { preventDefault: vi.fn() },
      `${callbackUrl}?code=google-code&state=opaque-state`,
    );
    await opened;
  });

  it("rejects immediately when the user closes the provider window", async () => {
    const harness = createHarness();
    const opened = openDesktopAuthWindow(
      "https://accounts.google.com/o/oauth2/v2/auth",
      "http://127.0.0.1:45831/auth/callback",
      { dependencies: harness.dependencies },
    );

    harness.windowListeners.get("closed")?.();

    await expect(opened).rejects.toThrow("DESKTOP_LOGIN_CANCELLED");
    expect(harness.parent.focus).toHaveBeenCalledOnce();
  });

  it("rejects an OAuth error callback instead of treating the route as success", async () => {
    const harness = createHarness();
    const callbackUrl = "http://127.0.0.1:45831/auth/callback";
    const opened = openDesktopAuthWindow(
      "https://accounts.google.com/o/oauth2/v2/auth",
      callbackUrl,
      { dependencies: harness.dependencies },
    );

    harness.navigationListeners.get("did-navigate")?.(
      { preventDefault: vi.fn() },
      `${callbackUrl}?error=access_denied&state=opaque-state`,
    );

    await expect(opened).rejects.toThrow("DESKTOP_LOGIN_CANCELLED");
    expect(harness.child.close).toHaveBeenCalledOnce();
    expect(harness.parent.focus).toHaveBeenCalledOnce();
  });

  it("closes the child when the login deadline aborts", async () => {
    const harness = createHarness();
    const abort = new AbortController();
    const opened = openDesktopAuthWindow(
      "https://accounts.google.com/o/oauth2/v2/auth",
      "http://127.0.0.1:45831/auth/callback",
      { dependencies: harness.dependencies, signal: abort.signal },
    );

    abort.abort();

    await expect(opened).rejects.toThrow("DESKTOP_LOGIN_CANCELLED");
    expect(harness.child.close).toHaveBeenCalledOnce();
  });
});

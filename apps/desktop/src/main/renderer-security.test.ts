import { describe, expect, it, vi } from "vitest";
import {
  createRendererUrlPolicy,
  installRendererNavigationGuards,
  loadTrustedRenderer,
} from "./renderer-security";

interface NavigationEvent {
  url: string;
  isMainFrame: boolean;
  preventDefault(): void;
}

function createWebContentsHarness() {
  const listeners = new Map<string, (event: NavigationEvent) => void>();
  let openHandler: (() => { action: "deny" | "allow" }) | undefined;
  const webContents = {
    on: vi.fn((event: string, listener: (details: NavigationEvent) => void) => {
      listeners.set(event, listener);
    }),
    setWindowOpenHandler: vi.fn(
      (handler: () => { action: "deny" | "allow" }) => {
        openHandler = handler;
      },
    ),
  };

  return {
    webContents,
    navigate(eventName: string, url: string, isMainFrame = true) {
      const preventDefault = vi.fn();
      listeners.get(eventName)?.({ url, isMainFrame, preventDefault });
      return preventDefault;
    },
    openWindow() {
      if (!openHandler) throw new Error("window-open handler not registered");
      return openHandler();
    },
  };
}

describe("renderer URL security", () => {
  it("allows only the exact packaged renderer file entry", () => {
    const policy = createRendererUrlPolicy({
      rendererHtmlPath:
        "/Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/index.html",
      isPackaged: true,
      devServerUrl: "https://attacker.example/renderer",
    });

    expect(
      policy.isTrusted(
        "file:///Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/index.html",
      ),
    ).toBe(true);
    expect(
      policy.isTrusted(
        "file:///Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/other.html",
      ),
    ).toBe(false);
    expect(
      policy.isTrusted(
        "file:///Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/index.html?redirect=https://attacker.example",
      ),
    ).toBe(false);
    expect(policy.isTrusted("https://attacker.example/index.html")).toBe(false);
    expect(policy.entryUrl).toBe(
      "file:///Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/index.html",
    );
  });

  it("allows the explicit development origin without trusting another port or scheme", () => {
    const policy = createRendererUrlPolicy({
      rendererHtmlPath: "/unused/index.html",
      isPackaged: false,
      devServerUrl: "http://127.0.0.1:5173/app",
    });

    expect(policy.isTrusted("http://127.0.0.1:5173/")).toBe(true);
    expect(policy.isTrusted("http://127.0.0.1:5173/src/main.tsx")).toBe(true);
    expect(policy.isTrusted("http://127.0.0.1:4173/")).toBe(false);
    expect(policy.isTrusted("https://127.0.0.1:5173/")).toBe(false);
  });

  it("rejects a non-HTTP development entry", () => {
    expect(() =>
      createRendererUrlPolicy({
        rendererHtmlPath: "/unused/index.html",
        isPackaged: false,
        devServerUrl: "file:///tmp/untrusted.html",
      }),
    ).toThrow("Development renderer URL must use HTTP or HTTPS");
  });

  it("blocks unexpected navigation, redirects, subframes, and new windows", () => {
    const policy = createRendererUrlPolicy({
      rendererHtmlPath: "/unused/index.html",
      isPackaged: false,
      devServerUrl: "http://127.0.0.1:5173/",
    });
    const harness = createWebContentsHarness();
    installRendererNavigationGuards(harness.webContents, policy);

    expect(
      harness.navigate("will-navigate", "https://attacker.example/"),
    ).toHaveBeenCalledOnce();
    expect(
      harness.navigate("will-navigate", "http://127.0.0.1:5173/workspace"),
    ).not.toHaveBeenCalled();
    expect(
      harness.navigate(
        "will-frame-navigate",
        "http://127.0.0.1:5173/embedded",
        false,
      ),
    ).toHaveBeenCalledOnce();
    expect(
      harness.navigate("will-redirect", "https://attacker.example/redirect"),
    ).toHaveBeenCalledOnce();
    expect(harness.openWindow()).toEqual({ action: "deny" });
  });

  it("installs guards before createWindow loads the trusted entry", async () => {
    const policy = createRendererUrlPolicy({
      rendererHtmlPath:
        "/Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/index.html",
      isPackaged: true,
    });
    const calls: string[] = [];
    const window = {
      webContents: {
        on: vi.fn((event: string) => calls.push(`guard:${event}`)),
        setWindowOpenHandler: vi.fn(() => calls.push("guard:window-open")),
      },
      loadURL: vi.fn(async (url: string) => {
        calls.push(`load:${url}`);
      }),
    };

    await loadTrustedRenderer(window, policy);

    expect(window.loadURL).toHaveBeenCalledWith(
      "file:///Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/index.html",
    );
    expect(calls.at(-1)).toBe(
      "load:file:///Applications/CODRA.app/Contents/Resources/app.asar/out/renderer/index.html",
    );
  });
});

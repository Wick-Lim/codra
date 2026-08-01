import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface RendererUrlPolicy {
  readonly entryUrl: string;
  isTrusted(url: string): boolean;
}

export interface RendererUrlPolicyOptions {
  rendererHtmlPath: string;
  isPackaged: boolean;
  devServerUrl?: string;
}

interface RendererNavigationEvent {
  readonly url: string;
  readonly isMainFrame: boolean;
  preventDefault(): void;
}

type RendererNavigationEventName =
  "will-frame-navigate" | "will-navigate" | "will-redirect";

interface RendererWebContentsGuardTarget {
  on(
    event: RendererNavigationEventName,
    listener: (event: RendererNavigationEvent) => void,
  ): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

interface RendererWindowLoadTarget {
  readonly webContents: RendererWebContentsGuardTarget;
  loadURL(url: string): Promise<unknown>;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function createRendererUrlPolicy({
  rendererHtmlPath,
  isPackaged,
  devServerUrl,
}: RendererUrlPolicyOptions): RendererUrlPolicy {
  if (!isPackaged && devServerUrl) {
    const entry = new URL(devServerUrl);
    if (entry.protocol !== "http:" && entry.protocol !== "https:") {
      throw new Error("Development renderer URL must use HTTP or HTTPS");
    }

    return {
      entryUrl: entry.href,
      isTrusted: (url) => parseUrl(url)?.origin === entry.origin,
    };
  }

  const entryUrl = pathToFileURL(resolve(rendererHtmlPath)).href;
  return {
    entryUrl,
    isTrusted: (url) => parseUrl(url)?.href === entryUrl,
  };
}

export function installRendererNavigationGuards(
  webContents: RendererWebContentsGuardTarget,
  policy: RendererUrlPolicy,
): void {
  const blockUnexpectedNavigation = (event: RendererNavigationEvent) => {
    if (!event.isMainFrame || !policy.isTrusted(event.url)) {
      event.preventDefault();
    }
  };

  webContents.on("will-frame-navigate", blockUnexpectedNavigation);
  webContents.on("will-navigate", blockUnexpectedNavigation);
  webContents.on("will-redirect", blockUnexpectedNavigation);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export async function loadTrustedRenderer(
  window: RendererWindowLoadTarget,
  policy: RendererUrlPolicy,
): Promise<void> {
  installRendererNavigationGuards(window.webContents, policy);
  await window.loadURL(policy.entryUrl);
}

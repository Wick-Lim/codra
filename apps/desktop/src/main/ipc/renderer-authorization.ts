interface IpcSenderFrameLike {
  readonly url: string;
}

interface IpcSenderWebContentsLike {
  readonly mainFrame: IpcSenderFrameLike;
  isDestroyed(): boolean;
  getURL(): string;
  send(channel: string, payload: unknown): void;
}

interface IpcInvokeEventLike {
  readonly sender?: IpcSenderWebContentsLike;
  readonly senderFrame?: IpcSenderFrameLike | null;
}

export interface BrowserWindowLike {
  isDestroyed?(): boolean;
  readonly webContents?: IpcSenderWebContentsLike;
}

export function assertAuthorizedRenderer(
  rawEvent: unknown,
  windows: () => readonly BrowserWindowLike[],
  isTrustedRendererUrl: (url: string) => boolean,
): void {
  try {
    const event = rawEvent as IpcInvokeEventLike;
    const sender = event?.sender;
    const senderFrame = event?.senderFrame;
    if (
      !sender ||
      sender.isDestroyed() ||
      !senderFrame ||
      senderFrame !== sender.mainFrame ||
      !isTrustedRendererUrl(sender.getURL()) ||
      !isTrustedRendererUrl(senderFrame.url)
    ) {
      throw new Error("Unauthorized terminal IPC sender");
    }

    const ownedByLiveWindow = windows().some(
      (window) =>
        !window.isDestroyed?.() &&
        window.webContents === sender &&
        !window.webContents.isDestroyed(),
    );
    if (!ownedByLiveWindow) {
      throw new Error("Unauthorized terminal IPC sender");
    }
  } catch {
    throw new Error("Unauthorized terminal IPC sender");
  }
}

import {
  IPC_CHANNELS,
  RemoteHostStatusSchema,
  type RemoteHostStatus,
} from "@codra/protocol";
import {
  assertAuthorizedRenderer,
  type BrowserWindowLike,
} from "./renderer-authorization";
import type { IpcMainLike } from "./terminal-ipc";

export interface RemoteHostControllerPort {
  getStatus(): RemoteHostStatus;
  login(): Promise<RemoteHostStatus>;
  onStatusChanged(listener: (status: RemoteHostStatus) => void): () => void;
}

export interface RegisterRemoteIpcOptions {
  ipc: IpcMainLike;
  controller: RemoteHostControllerPort;
  windows(): readonly BrowserWindowLike[];
  isTrustedRendererUrl(url: string): boolean;
  reportError?(error: unknown): void;
}

function sendToLiveWindows(
  windows: () => readonly BrowserWindowLike[],
  isTrustedRendererUrl: (url: string) => boolean,
  status: RemoteHostStatus,
  reportError: (error: unknown) => void,
): void {
  const payload = RemoteHostStatusSchema.parse(status);
  for (const window of windows()) {
    try {
      if (window.isDestroyed?.()) continue;
      const webContents = window.webContents;
      if (!webContents || webContents.isDestroyed()) continue;
      if (
        !isTrustedRendererUrl(webContents.getURL()) ||
        !isTrustedRendererUrl(webContents.mainFrame.url)
      ) {
        continue;
      }
      webContents.send(IPC_CHANNELS.remoteState, payload);
    } catch (error) {
      reportError(error);
    }
  }
}

export function registerRemoteIpc({
  ipc,
  controller,
  windows,
  isTrustedRendererUrl,
  reportError = (error) => console.error("Remote IPC error", error),
}: RegisterRemoteIpcOptions): () => void {
  const authorize = (event: unknown): void =>
    assertAuthorizedRenderer(event, windows, isTrustedRendererUrl);
  const registrations: readonly [string, (event: unknown) => unknown][] = [
    [
      IPC_CHANNELS.remoteGetState,
      (event) => {
        authorize(event);
        return RemoteHostStatusSchema.parse(controller.getStatus());
      },
    ],
    [
      IPC_CHANNELS.remoteLogin,
      async (event) => {
        authorize(event);
        return RemoteHostStatusSchema.parse(await controller.login());
      },
    ],
  ];
  const registeredChannels: string[] = [];
  let unsubscribe: (() => void) | undefined;
  try {
    for (const [channel, handler] of registrations) {
      ipc.handle(channel, handler);
      registeredChannels.push(channel);
    }
    unsubscribe = controller.onStatusChanged((status) =>
      sendToLiveWindows(
        windows,
        isTrustedRendererUrl,
        status,
        reportError,
      ),
    );
  } catch (error) {
    for (const channel of registeredChannels) ipc.removeHandler(channel);
    unsubscribe?.();
    throw error;
  }

  return () => {
    for (const [channel] of registrations) ipc.removeHandler(channel);
    unsubscribe?.();
  };
}

import {
  IPC_CHANNELS,
  RemoteAccountStatusSchema,
  RemoteAuthProviderSchema,
  RemoteHostStatusSchema,
  type RemoteAccountStatus,
  type RemoteAuthProvider,
  type RemoteHostStatus,
} from "@codra/protocol";
import {
  assertAuthorizedRenderer,
  type BrowserWindowLike,
} from "./renderer-authorization";
import type { IpcMainLike } from "./terminal-ipc";

type RemoteIpcHandler = (event: unknown, payload?: unknown) => unknown;

export interface RemoteHostControllerPort {
  getStatus(): RemoteHostStatus;
  getAccountStatus(): RemoteAccountStatus;
  login(provider: RemoteAuthProvider): Promise<RemoteAccountStatus>;
  activate(): Promise<RemoteHostStatus>;
  deactivate(): Promise<RemoteHostStatus>;
  onStatusChanged(listener: (status: RemoteHostStatus) => void): () => void;
  onAccountStatusChanged(
    listener: (status: RemoteAccountStatus) => void,
  ): () => void;
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

function sendAccountStatusToLiveWindows(
  windows: () => readonly BrowserWindowLike[],
  isTrustedRendererUrl: (url: string) => boolean,
  status: RemoteAccountStatus,
  reportError: (error: unknown) => void,
): void {
  const payload = RemoteAccountStatusSchema.parse(status);
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
      webContents.send(IPC_CHANNELS.remoteAuthState, payload);
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
  const registrations: readonly [string, RemoteIpcHandler][] = [
    [
      IPC_CHANNELS.remoteGetState,
      (event) => {
        authorize(event);
        return RemoteHostStatusSchema.parse(controller.getStatus());
      },
    ],
    [
      IPC_CHANNELS.remoteGetAuthState,
      (event) => {
        authorize(event);
        return RemoteAccountStatusSchema.parse(controller.getAccountStatus());
      },
    ],
    [
      IPC_CHANNELS.remoteLogin,
      async (event, provider) => {
        authorize(event);
        return RemoteAccountStatusSchema.parse(
          await controller.login(RemoteAuthProviderSchema.parse(provider)),
        );
      },
    ],
    [
      IPC_CHANNELS.remoteActivate,
      async (event) => {
        authorize(event);
        return RemoteHostStatusSchema.parse(await controller.activate());
      },
    ],
    [
      IPC_CHANNELS.remoteDeactivate,
      async (event) => {
        authorize(event);
        return RemoteHostStatusSchema.parse(await controller.deactivate());
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
    const unsubscribeAccount = controller.onAccountStatusChanged((status) =>
      sendAccountStatusToLiveWindows(
        windows,
        isTrustedRendererUrl,
        status,
        reportError,
      ),
    );
    const previousUnsubscribe = unsubscribe;
    unsubscribe = () => {
      previousUnsubscribe?.();
      unsubscribeAccount();
    };
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

import {
  AgentLaunchTargetSchema,
  AgentRuntimeSchema,
  AgentTargetConnectRequestSchema,
  AgentTargetRuntimeRequestSchema,
  IPC_CHANNELS,
  RemoteAccountStatusSchema,
  RemoteAuthProviderSchema,
  RemoteHostStatusSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceListRequestSchema,
  WorkspaceRootSchema,
  WorkspaceSelectionSchema,
  WorkspaceTargetRequestSchema,
  WorkspaceValidateRequestSchema,
  type AgentExecutionTarget,
  type AgentLaunchTarget,
  type AgentRuntime,
  type RemoteAccountStatus,
  type RemoteAuthProvider,
  type RemoteHostStatus,
  type RemoteAgentExecutionTarget,
  type WorkspaceDirectoryPage,
  type WorkspaceRoot,
  type WorkspaceSelection,
} from "@codra/protocol";
import {
  assertAuthorizedRenderer,
  type BrowserWindowLike,
} from "./renderer-authorization";
import type { IpcMainLike } from "./terminal-ipc";
import type { DesktopAuthParentWindowLike } from "../remote/auth-window";

type RemoteIpcHandler = (event: unknown, payload?: unknown) => unknown;

export interface RemoteHostControllerPort {
  getStatus(): RemoteHostStatus;
  getAccountStatus(): RemoteAccountStatus;
  login(
    provider: RemoteAuthProvider,
    parentWindow: DesktopAuthParentWindowLike,
  ): Promise<RemoteAccountStatus>;
  logout(): Promise<RemoteAccountStatus>;
  activate(): Promise<RemoteHostStatus>;
  deactivate(): Promise<RemoteHostStatus>;
  onStatusChanged(listener: (status: RemoteHostStatus) => void): () => void;
  onAccountStatusChanged(
    listener: (status: RemoteAccountStatus) => void,
  ): () => void;
  listTargets(): Promise<AgentLaunchTarget[]>;
  connectTarget(target: RemoteAgentExecutionTarget): Promise<AgentLaunchTarget>;
  listRuntimesForTarget(target: AgentExecutionTarget): Promise<AgentRuntime[]>;
  workspaceRoots(target: AgentExecutionTarget): Promise<WorkspaceRoot[]>;
  workspaceList(
    target: AgentExecutionTarget,
    path: string,
  ): Promise<WorkspaceDirectoryPage>;
  workspaceValidate(
    target: AgentExecutionTarget,
    path: string,
  ): Promise<WorkspaceSelection>;
  onTargetsChanged(
    listener: (targets: AgentLaunchTarget[]) => void,
  ): () => void;
}

export interface RegisterRemoteIpcOptions {
  ipc: IpcMainLike;
  controller: RemoteHostControllerPort;
  windows(): readonly RemoteIpcWindowLike[];
  isTrustedRendererUrl(url: string): boolean;
  reportError?(error: unknown): void;
}

type RemoteIpcWindowLike = BrowserWindowLike & DesktopAuthParentWindowLike;

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

function sendTargetsToLiveWindows(
  windows: () => readonly BrowserWindowLike[],
  isTrustedRendererUrl: (url: string) => boolean,
  targets: AgentLaunchTarget[],
  reportError: (error: unknown) => void,
): void {
  const payload = AgentLaunchTargetSchema.array().parse(targets);
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
      webContents.send(IPC_CHANNELS.agentTargetsChanged, payload);
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
  const authorize = (event: unknown): RemoteIpcWindowLike =>
    assertAuthorizedRenderer(event, windows, isTrustedRendererUrl);
  const registrations: readonly [string, RemoteIpcHandler][] = [
    [
      IPC_CHANNELS.agentTargets,
      async (event) => {
        authorize(event);
        return AgentLaunchTargetSchema.array().parse(
          await controller.listTargets(),
        );
      },
    ],
    [
      IPC_CHANNELS.agentConnectTarget,
      async (event, rawRequest) => {
        authorize(event);
        const { target } = AgentTargetConnectRequestSchema.parse(rawRequest);
        return AgentLaunchTargetSchema.parse(
          await controller.connectTarget(target),
        );
      },
    ],
    [
      IPC_CHANNELS.agentTargetRuntimes,
      async (event, rawRequest) => {
        authorize(event);
        const { target } = AgentTargetRuntimeRequestSchema.parse(rawRequest);
        return AgentRuntimeSchema.array().parse(
          await controller.listRuntimesForTarget(target),
        );
      },
    ],
    [
      IPC_CHANNELS.agentWorkspaceRoots,
      async (event, rawRequest) => {
        authorize(event);
        const { target } = WorkspaceTargetRequestSchema.parse(rawRequest);
        return WorkspaceRootSchema.array().parse(
          await controller.workspaceRoots(target),
        );
      },
    ],
    [
      IPC_CHANNELS.agentWorkspaceList,
      async (event, rawRequest) => {
        authorize(event);
        const { target, path } = WorkspaceListRequestSchema.parse(rawRequest);
        return WorkspaceDirectoryPageSchema.parse(
          await controller.workspaceList(target, path),
        );
      },
    ],
    [
      IPC_CHANNELS.agentWorkspaceValidate,
      async (event, rawRequest) => {
        authorize(event);
        const { target, path } =
          WorkspaceValidateRequestSchema.parse(rawRequest);
        return WorkspaceSelectionSchema.parse(
          await controller.workspaceValidate(target, path),
        );
      },
    ],
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
        const parentWindow = authorize(event);
        return RemoteAccountStatusSchema.parse(
          await controller.login(
            RemoteAuthProviderSchema.parse(provider),
            parentWindow,
          ),
        );
      },
    ],
    [
      IPC_CHANNELS.remoteLogout,
      async (event) => {
        authorize(event);
        return RemoteAccountStatusSchema.parse(await controller.logout());
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
      sendToLiveWindows(windows, isTrustedRendererUrl, status, reportError),
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
    const unsubscribeTargets = controller.onTargetsChanged((targets) =>
      sendTargetsToLiveWindows(
        windows,
        isTrustedRendererUrl,
        targets,
        reportError,
      ),
    );
    unsubscribe = () => {
      previousUnsubscribe?.();
      unsubscribeAccount();
      unsubscribeTargets();
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

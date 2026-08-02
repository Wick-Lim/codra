import {
  AgentLaunchTargetSchema,
  AgentRuntimeSchema,
  AgentSetupRequestSchema,
  AgentSetupResultSchema,
  AgentTargetConnectRequestSchema,
  AgentTargetRuntimeRequestSchema,
  ApproveRemoteSessionRequestSchema,
  ChooseTerminalCwdRequestSchema,
  ChooseTerminalCwdResultSchema,
  CreateTerminalRequestSchema,
  IPC_CHANNELS,
  PendingRemoteSessionListSchema,
  RejectRemoteSessionRequestSchema,
  RemoteAccountStatusSchema,
  RemoteAuthProviderSchema,
  ReplayTerminalRequestSchema,
  RemoteHostStatusSchema,
  ResizeTerminalRequestSchema,
  TerminalDescriptorSchema,
  TerminalCwdSchema,
  TerminalIdSchema,
  TerminalOutputChunkSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceListRequestSchema,
  WorkspaceRootSchema,
  WorkspaceSelectionSchema,
  WorkspaceTargetRequestSchema,
  WorkspaceValidateRequestSchema,
  WriteTerminalRequestSchema,
  type CodraDesktopApi,
} from "@codra/protocol";

type IpcListener = (event: unknown, payload: unknown) => void;

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): void;
  removeListener(channel: string, listener: IpcListener): void;
}

function assertUndefinedResponse(
  response: unknown,
): asserts response is undefined {
  if (response !== undefined) {
    throw new TypeError("Expected IPC mutation response to be undefined");
  }
}

export function createDesktopApi(ipc: IpcRendererLike): CodraDesktopApi {
  return {
    agents: {
      async list() {
        return AgentRuntimeSchema.array().parse(
          await ipc.invoke(IPC_CHANNELS.agentList),
        );
      },
      async targets() {
        return AgentLaunchTargetSchema.array().parse(
          await ipc.invoke(IPC_CHANNELS.agentTargets),
        );
      },
      async connectTarget(target) {
        return AgentLaunchTargetSchema.parse(
          await ipc.invoke(
            IPC_CHANNELS.agentConnectTarget,
            AgentTargetConnectRequestSchema.parse({ target }),
          ),
        );
      },
      async listForTarget(target) {
        return AgentRuntimeSchema.array().parse(
          await ipc.invoke(
            IPC_CHANNELS.agentTargetRuntimes,
            AgentTargetRuntimeRequestSchema.parse({ target }),
          ),
        );
      },
      async workspaceRoots(target) {
        return WorkspaceRootSchema.array().parse(
          await ipc.invoke(
            IPC_CHANNELS.agentWorkspaceRoots,
            WorkspaceTargetRequestSchema.parse({ target }),
          ),
        );
      },
      async workspaceList(target, path) {
        return WorkspaceDirectoryPageSchema.parse(
          await ipc.invoke(
            IPC_CHANNELS.agentWorkspaceList,
            WorkspaceListRequestSchema.parse({ target, path }),
          ),
        );
      },
      async workspaceValidate(target, path) {
        return WorkspaceSelectionSchema.parse(
          await ipc.invoke(
            IPC_CHANNELS.agentWorkspaceValidate,
            WorkspaceValidateRequestSchema.parse({ target, path }),
          ),
        );
      },
      onTargetsChanged(listener) {
        const wrapped: IpcListener = (_event, payload) => {
          const parsed = AgentLaunchTargetSchema.array().safeParse(payload);
          if (parsed.success) listener(parsed.data);
        };

        ipc.on(IPC_CHANNELS.agentTargetsChanged, wrapped);
        return () =>
          ipc.removeListener(IPC_CHANNELS.agentTargetsChanged, wrapped);
      },
      async setup(request) {
        return AgentSetupResultSchema.parse(
          await ipc.invoke(
            IPC_CHANNELS.agentSetup,
            AgentSetupRequestSchema.parse(request),
          ),
        );
      },
    },
    terminal: {
      async defaultCwd() {
        return TerminalCwdSchema.parse(
          await ipc.invoke(IPC_CHANNELS.terminalDefaultCwd),
        );
      },
      async chooseCwd(defaultPath) {
        return ChooseTerminalCwdResultSchema.parse(
          await ipc.invoke(
            IPC_CHANNELS.terminalChooseCwd,
            ChooseTerminalCwdRequestSchema.parse({ defaultPath }),
          ),
        );
      },
      async list() {
        return TerminalDescriptorSchema.array().parse(
          await ipc.invoke(IPC_CHANNELS.terminalList),
        );
      },
      async create(request) {
        return TerminalDescriptorSchema.parse(
          await ipc.invoke(
            IPC_CHANNELS.terminalCreate,
            CreateTerminalRequestSchema.parse(request),
          ),
        );
      },
      async write(request) {
        assertUndefinedResponse(
          await ipc.invoke(
            IPC_CHANNELS.terminalWrite,
            WriteTerminalRequestSchema.parse(request),
          ),
        );
      },
      async resize(request) {
        assertUndefinedResponse(
          await ipc.invoke(
            IPC_CHANNELS.terminalResize,
            ResizeTerminalRequestSchema.parse(request),
          ),
        );
      },
      async replay(request) {
        return TerminalOutputChunkSchema.array().parse(
          await ipc.invoke(
            IPC_CHANNELS.terminalReplay,
            ReplayTerminalRequestSchema.parse(request),
          ),
        );
      },
      async close(terminalId) {
        assertUndefinedResponse(
          await ipc.invoke(
            IPC_CHANNELS.terminalClose,
            TerminalIdSchema.parse(terminalId),
          ),
        );
      },
      onOutput(listener) {
        const wrapped: IpcListener = (_event, payload) => {
          const parsed = TerminalOutputChunkSchema.safeParse(payload);
          if (parsed.success) {
            listener(parsed.data);
          }
        };

        ipc.on(IPC_CHANNELS.terminalOutput, wrapped);
        return () => ipc.removeListener(IPC_CHANNELS.terminalOutput, wrapped);
      },
      onChanged(listener) {
        const wrapped: IpcListener = (_event, payload) => {
          const parsed = TerminalDescriptorSchema.safeParse(payload);
          if (parsed.success) {
            listener(parsed.data);
          }
        };

        ipc.on(IPC_CHANNELS.terminalChanged, wrapped);
        return () => ipc.removeListener(IPC_CHANNELS.terminalChanged, wrapped);
      },
    },
    remote: {
      async getState() {
        return RemoteHostStatusSchema.parse(
          await ipc.invoke(IPC_CHANNELS.remoteGetState),
        );
      },
      async getAuthState() {
        return RemoteAccountStatusSchema.parse(
          await ipc.invoke(IPC_CHANNELS.remoteGetAuthState),
        );
      },
      async login(provider) {
        return RemoteAccountStatusSchema.parse(
          await ipc.invoke(
            IPC_CHANNELS.remoteLogin,
            RemoteAuthProviderSchema.parse(provider),
          ),
        );
      },
      async logout() {
        return RemoteAccountStatusSchema.parse(
          await ipc.invoke(IPC_CHANNELS.remoteLogout),
        );
      },
      async activate() {
        return RemoteHostStatusSchema.parse(
          await ipc.invoke(IPC_CHANNELS.remoteActivate),
        );
      },
      async deactivate() {
        return RemoteHostStatusSchema.parse(
          await ipc.invoke(IPC_CHANNELS.remoteDeactivate),
        );
      },
      onStateChanged(listener) {
        const wrapped: IpcListener = (_event, payload) => {
          const parsed = RemoteHostStatusSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data);
        };

        ipc.on(IPC_CHANNELS.remoteState, wrapped);
        return () => ipc.removeListener(IPC_CHANNELS.remoteState, wrapped);
      },
      onAuthStateChanged(listener) {
        const wrapped: IpcListener = (_event, payload) => {
          const parsed = RemoteAccountStatusSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data);
        };

        ipc.on(IPC_CHANNELS.remoteAuthState, wrapped);
        return () => ipc.removeListener(IPC_CHANNELS.remoteAuthState, wrapped);
      },
      async getPendingSessions() {
        return PendingRemoteSessionListSchema.parse(
          await ipc.invoke(IPC_CHANNELS.remoteGetPendingSessions),
        );
      },
      async approveSession(request) {
        assertUndefinedResponse(
          await ipc.invoke(
            IPC_CHANNELS.remoteApproveSession,
            ApproveRemoteSessionRequestSchema.parse(request),
          ),
        );
      },
      async rejectSession(request) {
        assertUndefinedResponse(
          await ipc.invoke(
            IPC_CHANNELS.remoteRejectSession,
            RejectRemoteSessionRequestSchema.parse(request),
          ),
        );
      },
      onPendingSessionsChanged(listener) {
        const wrapped: IpcListener = (_event, payload) => {
          const parsed = PendingRemoteSessionListSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data);
        };

        ipc.on(IPC_CHANNELS.remotePendingSessions, wrapped);
        return () =>
          ipc.removeListener(IPC_CHANNELS.remotePendingSessions, wrapped);
      },
    },
  };
}

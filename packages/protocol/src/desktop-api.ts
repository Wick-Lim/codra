import { z } from "zod";
import {
  AgentExecutionTargetSchema,
  RemoteAgentExecutionTargetSchema,
  TerminalCwdSchema,
  TerminalDescriptorSchema,
  type AgentExecutionTarget,
  type AgentLaunchTarget,
  type AgentRuntime,
  type AgentSetupRequest,
  type RemoteAgentExecutionTarget,
  type WorkspaceDirectoryPage,
  type WorkspaceRoot,
  type WorkspaceSelection,
  CreateTerminalRequest,
  ReplayTerminalRequest,
  ResizeTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
  WriteTerminalRequest,
} from "./terminal";

export const AgentTargetConnectRequestSchema = z
  .object({ target: RemoteAgentExecutionTargetSchema })
  .strict();
export const AgentTargetRuntimeRequestSchema = z
  .object({ target: AgentExecutionTargetSchema })
  .strict();
export const WorkspaceTargetRequestSchema = z
  .object({ target: AgentExecutionTargetSchema })
  .strict();
export const WorkspaceListRequestSchema = z
  .object({
    target: AgentExecutionTargetSchema,
    path: TerminalCwdSchema,
  })
  .strict();
export const WorkspaceValidateRequestSchema = z
  .object({
    target: AgentExecutionTargetSchema,
    path: TerminalCwdSchema,
  })
  .strict();
export type AgentTargetConnectRequest = z.infer<
  typeof AgentTargetConnectRequestSchema
>;
export type AgentTargetRuntimeRequest = z.infer<
  typeof AgentTargetRuntimeRequestSchema
>;
export type WorkspaceTargetRequest = z.infer<
  typeof WorkspaceTargetRequestSchema
>;
export type WorkspaceListRequest = z.infer<typeof WorkspaceListRequestSchema>;
export type WorkspaceValidateRequest = z.infer<
  typeof WorkspaceValidateRequestSchema
>;

export const RemoteHostStateSchema = z.enum([
  "idle",
  "activating",
  "online",
  "error",
]);
export type RemoteHostState = z.infer<typeof RemoteHostStateSchema>;

export const RemoteHostStatusSchema = z
  .object({
    state: RemoteHostStateSchema,
    message: z.string().min(1).max(160).optional(),
  })
  .strict();
export type RemoteHostStatus = z.infer<typeof RemoteHostStatusSchema>;

export const RemoteAuthProviderSchema = z.enum(["google", "email_password"]);
export type RemoteAuthProvider = z.infer<typeof RemoteAuthProviderSchema>;

export const RemoteAccountStateSchema = z.enum([
  "signed_out",
  "signing_in",
  "signed_in",
  "error",
]);
export type RemoteAccountState = z.infer<typeof RemoteAccountStateSchema>;

export const RemoteAccountProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).nullable(),
    email: z.string().email().max(254).nullable(),
    photoUrl: z.string().url().max(2_048).nullable(),
  })
  .strict();
export type RemoteAccountProfile = z.infer<typeof RemoteAccountProfileSchema>;

export const RemoteAccountStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("signed_out") }).strict(),
  z.object({ state: z.literal("signing_in") }).strict(),
  z
    .object({
      state: z.literal("signed_in"),
      profile: RemoteAccountProfileSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("error"),
      message: z.string().min(1).max(160).optional(),
    })
    .strict(),
]);
export type RemoteAccountStatus = z.infer<typeof RemoteAccountStatusSchema>;

export const PendingRemoteSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    clientDeviceId: z.string().uuid(),
    requesterDisplayName: z.string().min(1).max(200).optional(),
    requestedScopes: z.array(z.string().min(1).max(80)).min(1).max(16),
    expiresAt: z.number().int().nonnegative().safe(),
  })
  .strict();
export type PendingRemoteSession = z.infer<typeof PendingRemoteSessionSchema>;

export const PendingRemoteSessionListSchema = z
  .array(PendingRemoteSessionSchema)
  .max(50);

export const ApproveRemoteSessionRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    approvedScopes: z.array(z.string().min(1).max(80)).min(1).max(16),
  })
  .strict();
export type ApproveRemoteSessionRequest = z.infer<
  typeof ApproveRemoteSessionRequestSchema
>;

export const RejectRemoteSessionRequestSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type RejectRemoteSessionRequest = z.infer<
  typeof RejectRemoteSessionRequestSchema
>;

export const IPC_CHANNELS = {
  agentList: "codra:agent:list",
  agentSetup: "codra:agent:setup",
  agentTargets: "codra:agent:targets",
  agentConnectTarget: "codra:agent:connect-target",
  agentTargetRuntimes: "codra:agent:target-runtimes",
  agentWorkspaceRoots: "codra:agent:workspace-roots",
  agentWorkspaceList: "codra:agent:workspace-list",
  agentWorkspaceValidate: "codra:agent:workspace-validate",
  agentTargetsChanged: "codra:agent:targets-changed",
  terminalList: "codra:terminal:list",
  terminalDefaultCwd: "codra:terminal:default-cwd",
  terminalChooseCwd: "codra:terminal:choose-cwd",
  terminalCreate: "codra:terminal:create",
  terminalWrite: "codra:terminal:write",
  terminalResize: "codra:terminal:resize",
  terminalReplay: "codra:terminal:replay",
  terminalClose: "codra:terminal:close",
  terminalOutput: "codra:terminal:output",
  terminalChanged: "codra:terminal:changed",
  remoteGetState: "codra:remote:get-state",
  remoteGetAuthState: "codra:remote:get-auth-state",
  remoteLogin: "codra:remote:login",
  remoteLogout: "codra:remote:logout",
  remoteActivate: "codra:remote:activate",
  remoteDeactivate: "codra:remote:deactivate",
  remoteState: "codra:remote:state",
  remoteAuthState: "codra:remote:auth-state",
  remoteGetPendingSessions: "codra:remote:get-pending-sessions",
  remoteApproveSession: "codra:remote:approve-session",
  remoteRejectSession: "codra:remote:reject-session",
  remotePendingSessions: "codra:remote:pending-sessions",
} as const;

export const AgentSetupResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("terminal"),
      terminal: TerminalDescriptorSchema,
    })
    .strict(),
  z.object({ kind: z.literal("external") }).strict(),
]);
export type AgentSetupResult = z.infer<typeof AgentSetupResultSchema>;

export interface CodraDesktopApi {
  agents: {
    list(): Promise<AgentRuntime[]>;
    targets(): Promise<AgentLaunchTarget[]>;
    connectTarget(
      target: RemoteAgentExecutionTarget,
    ): Promise<AgentLaunchTarget>;
    listForTarget(target: AgentExecutionTarget): Promise<AgentRuntime[]>;
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
    setup(request: AgentSetupRequest): Promise<AgentSetupResult>;
  };
  terminal: {
    defaultCwd(): Promise<string>;
    chooseCwd(defaultPath: string): Promise<string | null>;
    list(): Promise<TerminalDescriptor[]>;
    create(request: CreateTerminalRequest): Promise<TerminalDescriptor>;
    write(request: WriteTerminalRequest): Promise<void>;
    resize(request: ResizeTerminalRequest): Promise<void>;
    replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]>;
    close(terminalId: string): Promise<void>;
    onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void;
    onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void;
  };
  remote: {
    getState(): Promise<RemoteHostStatus>;
    getAuthState(): Promise<RemoteAccountStatus>;
    login(provider: RemoteAuthProvider): Promise<RemoteAccountStatus>;
    logout(): Promise<RemoteAccountStatus>;
    activate(): Promise<RemoteHostStatus>;
    deactivate(): Promise<RemoteHostStatus>;
    onStateChanged(listener: (status: RemoteHostStatus) => void): () => void;
    onAuthStateChanged(
      listener: (status: RemoteAccountStatus) => void,
    ): () => void;
    getPendingSessions(): Promise<PendingRemoteSession[]>;
    approveSession(request: ApproveRemoteSessionRequest): Promise<void>;
    rejectSession(request: RejectRemoteSessionRequest): Promise<void>;
    onPendingSessionsChanged(
      listener: (sessions: PendingRemoteSession[]) => void,
    ): () => void;
  };
}

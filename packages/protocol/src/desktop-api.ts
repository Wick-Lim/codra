import { z } from "zod";
import type {
  AgentRuntime,
  CreateTerminalRequest,
  ReplayTerminalRequest,
  ResizeTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
  WriteTerminalRequest,
} from "./terminal";

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

export const IPC_CHANNELS = {
  agentList: "codra:agent:list",
  terminalList: "codra:terminal:list",
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
} as const;

export interface CodraDesktopApi {
  agents: {
    list(): Promise<AgentRuntime[]>;
  };
  terminal: {
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
  };
}

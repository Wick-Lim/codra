import { z } from "zod";
import type {
  CreateTerminalRequest,
  ReplayTerminalRequest,
  ResizeTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
  WriteTerminalRequest,
} from "./terminal";

export const RemoteHostStateSchema = z.enum([
  "idle",
  "signing_in",
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

export const IPC_CHANNELS = {
  terminalList: "codra:terminal:list",
  terminalCreate: "codra:terminal:create",
  terminalWrite: "codra:terminal:write",
  terminalResize: "codra:terminal:resize",
  terminalReplay: "codra:terminal:replay",
  terminalClose: "codra:terminal:close",
  terminalOutput: "codra:terminal:output",
  terminalChanged: "codra:terminal:changed",
  remoteGetState: "codra:remote:get-state",
  remoteLogin: "codra:remote:login",
  remoteState: "codra:remote:state",
} as const;

export interface CodraDesktopApi {
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
    login(): Promise<RemoteHostStatus>;
    onStateChanged(listener: (status: RemoteHostStatus) => void): () => void;
  };
}

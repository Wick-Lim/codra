import {
  CreateTerminalRequestSchema,
  IPC_CHANNELS,
  ReplayTerminalRequestSchema,
  ResizeTerminalRequestSchema,
  TerminalIdSchema,
  WriteTerminalRequestSchema,
  type CreateTerminalRequest,
  type ReplayTerminalRequest,
  type ResizeTerminalRequest,
  type TerminalDescriptor,
  type TerminalOutputChunk,
  type WriteTerminalRequest,
} from "@codra/protocol";

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

export interface IpcMainLike {
  handle(channel: string, handler: IpcHandler): void;
  removeHandler(channel: string): void;
}

export interface BrowserWindowLike {
  readonly webContents?: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

export interface TerminalManagerIpcPort {
  list(): Promise<TerminalDescriptor[]>;
  create(request: CreateTerminalRequest): Promise<TerminalDescriptor>;
  write(request: WriteTerminalRequest): Promise<void>;
  resize(request: ResizeTerminalRequest): Promise<void>;
  replay(request: ReplayTerminalRequest): Promise<TerminalOutputChunk[]>;
  close(terminalId: string): Promise<void>;
  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void;
  onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void;
}

export interface RegisterTerminalIpcOptions {
  ipc: IpcMainLike;
  manager: TerminalManagerIpcPort;
  windows(): readonly BrowserWindowLike[];
  reportError?(error: unknown): void;
}

const requestChannels = [
  IPC_CHANNELS.terminalList,
  IPC_CHANNELS.terminalCreate,
  IPC_CHANNELS.terminalWrite,
  IPC_CHANNELS.terminalResize,
  IPC_CHANNELS.terminalReplay,
  IPC_CHANNELS.terminalClose,
] as const;

function sendToLiveWindows(
  windows: () => readonly BrowserWindowLike[],
  channel: string,
  payload: unknown,
  reportError: (error: unknown) => void,
): void {
  for (const window of windows()) {
    try {
      const webContents = window.webContents;
      if (!webContents || webContents.isDestroyed()) continue;
      webContents.send(channel, payload);
    } catch (error) {
      reportError(error);
    }
  }
}

export function registerTerminalIpc({
  ipc,
  manager,
  windows,
  reportError = (error) => console.error("Terminal IPC error", error),
}: RegisterTerminalIpcOptions): () => void {
  ipc.handle(IPC_CHANNELS.terminalList, () => manager.list());
  ipc.handle(IPC_CHANNELS.terminalCreate, (_event, rawRequest) =>
    manager.create(CreateTerminalRequestSchema.parse(rawRequest)),
  );
  ipc.handle(IPC_CHANNELS.terminalWrite, (_event, rawRequest) =>
    manager.write(WriteTerminalRequestSchema.parse(rawRequest)),
  );
  ipc.handle(IPC_CHANNELS.terminalResize, (_event, rawRequest) =>
    manager.resize(ResizeTerminalRequestSchema.parse(rawRequest)),
  );
  ipc.handle(IPC_CHANNELS.terminalReplay, (_event, rawRequest) =>
    manager.replay(ReplayTerminalRequestSchema.parse(rawRequest)),
  );
  ipc.handle(IPC_CHANNELS.terminalClose, (_event, rawTerminalId) =>
    manager.close(TerminalIdSchema.parse(rawTerminalId)),
  );

  const unsubscribeOutput = manager.onOutput((chunk) => {
    sendToLiveWindows(windows, IPC_CHANNELS.terminalOutput, chunk, reportError);
  });
  const unsubscribeChanged = manager.onChanged((descriptor) => {
    sendToLiveWindows(
      windows,
      IPC_CHANNELS.terminalChanged,
      descriptor,
      reportError,
    );
  });

  return () => {
    for (const channel of requestChannels) ipc.removeHandler(channel);
    unsubscribeOutput();
    unsubscribeChanged();
  };
}

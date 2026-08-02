import {
  AgentRuntimeSchema,
  AgentSetupRequestSchema,
  AgentSetupResultSchema,
  CreateTerminalRequestSchema,
  IPC_CHANNELS,
  ReplayTerminalRequestSchema,
  ResizeTerminalRequestSchema,
  TerminalIdSchema,
  TerminalCwdSchema,
  WriteTerminalRequestSchema,
  type CreateTerminalRequest,
  type AgentKind,
  type AgentRuntime,
  type ReplayTerminalRequest,
  type ResizeTerminalRequest,
  type TerminalDescriptor,
  type TerminalOutputChunk,
  type WriteTerminalRequest,
} from "@codra/protocol";
import { homedir } from "node:os";
import { listAgentRuntimes } from "../terminal/agent-runtime";
import {
  TerminalAdmissionGate,
  type TerminalRequestAdmission,
} from "./admission";
import {
  assertAuthorizedRenderer,
  type BrowserWindowLike,
} from "./renderer-authorization";

export type { BrowserWindowLike } from "./renderer-authorization";

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

export interface IpcMainLike {
  handle(channel: string, handler: IpcHandler): void;
  removeHandler(channel: string): void;
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
  isTrustedRendererUrl(url: string): boolean;
  admission?: TerminalRequestAdmission;
  listAgents?(): AgentRuntime[] | Promise<AgentRuntime[]>;
  defaultCwd?(): string;
  openExternal?(url: string): Promise<void>;
  reportError?(error: unknown): void;
}

const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download/mac";

const requestChannels = [
  IPC_CHANNELS.agentList,
  IPC_CHANNELS.agentSetup,
  IPC_CHANNELS.terminalDefaultCwd,
  IPC_CHANNELS.terminalList,
  IPC_CHANNELS.terminalCreate,
  IPC_CHANNELS.terminalWrite,
  IPC_CHANNELS.terminalResize,
  IPC_CHANNELS.terminalReplay,
  IPC_CHANNELS.terminalClose,
] as const;

function sendToLiveWindows(
  windows: () => readonly BrowserWindowLike[],
  isTrustedRendererUrl: (url: string) => boolean,
  channel: string,
  payload: unknown,
  reportError: (error: unknown) => void,
): void {
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
  isTrustedRendererUrl,
  admission = new TerminalAdmissionGate(),
  listAgents = listAgentRuntimes,
  defaultCwd = homedir,
  openExternal = async () => {
    throw new Error("AGENT_EXTERNAL_SETUP_UNAVAILABLE");
  },
  reportError = (error) => console.error("Terminal IPC error", error),
}: RegisterTerminalIpcOptions): () => void {
  const activeSetups = new Map<AgentKind, string | null>();
  const authorize = (event: unknown): void => {
    assertAuthorizedRenderer(event, windows, isTrustedRendererUrl);
  };
  const registrations: readonly [string, IpcHandler][] = [
    [
      IPC_CHANNELS.terminalDefaultCwd,
      (event) => {
        authorize(event);
        return TerminalCwdSchema.parse(defaultCwd());
      },
    ],
    [
      IPC_CHANNELS.agentList,
      async (event) => {
        authorize(event);
        return AgentRuntimeSchema.array().parse(await listAgents());
      },
    ],
    [
      IPC_CHANNELS.agentSetup,
      (event, rawRequest) => {
        authorize(event);
        const request = AgentSetupRequestSchema.parse(rawRequest);
        return admission.run(async () => {
          if (request.kind === "ollama") {
            await openExternal(OLLAMA_DOWNLOAD_URL);
            return AgentSetupResultSchema.parse({ kind: "external" });
          }
          if (activeSetups.has(request.kind)) {
            throw new Error("AGENT_SETUP_IN_PROGRESS");
          }
          activeSetups.set(request.kind, null);
          try {
            const terminal = await manager.create({
              cols: 100,
              rows: 30,
              agentSetup: request,
            });
            activeSetups.set(request.kind, terminal.id);
            return AgentSetupResultSchema.parse({
              kind: "terminal",
              terminal,
            });
          } catch (error) {
            activeSetups.delete(request.kind);
            throw error;
          }
        });
      },
    ],
    [
      IPC_CHANNELS.terminalList,
      (event) => {
        authorize(event);
        return admission.run(() => manager.list());
      },
    ],
    [
      IPC_CHANNELS.terminalCreate,
      (event, rawRequest) => {
        authorize(event);
        return admission.run(() =>
          manager.create(CreateTerminalRequestSchema.parse(rawRequest)),
        );
      },
    ],
    [
      IPC_CHANNELS.terminalWrite,
      (event, rawRequest) => {
        authorize(event);
        return admission.run(() =>
          manager.write(WriteTerminalRequestSchema.parse(rawRequest)),
        );
      },
    ],
    [
      IPC_CHANNELS.terminalResize,
      (event, rawRequest) => {
        authorize(event);
        return admission.run(() =>
          manager.resize(ResizeTerminalRequestSchema.parse(rawRequest)),
        );
      },
    ],
    [
      IPC_CHANNELS.terminalReplay,
      (event, rawRequest) => {
        authorize(event);
        return admission.run(() =>
          manager.replay(ReplayTerminalRequestSchema.parse(rawRequest)),
        );
      },
    ],
    [
      IPC_CHANNELS.terminalClose,
      (event, rawTerminalId) => {
        authorize(event);
        return admission.run(() =>
          manager.close(TerminalIdSchema.parse(rawTerminalId)),
        );
      },
    ],
  ];
  const registeredChannels: string[] = [];
  let unsubscribeOutput: (() => void) | undefined;
  let unsubscribeChanged: (() => void) | undefined;

  try {
    for (const [channel, handler] of registrations) {
      ipc.handle(channel, handler);
      registeredChannels.push(channel);
    }
    unsubscribeOutput = manager.onOutput((chunk) => {
      sendToLiveWindows(
        windows,
        isTrustedRendererUrl,
        IPC_CHANNELS.terminalOutput,
        chunk,
        reportError,
      );
    });
    unsubscribeChanged = manager.onChanged((descriptor) => {
      if (descriptor.state === "exited") {
        for (const [kind, terminalId] of activeSetups) {
          if (terminalId === descriptor.id) activeSetups.delete(kind);
        }
      }
      sendToLiveWindows(
        windows,
        isTrustedRendererUrl,
        IPC_CHANNELS.terminalChanged,
        descriptor,
        reportError,
      );
    });
  } catch (error) {
    for (const channel of registeredChannels) ipc.removeHandler(channel);
    unsubscribeOutput?.();
    unsubscribeChanged?.();
    throw error;
  }

  return () => {
    for (const channel of requestChannels) ipc.removeHandler(channel);
    unsubscribeOutput?.();
    unsubscribeChanged?.();
  };
}

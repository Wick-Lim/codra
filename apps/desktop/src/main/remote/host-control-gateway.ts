import {
  AgentRuntimeSchema,
  RemoteControlMessageSchema,
  RemoteOperationErrorCodeSchema,
  RemoteSessionSchema,
  RemoteTerminalDescriptorSchema,
  type AgentRuntime,
  type CreateTerminalRequest,
  type RemoteControlMessage,
  type RemoteSession,
  type ResizeTerminalRequest,
  type TerminalDescriptor,
  type TerminalOutputChunk,
  type WorkspaceDirectoryPage,
  type WorkspaceRoot,
  type WorkspaceSelection,
  type WriteTerminalRequest,
} from "@codra/protocol";
import {
  AttachmentPump,
  HandshakeGate,
  type BinaryOutputChannel,
  type CursorOutputStore,
} from "@codra/webrtc";
import { WorkspaceServiceError } from "./workspace-service";

type OperationErrorCode = typeof RemoteOperationErrorCodeSchema._output;
type RemoteOperationName =
  | "workspace.roots"
  | "workspace.list"
  | "workspace.validate"
  | "agent.runtimes"
  | "agent.launch";

export const REMOTE_AGENT_SCOPES = [
  "workspace.read",
  "agent.runtimes",
  "agent.launch",
  "terminal.write",
  "terminal.resize",
  "terminal.detach",
] as const;

export interface HostWorkspacePort {
  roots(signal?: AbortSignal): Promise<WorkspaceRoot[]>;
  list(path: string, signal?: AbortSignal): Promise<WorkspaceDirectoryPage>;
  validate(path: string, signal?: AbortSignal): Promise<WorkspaceSelection>;
}

export interface HostControlTerminalManager {
  list(): Promise<TerminalDescriptor[]>;
  create(request: CreateTerminalRequest): Promise<TerminalDescriptor>;
  write(request: WriteTerminalRequest): Promise<void>;
  resize(request: ResizeTerminalRequest): Promise<void>;
  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void;
  onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void;
}

export interface HostControlSender {
  send(message: RemoteControlMessage): void;
}

export interface HostControlGatewayOptions {
  session: RemoteSession;
  negotiationId: string;
  hostSigner: CryptoKey;
  publicKeyResolver(thumbprint: string): Promise<CryptoKey | undefined>;
  workspace: HostWorkspacePort;
  listRuntimes(): AgentRuntime[] | Promise<AgentRuntime[]>;
  manager: HostControlTerminalManager;
  outputStore: CursorOutputStore;
  controlSender: HostControlSender;
  terminalSender: BinaryOutputChannel;
  reportError?(error: unknown): void;
}

class GatewayOperationError extends Error {
  constructor(
    readonly code: OperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayOperationError";
  }
}

class GatewayTerminalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GatewayTerminalError";
  }
}

function remoteDescriptor(descriptor: TerminalDescriptor) {
  return RemoteTerminalDescriptorSchema.parse({
    id: descriptor.id,
    title: descriptor.title,
    cols: descriptor.cols,
    rows: descriptor.rows,
    state: descriptor.state,
    createdAt: descriptor.createdAt,
    ...(descriptor.exitCode === undefined
      ? {}
      : { exitCode: descriptor.exitCode }),
  });
}

function operationIdentity(
  value: unknown,
): { requestId: string; operation: RemoteOperationName } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length < 1 ||
    candidate.requestId.length > 128
  ) {
    return undefined;
  }
  if (
    candidate.type !== "workspace.roots" &&
    candidate.type !== "workspace.list" &&
    candidate.type !== "workspace.validate" &&
    candidate.type !== "agent.runtimes" &&
    candidate.type !== "agent.launch"
  ) {
    return undefined;
  }
  return {
    requestId: candidate.requestId,
    operation: candidate.type,
  };
}

function operationForMessage(
  message: RemoteControlMessage,
): { requestId: string; operation: RemoteOperationName } | undefined {
  switch (message.type) {
    case "workspace.roots":
    case "workspace.list":
    case "workspace.validate":
    case "agent.runtimes":
    case "agent.launch":
      return { requestId: message.requestId, operation: message.type };
    default:
      return undefined;
  }
}

function workspaceError(error: WorkspaceServiceError): GatewayOperationError {
  switch (error.code) {
    case "WORKSPACE_NOT_FOUND":
      return new GatewayOperationError(
        "WORKSPACE_NOT_FOUND",
        "The selected folder is no longer available.",
      );
    case "WORKSPACE_NOT_DIRECTORY":
      return new GatewayOperationError(
        "WORKSPACE_NOT_DIRECTORY",
        "The selected path is not a folder.",
      );
    case "WORKSPACE_PERMISSION_DENIED":
      return new GatewayOperationError(
        "WORKSPACE_PERMISSION_DENIED",
        "The remote host cannot open that folder.",
      );
    case "WORKSPACE_OUTSIDE_ROOTS":
      return new GatewayOperationError(
        "WORKSPACE_OUTSIDE_ROOTS",
        "The selected folder is outside the available roots.",
      );
    case "WORKSPACE_REQUEST_ABORTED":
      return new GatewayOperationError(
        "TARGET_DISCONNECTED",
        "The remote workspace request was cancelled.",
      );
    case "WORKSPACE_INVALID_PATH":
      return new GatewayOperationError(
        "INVALID_REQUEST",
        "The selected workspace path is invalid.",
      );
    case "WORKSPACE_IO_FAILED":
      return new GatewayOperationError(
        "INTERNAL_ERROR",
        "The remote host could not read that workspace.",
      );
  }
}

export class HostControlGateway {
  private readonly session: RemoteSession;
  private readonly handshake: HandshakeGate;
  private readonly approvedScopes: ReadonlySet<string>;
  private readonly attached = new Map<string, AttachmentPump>();
  private readonly owned = new Set<string>();
  private readonly unsubscribeOutput: () => void;
  private readonly unsubscribeChanged: () => void;
  private closed = false;

  constructor(private readonly options: HostControlGatewayOptions) {
    this.session = RemoteSessionSchema.parse(options.session);
    if (
      (this.session.status !== "approved" &&
        this.session.status !== "signaling" &&
        this.session.status !== "connected") ||
      !this.session.approvedScopes
    ) {
      throw new Error("REMOTE_SESSION_NOT_APPROVED");
    }
    this.approvedScopes = new Set(this.session.approvedScopes);
    this.handshake = new HandshakeGate({
      role: "host",
      negotiationId: options.negotiationId,
      sessionId: this.session.sessionId,
      signer: options.hostSigner,
      publicKeyResolver: options.publicKeyResolver,
    });
    this.unsubscribeOutput = options.manager.onOutput((chunk) => {
      const pump = this.attached.get(chunk.terminalId);
      if (!pump || this.closed) return;
      void pump.pump().catch((error) => this.report(error));
    });
    this.unsubscribeChanged = options.manager.onChanged((descriptor) => {
      if (this.closed || !this.attached.has(descriptor.id)) return;
      this.sendControl({
        type: "terminal.changed",
        terminal: remoteDescriptor(descriptor),
      });
      if (descriptor.state === "exited") this.detach(descriptor.id);
    });
  }

  get authorized(): boolean {
    return !this.closed && this.handshake.authorized;
  }

  async handleControl(rawMessage: unknown): Promise<void> {
    if (this.closed) throw new Error("HOST_CONTROL_GATEWAY_CLOSED");
    const parsed = RemoteControlMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      const identity = operationIdentity(rawMessage);
      if (identity) {
        this.sendOperationError(
          identity.requestId,
          identity.operation,
          this.authorized ? "INVALID_REQUEST" : "HANDSHAKE_REQUIRED",
          this.authorized
            ? "The remote operation request is invalid."
            : "Complete the authenticated handshake first.",
        );
        return;
      }
      throw new Error("REMOTE_CONTROL_MESSAGE_INVALID");
    }
    const message = parsed.data;
    if (message.type === "hello") {
      if (this.handshake.authorized) {
        throw new Error("REMOTE_HELLO_ALREADY_ACCEPTED");
      }
      this.assertHelloBinding(message);
      const acknowledgement = await this.handshake.acceptClientHello(message);
      this.sendControl(acknowledgement);
      return;
    }
    if (!this.authorized) {
      const operation = operationForMessage(message);
      if (operation) {
        this.sendOperationError(
          operation.requestId,
          operation.operation,
          "HANDSHAKE_REQUIRED",
          "Complete the authenticated handshake first.",
        );
        return;
      }
      if ("requestId" in message && message.type.startsWith("terminal.")) {
        this.sendTerminalError(
          message.requestId,
          "HANDSHAKE_REQUIRED",
          "Complete the authenticated handshake first.",
        );
        return;
      }
      throw new Error("REMOTE_HANDSHAKE_REQUIRED");
    }

    const operation = operationForMessage(message);
    try {
      await this.handleAuthorized(message);
    } catch (error) {
      if (operation) {
        const mapped =
          error instanceof WorkspaceServiceError
            ? workspaceError(error)
            : error instanceof GatewayOperationError
              ? error
              : new GatewayOperationError(
                  "INTERNAL_ERROR",
                  "The remote host could not complete that operation.",
                );
        this.sendOperationError(
          operation.requestId,
          operation.operation,
          mapped.code,
          mapped.message,
        );
        if (!(error instanceof WorkspaceServiceError)) this.report(error);
        return;
      }
      if ("requestId" in message && message.type.startsWith("terminal.")) {
        const code =
          error instanceof GatewayTerminalError
            ? error.code
            : error instanceof GatewayOperationError
              ? error.code
              : "INTERNAL_ERROR";
        this.sendTerminalError(
          message.requestId,
          code,
          error instanceof Error ? error.message : "Remote terminal failed.",
        );
        return;
      }
      throw error;
    }
  }

  async onBufferedAmountLow(): Promise<void> {
    if (this.closed) return;
    await Promise.all(
      [...this.attached.values()].map((pump) => pump.onBufferedAmountLow()),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeOutput();
    this.unsubscribeChanged();
    for (const pump of this.attached.values()) pump.close();
    this.attached.clear();
    this.owned.clear();
  }

  private assertHelloBinding(
    message: Extract<RemoteControlMessage, { type: "hello" }>,
  ): void {
    if (
      message.negotiationId !== this.handshake.negotiationId ||
      message.sessionId !== this.session.sessionId ||
      message.clientDeviceId !== this.session.clientDeviceId ||
      message.hostDeviceId !== this.session.hostDeviceId ||
      message.clientKeyThumbprint !== this.session.clientKeyThumbprint ||
      message.hostKeyThumbprint !== this.session.hostKeyThumbprint ||
      message.clientDeviceGeneration !== this.session.clientDeviceGeneration ||
      message.hostDeviceGeneration !== this.session.hostDeviceGeneration ||
      message.clientChallenge !== this.session.clientChallenge ||
      message.hostChallenge !== this.session.hostChallenge
    ) {
      throw new Error("HELLO_SESSION_BINDING_MISMATCH");
    }
  }

  private async handleAuthorized(message: RemoteControlMessage): Promise<void> {
    switch (message.type) {
      case "workspace.roots": {
        this.requireScope("workspace.read");
        this.sendControl({
          type: "workspace.ok",
          requestId: message.requestId,
          operation: "workspace.roots",
          result: { roots: await this.options.workspace.roots() },
        });
        return;
      }
      case "workspace.list": {
        this.requireScope("workspace.read");
        this.sendControl({
          type: "workspace.ok",
          requestId: message.requestId,
          operation: "workspace.list",
          result: { page: await this.options.workspace.list(message.path) },
        });
        return;
      }
      case "workspace.validate": {
        this.requireScope("workspace.read");
        this.sendControl({
          type: "workspace.ok",
          requestId: message.requestId,
          operation: "workspace.validate",
          result: {
            workspace: await this.options.workspace.validate(message.path),
          },
        });
        return;
      }
      case "agent.runtimes": {
        this.requireScope("agent.runtimes");
        this.sendControl({
          type: "agent.ok",
          requestId: message.requestId,
          operation: "agent.runtimes",
          result: {
            runtimes: AgentRuntimeSchema.array().parse(
              await this.options.listRuntimes(),
            ),
          },
        });
        return;
      }
      case "agent.launch": {
        this.requireScope("agent.launch");
        const workspace = await this.options.workspace.validate(message.cwd);
        const runtimes = AgentRuntimeSchema.array().parse(
          await this.options.listRuntimes(),
        );
        const selected = runtimes.find(
          (runtime) => runtime.kind === message.agent.kind,
        );
        if (
          !selected?.available ||
          (message.agent.yolo && !selected.supportsYolo) ||
          (selected.modelRequired && !message.agent.model)
        ) {
          throw new GatewayOperationError(
            "RUNTIME_UNAVAILABLE",
            "The selected agent runtime is unavailable on this device.",
          );
        }
        const terminal = await this.options.manager.create({
          cols: message.cols,
          rows: message.rows,
          cwd: workspace.path,
          agent: message.agent,
        });
        this.owned.add(terminal.id);
        await this.attach(terminal.id);
        this.sendControl({
          type: "agent.ok",
          requestId: message.requestId,
          operation: "agent.launch",
          result: { terminal: remoteDescriptor(terminal) },
        });
        return;
      }
      case "terminal.list": {
        this.requireScope("terminal.list");
        this.sendControl({
          type: "terminal.ok",
          requestId: message.requestId,
          operation: "terminal.list",
          result: {
            terminals: (await this.options.manager.list()).map(
              remoteDescriptor,
            ),
          },
        });
        return;
      }
      case "terminal.create": {
        this.requireScope("terminal.create");
        const terminal = await this.options.manager.create({
          cols: message.cols,
          rows: message.rows,
        });
        this.owned.add(terminal.id);
        this.sendControl({
          type: "terminal.ok",
          requestId: message.requestId,
          operation: "terminal.create",
          result: { terminal: remoteDescriptor(terminal) },
        });
        return;
      }
      case "terminal.attach": {
        this.requireScope("terminal.attach");
        const exists = (await this.options.manager.list()).some(
          (terminal) => terminal.id === message.terminalId,
        );
        if (!exists) this.terminalNotFound();
        await this.attach(message.terminalId);
        this.sendTerminalOk(
          message.requestId,
          "terminal.attach",
          message.terminalId,
        );
        return;
      }
      case "terminal.detach": {
        this.requireScope("terminal.detach");
        this.requireAttached(message.terminalId);
        this.detach(message.terminalId);
        this.sendTerminalOk(
          message.requestId,
          "terminal.detach",
          message.terminalId,
        );
        return;
      }
      case "terminal.write": {
        this.requireScope("terminal.write");
        this.requireAttached(message.terminalId);
        await this.options.manager.write({
          terminalId: message.terminalId,
          data: message.data,
        });
        this.sendTerminalOk(
          message.requestId,
          "terminal.write",
          message.terminalId,
        );
        return;
      }
      case "terminal.resize": {
        this.requireScope("terminal.resize");
        this.requireAttached(message.terminalId);
        await this.options.manager.resize({
          terminalId: message.terminalId,
          cols: message.cols,
          rows: message.rows,
        });
        this.sendTerminalOk(
          message.requestId,
          "terminal.resize",
          message.terminalId,
        );
        return;
      }
      case "terminal.cursor_ack": {
        const pump = this.requireAttached(message.terminalId);
        pump.acknowledge(BigInt(message.cursor));
        await pump.pump();
        return;
      }
      case "ping":
        this.sendControl({ type: "pong", nonce: message.nonce });
        return;
      case "session.close":
        this.close();
        return;
      case "hello":
        throw new Error("REMOTE_HELLO_ALREADY_ACCEPTED");
      case "hello_ack":
      case "workspace.ok":
      case "agent.ok":
      case "operation.error":
      case "terminal.ok":
      case "terminal.error":
      case "terminal.changed":
      case "pong":
        throw new Error("REMOTE_CONTROL_DIRECTION_INVALID");
    }
  }

  private requireScope(scope: string): void {
    if (!this.approvedScopes.has(scope)) {
      throw new GatewayOperationError(
        "SCOPE_DENIED",
        "This remote session does not allow that operation.",
      );
    }
  }

  private async attach(terminalId: string): Promise<void> {
    this.detach(terminalId);
    const pump = new AttachmentPump({
      terminalId,
      store: this.options.outputStore,
      channel: this.options.terminalSender,
    });
    this.attached.set(terminalId, pump);
    await pump.pump();
  }

  private detach(terminalId: string): void {
    this.attached.get(terminalId)?.close();
    this.attached.delete(terminalId);
  }

  private requireAttached(terminalId: string): AttachmentPump {
    const pump = this.attached.get(terminalId);
    if (!pump) {
      throw new GatewayTerminalError("TERMINAL_NOT_ATTACHED");
    }
    return pump;
  }

  private terminalNotFound(): never {
    throw new GatewayTerminalError("TERMINAL_NOT_FOUND");
  }

  private sendControl(message: RemoteControlMessage): void {
    this.options.controlSender.send(RemoteControlMessageSchema.parse(message));
  }

  private sendOperationError(
    requestId: string,
    operation: RemoteOperationName,
    code: OperationErrorCode,
    message: string,
  ): void {
    this.sendControl({
      type: "operation.error",
      requestId,
      operation,
      code,
      message,
    });
  }

  private sendTerminalOk(
    requestId: string,
    operation:
      | "terminal.attach"
      | "terminal.detach"
      | "terminal.write"
      | "terminal.resize",
    terminalId: string,
  ): void {
    this.sendControl({
      type: "terminal.ok",
      requestId,
      operation,
      result: { terminalId },
    });
  }

  private sendTerminalError(
    requestId: string,
    code: string,
    message: string,
  ): void {
    this.sendControl({ type: "terminal.error", requestId, code, message });
  }

  private report(error: unknown): void {
    (this.options.reportError ?? console.error)(error);
  }
}

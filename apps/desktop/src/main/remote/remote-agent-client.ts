import { randomUUID } from "node:crypto";
import {
  HelloSchema,
  RemoteControlMessageSchema,
  RemoteSessionSchema,
  decodeOutputFrameBinary,
  decodeRemoteControlMessage,
  encodeRemoteControlMessageBinary,
  type AgentLaunchRequest,
  type AgentLaunchTarget,
  type AgentLaunchTargetState,
  type AgentRuntime,
  type OutputFrame,
  type RemoteControlMessage,
  type RemoteDevice,
  type RemoteAgentExecutionTarget,
  type RemoteSession,
  type RemoteTerminalDescriptor,
  type WorkspaceDirectoryPage,
  type WorkspaceRoot,
  type WorkspaceSelection,
} from "@codra/protocol";
import { HandshakeGate, signCanonical } from "@codra/webrtc";
import type { PeerChannelPort } from "./peer-session";

export class RemoteAgentOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAgentOperationError";
  }
}

type RemoteTargetDevice = Pick<RemoteDevice, "deviceId" | "displayName"> &
  Partial<
    Pick<
      RemoteDevice,
      "active" | "remoteAccessEnabled" | "expiresAt" | "generation"
    >
  >;

export interface RemoteAgentClientOptions {
  enabled(): boolean;
  currentDeviceId(): string | undefined;
  listDevices(): Promise<RemoteTargetDevice[]>;
  connect(
    device: RemoteTargetDevice,
    update: (state: AgentLaunchTargetState, message?: string) => void,
  ): Promise<RemoteAgentChannelClient>;
  now?: () => number;
}

const localLaunchTarget = (): AgentLaunchTarget => ({
  target: { kind: "local" },
  state: "connected",
});

export class RemoteAgentClient {
  private readonly devices = new Map<string, RemoteTargetDevice>();
  private readonly states = new Map<
    string,
    { state: AgentLaunchTargetState; message?: string }
  >();
  private readonly peers = new Map<string, RemoteAgentChannelClient>();
  private readonly connecting = new Map<
    string,
    Promise<RemoteAgentChannelClient>
  >();
  private readonly listeners = new Set<
    (targets: AgentLaunchTarget[]) => void
  >();
  private readonly now: () => number;

  constructor(private readonly options: RemoteAgentClientOptions) {
    this.now = options.now ?? Date.now;
  }

  async refreshTargets(): Promise<AgentLaunchTarget[]> {
    if (!this.options.enabled()) {
      this.devices.clear();
      this.states.clear();
      this.publish();
      return this.snapshot();
    }
    const currentDeviceId = this.options.currentDeviceId();
    const listed = await this.options.listDevices();
    const visible = listed.filter(
      (device) =>
        device.deviceId !== currentDeviceId &&
        device.active !== false &&
        device.remoteAccessEnabled !== false &&
        (device.expiresAt === undefined || device.expiresAt > this.now()),
    );
    const visibleIds = new Set(visible.map((device) => device.deviceId));
    for (const deviceId of this.devices.keys()) {
      if (!visibleIds.has(deviceId) && !this.peers.has(deviceId)) {
        this.devices.delete(deviceId);
        this.states.delete(deviceId);
      }
    }
    for (const device of visible) {
      this.devices.set(device.deviceId, device);
      this.states.set(
        device.deviceId,
        this.states.get(device.deviceId) ?? { state: "available" },
      );
    }
    this.publish();
    return this.snapshot();
  }

  async connectTarget(
    target: RemoteAgentExecutionTarget,
  ): Promise<AgentLaunchTarget> {
    if (!this.options.enabled()) throw new Error("REMOTE_ACCESS_DISABLED");
    if (target.deviceId === this.options.currentDeviceId()) {
      throw new Error("REMOTE_SELF_TARGET_DENIED");
    }
    if (this.peers.has(target.deviceId)) {
      return this.launchTarget(target.deviceId);
    }
    let device = this.devices.get(target.deviceId);
    if (!device) {
      await this.refreshTargets();
      device = this.devices.get(target.deviceId);
    }
    if (!device) throw new Error("REMOTE_TARGET_OFFLINE");
    const canonicalTarget: RemoteAgentExecutionTarget = {
      kind: "remote",
      deviceId: device.deviceId,
      displayName: device.displayName,
    };
    const existing = this.connecting.get(device.deviceId);
    if (existing) {
      await existing;
      return this.launchTarget(device.deviceId);
    }
    const update = (state: AgentLaunchTargetState, message?: string): void => {
      this.states.set(device!.deviceId, {
        state,
        ...(message ? { message } : {}),
      });
      this.publish();
    };
    update("waiting_for_approval");
    const operation = this.options.connect(device, update);
    this.connecting.set(device.deviceId, operation);
    try {
      const peer = await operation;
      this.peers.set(device.deviceId, peer);
      peer.onDisconnected(() => {
        if (this.peers.get(device!.deviceId) !== peer) return;
        this.peers.delete(device!.deviceId);
        this.states.set(device!.deviceId, {
          state: "offline",
          message: "TARGET_DISCONNECTED",
        });
        this.publish();
      });
      update("connected");
      return { target: canonicalTarget, state: "connected" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "REMOTE_ERROR";
      update(
        message.includes("REJECT") ? "rejected" : "error",
        message.slice(0, 160),
      );
      throw error;
    } finally {
      this.connecting.delete(device.deviceId);
    }
  }

  peerFor(target: RemoteAgentExecutionTarget): RemoteAgentChannelClient {
    const peer = this.peers.get(target.deviceId);
    if (!peer) throw new Error("TARGET_DISCONNECTED");
    return peer;
  }

  onTargetsChanged(
    listener: (targets: AgentLaunchTarget[]) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async disconnectAll(): Promise<void> {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.connecting.clear();
    for (const deviceId of this.states.keys()) {
      this.states.set(deviceId, { state: "available" });
    }
    this.publish();
  }

  private launchTarget(deviceId: string): AgentLaunchTarget {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error("REMOTE_TARGET_OFFLINE");
    const state = this.states.get(deviceId) ?? { state: "available" as const };
    return {
      target: {
        kind: "remote",
        deviceId,
        displayName: device.displayName,
      },
      ...state,
    };
  }

  private snapshot(): AgentLaunchTarget[] {
    return [
      localLaunchTarget(),
      ...[...this.devices.keys()]
        .sort((left, right) => {
          const leftName = this.devices.get(left)?.displayName ?? "";
          const rightName = this.devices.get(right)?.displayName ?? "";
          return leftName.localeCompare(rightName, undefined, {
            numeric: true,
            sensitivity: "base",
          });
        })
        .map((deviceId) => this.launchTarget(deviceId)),
    ];
  }

  private publish(): void {
    const targets = this.snapshot();
    for (const listener of this.listeners) listener(targets);
  }
}

export interface RemoteAgentChannelClientOptions {
  session: RemoteSession;
  negotiationId: string;
  clientSigner: CryptoKey;
  hostPublicKey: CryptoKey;
  control: PeerChannelPort;
  terminal: PeerChannelPort;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(message: RemoteControlMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class RemoteAgentChannelClient {
  private readonly session: RemoteSession;
  private readonly handshake: HandshakeGate;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly outputListeners = new Set<(frame: OutputFrame) => void>();
  private readonly changedListeners = new Set<
    (terminal: RemoteTerminalDescriptor) => void
  >();
  private readonly disconnectedListeners = new Set<(error: Error) => void>();
  private hello: ReturnType<typeof HelloSchema.parse> | undefined;
  private startPromise: Promise<void> | undefined;
  private resolveHandshake: (() => void) | undefined;
  private rejectHandshake: ((error: Error) => void) | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly options: RemoteAgentChannelClientOptions) {
    this.session = RemoteSessionSchema.parse(options.session);
    if (!this.session.hostChallenge || !this.session.approvedScopes) {
      throw new Error("REMOTE_SESSION_NOT_APPROVED");
    }
    this.handshake = new HandshakeGate({
      role: "browser",
      sessionId: this.session.sessionId,
      negotiationId: options.negotiationId,
      publicKeyResolver: async (thumbprint) =>
        thumbprint === this.session.hostKeyThumbprint
          ? options.hostPublicKey
          : undefined,
    });
    options.control.onMessage((message) => this.receiveControl(message));
    options.control.onClosed(() =>
      this.fail(new Error("REMOTE_CONTROL_CHANNEL_CLOSED")),
    );
    options.control.onError((error) => this.fail(error));
    options.terminal.onMessage((message) => this.receiveTerminal(message));
    options.terminal.onClosed(() =>
      this.fail(new Error("REMOTE_TERMINAL_CHANNEL_CLOSED")),
    );
    options.terminal.onError((error) => this.fail(error));
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("REMOTE_PEER_CLOSED"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveHandshake = resolve;
      this.rejectHandshake = reject;
    });
    const timeout = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.handshakeTimer = setTimeout(
      () => this.fail(new Error("REMOTE_HANDSHAKE_TIMEOUT")),
      timeout,
    );
    void this.sendHello().catch((error: unknown) =>
      this.fail(
        error instanceof Error ? error : new Error("REMOTE_HELLO_FAILED"),
      ),
    );
    return this.startPromise;
  }

  async workspaceRoots(): Promise<WorkspaceRoot[]> {
    const response = await this.request({
      type: "workspace.roots",
      requestId: randomUUID(),
    });
    if (
      response.type !== "workspace.ok" ||
      response.operation !== "workspace.roots"
    ) {
      throw new Error("REMOTE_RESPONSE_OPERATION_MISMATCH");
    }
    return response.result.roots;
  }

  async workspaceList(path: string): Promise<WorkspaceDirectoryPage> {
    const response = await this.request({
      type: "workspace.list",
      requestId: randomUUID(),
      path,
    });
    if (
      response.type !== "workspace.ok" ||
      response.operation !== "workspace.list"
    ) {
      throw new Error("REMOTE_RESPONSE_OPERATION_MISMATCH");
    }
    return response.result.page;
  }

  async workspaceValidate(path: string): Promise<WorkspaceSelection> {
    const response = await this.request({
      type: "workspace.validate",
      requestId: randomUUID(),
      path,
    });
    if (
      response.type !== "workspace.ok" ||
      response.operation !== "workspace.validate"
    ) {
      throw new Error("REMOTE_RESPONSE_OPERATION_MISMATCH");
    }
    return response.result.workspace;
  }

  async runtimes(): Promise<AgentRuntime[]> {
    const response = await this.request({
      type: "agent.runtimes",
      requestId: randomUUID(),
    });
    if (
      response.type !== "agent.ok" ||
      response.operation !== "agent.runtimes"
    ) {
      throw new Error("REMOTE_RESPONSE_OPERATION_MISMATCH");
    }
    return response.result.runtimes;
  }

  async launch(
    cwd: string,
    agent: AgentLaunchRequest,
    cols: number,
    rows: number,
  ): Promise<RemoteTerminalDescriptor> {
    const response = await this.request({
      type: "agent.launch",
      requestId: randomUUID(),
      cwd,
      agent,
      cols,
      rows,
    });
    if (response.type !== "agent.ok" || response.operation !== "agent.launch") {
      throw new Error("REMOTE_RESPONSE_OPERATION_MISMATCH");
    }
    return response.result.terminal;
  }

  async write(terminalId: string, data: string): Promise<void> {
    await this.expectTerminalOk(
      await this.request({
        type: "terminal.write",
        requestId: randomUUID(),
        terminalId,
        data,
      }),
      "terminal.write",
      terminalId,
    );
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    await this.expectTerminalOk(
      await this.request({
        type: "terminal.resize",
        requestId: randomUUID(),
        terminalId,
        cols,
        rows,
      }),
      "terminal.resize",
      terminalId,
    );
  }

  async detach(terminalId: string): Promise<void> {
    await this.expectTerminalOk(
      await this.request({
        type: "terminal.detach",
        requestId: randomUUID(),
        terminalId,
      }),
      "terminal.detach",
      terminalId,
    );
  }

  acknowledge(terminalId: string, cursor: bigint): void {
    this.sendControl({
      type: "terminal.cursor_ack",
      terminalId,
      cursor: cursor.toString(),
    });
  }

  onOutputFrame(listener: (frame: OutputFrame) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onTerminalChanged(
    listener: (terminal: RemoteTerminalDescriptor) => void,
  ): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  onDisconnected(listener: (error: Error) => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => this.disconnectedListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    if (this.handshake.authorized) {
      try {
        this.sendControl({
          type: "session.close",
          reason: "USER_REQUESTED",
        });
      } catch {
        // The peer can already be gone while local cleanup is running.
      }
    }
    this.closeWithError(new Error("REMOTE_PEER_CLOSED"), false);
  }

  private async sendHello(): Promise<void> {
    const unsigned = HelloSchema.omit({ signature: true }).parse({
      type: "hello",
      domain: "codra.hello.v1",
      protocolVersion: this.session.protocolVersion,
      sessionId: this.session.sessionId,
      negotiationId: this.options.negotiationId,
      clientDeviceId: this.session.clientDeviceId,
      hostDeviceId: this.session.hostDeviceId,
      clientKeyThumbprint: this.session.clientKeyThumbprint,
      hostKeyThumbprint: this.session.hostKeyThumbprint,
      clientDeviceGeneration: this.session.clientDeviceGeneration,
      hostDeviceGeneration: this.session.hostDeviceGeneration,
      clientChallenge: this.session.clientChallenge,
      hostChallenge: this.session.hostChallenge,
    });
    this.hello = HelloSchema.parse({
      ...unsigned,
      signature: await signCanonical(this.options.clientSigner, unsigned),
    });
    this.sendControl(this.hello);
  }

  private request(
    message: RemoteControlMessage,
  ): Promise<RemoteControlMessage> {
    if (!("requestId" in message)) {
      return Promise.reject(new Error("REMOTE_REQUEST_ID_REQUIRED"));
    }
    return this.start().then(
      () =>
        new Promise<RemoteControlMessage>((resolve, reject) => {
          const requestId = message.requestId;
          const timeout =
            this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
          const timer = setTimeout(() => {
            this.pending.delete(requestId);
            reject(new Error("REMOTE_REQUEST_TIMEOUT"));
          }, timeout);
          this.pending.set(requestId, { resolve, reject, timer });
          try {
            this.sendControl(message);
          } catch (error) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            reject(
              error instanceof Error
                ? error
                : new Error("REMOTE_REQUEST_SEND_FAILED"),
            );
          }
        }),
    );
  }

  private receiveControl(rawMessage: ArrayBuffer | Uint8Array | string): void {
    void this.processControl(rawMessage).catch((error: unknown) =>
      this.fail(
        error instanceof Error
          ? error
          : new Error("REMOTE_CONTROL_PROCESSING_FAILED"),
      ),
    );
  }

  private async processControl(
    rawMessage: ArrayBuffer | Uint8Array | string,
  ): Promise<void> {
    if (this.closed) return;
    if (typeof rawMessage === "string") {
      throw new Error("REMOTE_CONTROL_BINARY_REQUIRED");
    }
    const message = decodeRemoteControlMessage(rawMessage);
    if (message.type === "hello_ack") {
      if (!this.hello) throw new Error("REMOTE_HELLO_NOT_SENT");
      await this.handshake.verifyHelloAck(message, this.hello);
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.resolveHandshake?.();
      this.resolveHandshake = undefined;
      this.rejectHandshake = undefined;
      return;
    }
    if (message.type === "terminal.changed") {
      if (!this.handshake.authorized)
        throw new Error("REMOTE_HANDSHAKE_REQUIRED");
      for (const listener of this.changedListeners) listener(message.terminal);
      return;
    }
    if (message.type === "session.close") {
      this.fail(new Error(`REMOTE_SESSION_${message.reason}`));
      return;
    }
    if ("requestId" in message) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (
        message.type === "operation.error" ||
        message.type === "terminal.error"
      ) {
        pending.reject(
          new RemoteAgentOperationError(message.code, message.message),
        );
      } else {
        pending.resolve(message);
      }
      return;
    }
    if (message.type === "pong") return;
    throw new Error("REMOTE_CONTROL_DIRECTION_INVALID");
  }

  private receiveTerminal(rawMessage: ArrayBuffer | Uint8Array | string): void {
    try {
      if (typeof rawMessage === "string")
        throw new Error("REMOTE_TERMINAL_BINARY_REQUIRED");
      const frame = decodeOutputFrameBinary(rawMessage);
      for (const listener of this.outputListeners) listener(frame);
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("REMOTE_TERMINAL_FRAME_INVALID"),
      );
    }
  }

  private expectTerminalOk(
    message: RemoteControlMessage,
    operation: "terminal.write" | "terminal.resize" | "terminal.detach",
    terminalId: string,
  ): void {
    if (
      message.type !== "terminal.ok" ||
      message.operation !== operation ||
      message.result.terminalId !== terminalId
    ) {
      throw new Error("REMOTE_RESPONSE_OPERATION_MISMATCH");
    }
  }

  private sendControl(message: RemoteControlMessage): void {
    if (this.closed) throw new Error("REMOTE_PEER_CLOSED");
    this.options.control.send(
      encodeRemoteControlMessageBinary(
        RemoteControlMessageSchema.parse(message),
      ),
    );
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closeWithError(error, true);
  }

  private closeWithError(error: Error, notify: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.rejectHandshake?.(error);
    this.resolveHandshake = undefined;
    this.rejectHandshake = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.options.control.close();
    this.options.terminal.close();
    if (notify) {
      for (const listener of this.disconnectedListeners) listener(error);
    }
  }
}

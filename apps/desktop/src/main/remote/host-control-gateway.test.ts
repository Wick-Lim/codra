import type {
  AgentRuntime,
  CreateTerminalRequest,
  RemoteControlMessage,
  RemoteSession,
  ResizeTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
  WriteTerminalRequest,
  WorkspaceDirectoryPage,
  WorkspaceRoot,
  WorkspaceSelection,
} from "@codra/protocol";
import {
  HelloSchema,
  RemoteControlMessageSchema,
  RemoteSessionSchema,
  decodeOutputFrameBinary,
} from "@codra/protocol";
import { signCanonical } from "@codra/webrtc";
import { describe, expect, it } from "vitest";
import {
  HostControlGateway,
  type HostControlTerminalManager,
  type HostWorkspacePort,
} from "./host-control-gateway";
import { WorkspaceServiceError } from "./workspace-service";

const terminalId = "f4b0f73d-3406-48ec-a5c2-2cf290905e99";
const clientDeviceId = "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d";
const hostDeviceId = "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1";
const clientThumbprint = "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M";
const hostThumbprint = "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo";
const negotiationId = "negotiation-1";

const runtime: AgentRuntime = {
  kind: "codex",
  label: "Codex CLI",
  description: "OpenAI's coding agent for repository work.",
  available: true,
  supportsYolo: true,
  modelRequired: false,
  efforts: [{ id: "high", label: "High" }],
  models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
  installHint: "Install Codex CLI to use this runtime.",
  setup: {
    installMethod: "managed_npm",
    authentication: "required",
  },
};

const terminal: TerminalDescriptor = {
  id: terminalId,
  title: "Codex",
  cwd: "/Users/codra/project",
  cols: 100,
  rows: 30,
  state: "running",
  createdAt: "2026-08-02T00:00:00.000Z",
};

class TerminalManagerFake implements HostControlTerminalManager {
  readonly created: CreateTerminalRequest[] = [];
  readonly writes: WriteTerminalRequest[] = [];
  readonly resizes: ResizeTerminalRequest[] = [];
  private readonly outputListeners = new Set<
    (chunk: TerminalOutputChunk) => void
  >();
  private readonly changedListeners = new Set<
    (descriptor: TerminalDescriptor) => void
  >();

  async list(): Promise<TerminalDescriptor[]> {
    return [terminal];
  }

  async create(request: CreateTerminalRequest): Promise<TerminalDescriptor> {
    this.created.push(request);
    return terminal;
  }

  async write(request: WriteTerminalRequest): Promise<void> {
    this.writes.push(request);
  }

  async resize(request: ResizeTerminalRequest): Promise<void> {
    this.resizes.push(request);
  }

  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onChanged(listener: (descriptor: TerminalDescriptor) => void): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  emitOutput(chunk: TerminalOutputChunk): void {
    for (const listener of this.outputListeners) listener(chunk);
  }

  emitChanged(descriptor: TerminalDescriptor): void {
    for (const listener of this.changedListeners) listener(descriptor);
  }
}

class WorkspaceFake implements HostWorkspacePort {
  readonly root: WorkspaceRoot = { path: "/Users/codra", label: "Home" };
  readonly workspace: WorkspaceSelection = {
    path: "/Users/codra/project",
    label: "project",
  };

  async roots(): Promise<WorkspaceRoot[]> {
    return [this.root];
  }

  async list(path: string): Promise<WorkspaceDirectoryPage> {
    return {
      path,
      label: path.split("/").at(-1) || "/",
      breadcrumbs: [this.root],
      entries: [{ path: this.workspace.path, name: this.workspace.label }],
    };
  }

  async validate(path: string): Promise<WorkspaceSelection> {
    if (path === "/missing") {
      throw new WorkspaceServiceError("WORKSPACE_NOT_FOUND");
    }
    return { ...this.workspace, path };
  }
}

function session(scopes: readonly string[]): RemoteSession {
  return RemoteSessionSchema.parse({
    sessionId: "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f",
    ownerUid: "owner-uid",
    clientDeviceId,
    hostDeviceId,
    clientKeyThumbprint: clientThumbprint,
    hostKeyThumbprint: hostThumbprint,
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 2,
    protocolVersion: 1,
    requestedScopes: [...scopes],
    approvedScopes: [...scopes],
    clientChallenge: "client-challenge",
    hostChallenge: "host-challenge",
    requestSignature: "A".repeat(86),
    approvalSignature: "A".repeat(86),
    createdAt: 1_700_000_000_000,
    decidedAt: 1_700_000_000_001,
    expiresAt: 1_700_000_000_000 + 60 * 60 * 1000,
    status: "approved",
  });
}

async function createHarness(scopes: readonly string[]) {
  const clientKeys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const hostKeys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const currentSession = session(scopes);
  const manager = new TerminalManagerFake();
  const workspace = new WorkspaceFake();
  const control: RemoteControlMessage[] = [];
  const terminalFrames: ArrayBuffer[] = [];
  const gateway = new HostControlGateway({
    session: currentSession,
    negotiationId,
    hostSigner: hostKeys.privateKey,
    publicKeyResolver: async (thumbprint) =>
      thumbprint === clientThumbprint ? clientKeys.publicKey : undefined,
    workspace,
    listRuntimes: async () => [runtime],
    manager,
    outputStore: {
      async readFromCursor(id, afterCursor) {
        if (id !== terminalId || afterCursor > 0n) {
          return {
            chunks: [],
            earliestCursor: 0n,
            latestCursor: 5n,
            truncated: false,
          };
        }
        return {
          chunks: [
            {
              sequence: 1n,
              startCursor: 0n,
              endCursor: 5n,
              data: new TextEncoder().encode("ready"),
            },
          ],
          earliestCursor: 0n,
          latestCursor: 5n,
          truncated: false,
        };
      },
    },
    controlSender: {
      send(message) {
        control.push(RemoteControlMessageSchema.parse(message));
      },
    },
    terminalSender: {
      bufferedAmount: 0,
      send(frame) {
        terminalFrames.push(frame);
      },
    },
  });

  async function authorize(overrides: Record<string, unknown> = {}) {
    const unsigned = HelloSchema.omit({ signature: true }).parse({
      type: "hello",
      domain: "codra.hello.v1",
      protocolVersion: 1,
      sessionId: currentSession.sessionId,
      negotiationId,
      clientDeviceId,
      hostDeviceId,
      clientKeyThumbprint: clientThumbprint,
      hostKeyThumbprint: hostThumbprint,
      clientDeviceGeneration: 1,
      hostDeviceGeneration: 2,
      clientChallenge: "client-challenge",
      hostChallenge: "host-challenge",
      ...overrides,
    });
    await gateway.handleControl({
      ...unsigned,
      signature: await signCanonical(clientKeys.privateKey, unsigned),
    });
  }

  return {
    gateway,
    manager,
    workspace,
    control,
    terminalFrames,
    authorize,
  };
}

describe("HostControlGateway", () => {
  it("requires a session-bound signed hello before handling operations", async () => {
    const harness = await createHarness(["workspace.read"]);

    await harness.gateway.handleControl({
      type: "workspace.roots",
      requestId: "roots-before-hello",
    });
    expect(harness.control).toEqual([
      {
        type: "operation.error",
        requestId: "roots-before-hello",
        operation: "workspace.roots",
        code: "HANDSHAKE_REQUIRED",
        message: "Complete the authenticated handshake first.",
      },
    ]);

    await harness.authorize();
    expect(harness.gateway.authorized).toBe(true);
    expect(harness.control.at(-1)).toMatchObject({
      type: "hello_ack",
      sessionId: session(["workspace.read"]).sessionId,
      negotiationId,
    });
    await expect(harness.authorize()).rejects.toThrow(
      "REMOTE_HELLO_ALREADY_ACCEPTED",
    );
  });

  it("rejects a valid signature when hello fields do not match the session", async () => {
    const harness = await createHarness(["workspace.read"]);

    await expect(
      harness.authorize({ hostDeviceId: crypto.randomUUID() }),
    ).rejects.toThrow("HELLO_SESSION_BINDING_MISMATCH");

    expect(harness.gateway.authorized).toBe(false);
    expect(harness.control).toEqual([]);
  });

  it("enforces exact scopes and returns correlated workspace/runtime results", async () => {
    const harness = await createHarness(["workspace.read"]);
    await harness.authorize();
    harness.control.length = 0;

    await harness.gateway.handleControl({
      type: "workspace.roots",
      requestId: "roots-1",
    });
    await harness.gateway.handleControl({
      type: "workspace.list",
      requestId: "list-1",
      path: "/Users/codra",
    });
    await harness.gateway.handleControl({
      type: "workspace.validate",
      requestId: "validate-1",
      path: "/missing",
    });
    await harness.gateway.handleControl({
      type: "agent.runtimes",
      requestId: "runtimes-1",
    });

    expect(harness.control).toEqual([
      {
        type: "workspace.ok",
        requestId: "roots-1",
        operation: "workspace.roots",
        result: { roots: [harness.workspace.root] },
      },
      {
        type: "workspace.ok",
        requestId: "list-1",
        operation: "workspace.list",
        result: {
          page: {
            path: "/Users/codra",
            label: "codra",
            breadcrumbs: [harness.workspace.root],
            entries: [{ path: "/Users/codra/project", name: "project" }],
          },
        },
      },
      {
        type: "operation.error",
        requestId: "validate-1",
        operation: "workspace.validate",
        code: "WORKSPACE_NOT_FOUND",
        message: "The selected folder is no longer available.",
      },
      {
        type: "operation.error",
        requestId: "runtimes-1",
        operation: "agent.runtimes",
        code: "SCOPE_DENIED",
        message: "This remote session does not allow that operation.",
      },
    ]);
  });

  it("validates and launches an available runtime, then routes only its attached terminal", async () => {
    const harness = await createHarness([
      "agent.launch",
      "terminal.write",
      "terminal.resize",
      "terminal.detach",
    ]);
    await harness.authorize();
    harness.control.length = 0;

    await harness.gateway.handleControl({
      type: "agent.launch",
      requestId: "launch-1",
      cwd: "/Users/codra/project",
      cols: 100,
      rows: 30,
      agent: {
        kind: "codex",
        yolo: false,
        model: "gpt-5.6-sol",
        effort: "high",
        prompt: "Fix the callback race",
      },
    });

    expect(harness.manager.created).toEqual([
      {
        cols: 100,
        rows: 30,
        cwd: "/Users/codra/project",
        agent: {
          kind: "codex",
          yolo: false,
          model: "gpt-5.6-sol",
          effort: "high",
          prompt: "Fix the callback race",
        },
      },
    ]);
    expect(harness.control).toEqual([
      {
        type: "agent.ok",
        requestId: "launch-1",
        operation: "agent.launch",
        result: {
          terminal: {
            id: terminalId,
            title: "Codex",
            cols: 100,
            rows: 30,
            state: "running",
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        },
      },
    ]);
    expect(harness.terminalFrames).toHaveLength(1);
    expect(decodeOutputFrameBinary(harness.terminalFrames[0]!)).toEqual({
      terminalId,
      cursor: 0n,
      data: new TextEncoder().encode("ready"),
    });

    await harness.gateway.handleControl({
      type: "terminal.cursor_ack",
      terminalId,
      cursor: "5",
    });
    await harness.gateway.handleControl({
      type: "terminal.write",
      requestId: "write-1",
      terminalId,
      data: "pwd\n",
    });
    await harness.gateway.handleControl({
      type: "terminal.resize",
      requestId: "resize-1",
      terminalId,
      cols: 120,
      rows: 36,
    });
    expect(harness.manager.writes).toEqual([{ terminalId, data: "pwd\n" }]);
    expect(harness.manager.resizes).toEqual([
      { terminalId, cols: 120, rows: 36 },
    ]);

    harness.manager.emitChanged({ ...terminal, state: "exited", exitCode: 0 });
    expect(harness.control.at(-1)).toEqual({
      type: "terminal.changed",
      terminal: {
        id: terminalId,
        title: "Codex",
        cols: 100,
        rows: 30,
        state: "exited",
        createdAt: "2026-08-02T00:00:00.000Z",
        exitCode: 0,
      },
    });

    await harness.gateway.handleControl({
      type: "terminal.detach",
      requestId: "detach-1",
      terminalId,
    });
    await harness.gateway.handleControl({
      type: "terminal.write",
      requestId: "write-after-detach",
      terminalId,
      data: "whoami\n",
    });
    expect(harness.manager.writes).toHaveLength(1);
    expect(harness.control.at(-1)).toMatchObject({
      type: "terminal.error",
      requestId: "write-after-detach",
      code: "TERMINAL_NOT_ATTACHED",
    });
  });

  it("rejects malformed launch fields before creating a terminal", async () => {
    const harness = await createHarness(["agent.launch"]);
    await harness.authorize();
    harness.control.length = 0;

    await harness.gateway.handleControl({
      type: "agent.launch",
      requestId: "malformed-launch",
      cwd: "/Users/codra/project",
      cols: 100,
      rows: 30,
      agent: {
        kind: "codex",
        yolo: false,
        prompt: "Review the repository",
      },
      executable: "/bin/sh",
      environment: { TOKEN: "secret" },
    });

    expect(harness.manager.created).toEqual([]);
    expect(harness.control).toEqual([
      {
        type: "operation.error",
        requestId: "malformed-launch",
        operation: "agent.launch",
        code: "INVALID_REQUEST",
        message: "The remote operation request is invalid.",
      },
    ]);
  });

  it("detaches output resources on close without terminating host terminals", async () => {
    const harness = await createHarness(["agent.launch"]);
    await harness.authorize();
    await harness.gateway.handleControl({
      type: "agent.launch",
      requestId: "launch-before-close",
      cwd: "/Users/codra/project",
      cols: 100,
      rows: 30,
      agent: {
        kind: "codex",
        yolo: false,
        prompt: "Review the repository",
      },
    });
    const frameCount = harness.terminalFrames.length;

    harness.gateway.close();
    harness.manager.emitOutput({ terminalId, sequence: 2, data: "later" });

    expect(harness.terminalFrames).toHaveLength(frameCount);
    expect(harness.manager.created).toHaveLength(1);
  });
});

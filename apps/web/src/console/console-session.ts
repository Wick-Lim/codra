import {
  ProxyTerminalRouter,
  type LocalTerminalRouterPort,
  type RemoteAgentChannelClient,
} from "@codra/remote-client";
import type {
  AgentLaunchRequest,
  AgentRuntime,
  RemoteAgentExecutionTarget,
  RemoteDevice,
  TerminalDescriptor,
  WorkspaceDirectoryPage,
  WorkspaceRoot,
  WorkspaceSelection,
} from "@codra/protocol";

/**
 * The size the agent is launched at, before the pane has been laid out.
 *
 * `WebTerminalPane` fits to its container and sends `terminal.resize` within
 * one debounce interval of mounting, so this only has to be a plausible
 * starting shape inside `TerminalSizeSchema`'s bounds (20..400 x 5..200).
 */
export const LAUNCH_COLS = 120;
export const LAUNCH_ROWS = 40;

/**
 * `ProxyTerminalRouter` was written for the desktop, where it wraps a real
 * local terminal manager and adds remote sessions beside it. A browser has no
 * local terminals at all, so the local half is this: it owns nothing, reports
 * nothing, and refuses anything that would only make sense on a host.
 *
 * Refusing rather than silently no-op'ing matters. Every local call the console
 * could make is a bug — the router only reaches the local port for a terminal
 * id it does not know as remote — and a rejected promise says so where an
 * ignored one would strand the caller.
 */
export function createBrowserLocalTerminalRouter(): LocalTerminalRouterPort {
  const unsupported = (): never => {
    throw new Error("CONSOLE_LOCAL_TERMINALS_UNSUPPORTED");
  };
  return {
    list: async () => [],
    create: async () => unsupported(),
    write: async () => unsupported(),
    resize: async () => unsupported(),
    replay: async () => [],
    close: async () => undefined,
    closeAll: async () => undefined,
    onOutput: () => () => undefined,
    onChanged: () => () => undefined,
  };
}

export interface ConsoleTerminalSessionOptions {
  client: RemoteAgentChannelClient;
  host: Pick<RemoteDevice, "deviceId" | "displayName">;
}

/**
 * Everything the console does over a connected channel, in the order the host
 * permits it: browse a workspace, read the runtime catalogue, launch an agent,
 * and then drive the terminal that launch created.
 *
 * The single reason this class exists is the frame path. `ProxyTerminalRouter`
 * is the *only* subscriber to `client.onOutputFrame` and the only caller of
 * `client.acknowledge`, and it is constructed here so that no component can
 * reach past it:
 *
 * - **The auto-attach race.** `host-control-gateway.ts:414-448` attaches the
 *   new terminal at step 5 of its own sequence and sends `agent.ok` after, so
 *   output frames arrive before `launch()` resolves and before any terminal id
 *   is known. The router queues those in `earlyFrames` (64 per terminal) and
 *   drains them inside `create()` (`proxy-terminal-router.ts:151-154`). A
 *   second, parallel frame listener would see the same frames with no session
 *   to attribute them to and would drop them.
 * - **The acknowledgement cursor.** Every frame is acked with
 *   `max(lastAcknowledged, frameEnd)` (`:358-370`). An ack below the host
 *   `AttachmentPump`'s `acknowledgedCursor` throws `OUTPUT_CURSOR_INVALID` in a
 *   message with no `requestId`, so the error is not correlated back to a
 *   request — it escapes and tears down the whole peer session over a duplicate
 *   frame the router had already discarded correctly.
 *
 * `RemoteAgentChannelClient` satisfies `RemoteAgentPeerPort` structurally, so
 * the router talks to it directly and this class never sees a frame.
 */
export class ConsoleTerminalSession {
  readonly target: RemoteAgentExecutionTarget;
  readonly router: ProxyTerminalRouter;
  private readonly client: RemoteAgentChannelClient;

  constructor(options: ConsoleTerminalSessionOptions) {
    this.client = options.client;
    this.target = {
      kind: "remote",
      deviceId: options.host.deviceId,
      displayName: options.host.displayName,
    };
    this.router = new ProxyTerminalRouter(
      createBrowserLocalTerminalRouter(),
      () => this.client,
    );
  }

  workspaceRoots(): Promise<WorkspaceRoot[]> {
    return this.client.workspaceRoots();
  }

  workspaceList(path: string): Promise<WorkspaceDirectoryPage> {
    return this.client.workspaceList(path);
  }

  workspaceValidate(path: string): Promise<WorkspaceSelection> {
    return this.client.workspaceValidate(path);
  }

  runtimes(): Promise<AgentRuntime[]> {
    return this.client.runtimes();
  }

  /**
   * `agent.launch`, routed so the terminal it creates is registered with the
   * router before the early-frame queue is drained.
   */
  launch(cwd: string, agent: AgentLaunchRequest): Promise<TerminalDescriptor> {
    return this.router.create({
      target: this.target,
      cwd,
      agent,
      cols: LAUNCH_COLS,
      rows: LAUNCH_ROWS,
    });
  }

  /** Detaches every remote terminal, then closes the channel. */
  async close(): Promise<void> {
    try {
      await this.router.closeAll();
    } finally {
      this.client.close();
    }
  }
}

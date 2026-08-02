import { describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  type AgentExecutionTarget,
  type AgentLaunchTarget,
  type ApproveRemoteSessionRequest,
  type PendingRemoteSession,
  type RejectRemoteSessionRequest,
  type RemoteAccountStatus,
  type RemoteHostStatus,
} from "@codra/protocol";
import { registerRemoteIpc } from "./remote-ipc";
import type { DesktopAuthParentWindowLike } from "../remote/auth-window";

type Handler = (event: unknown, payload?: unknown) => unknown;

class FakeIpc {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

function sender() {
  const sends: Array<{ channel: string; payload: unknown }> = [];
  const webContents = {
    mainFrame: { url: "file:///trusted/index.html" },
    isDestroyed: () => false,
    getURL: () => "file:///trusted/index.html",
    send: (channel: string, payload: unknown) =>
      sends.push({ channel, payload }),
  };
  return {
    event: { sender: webContents, senderFrame: webContents.mainFrame },
    window: {
      webContents,
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    },
    sends,
  };
}

function controller() {
  let status: RemoteHostStatus = { state: "idle" };
  let accountStatus: RemoteAccountStatus = { state: "signed_out" };
  let listener: ((next: RemoteHostStatus) => void) | undefined;
  let accountListener: ((next: RemoteAccountStatus) => void) | undefined;
  let targetsListener: ((next: AgentLaunchTarget[]) => void) | undefined;
  let pendingListener: ((next: PendingRemoteSession[]) => void) | undefined;
  let pending: PendingRemoteSession[] = [
    {
      sessionId: "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d",
      clientDeviceId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      requesterDisplayName: "Laptop Mac",
      requestedScopes: ["workspace.read", "agent.launch"],
      expiresAt: 1_700_000_000_000,
    },
  ];
  const localTarget: AgentLaunchTarget = {
    target: { kind: "local" },
    state: "connected",
  };
  return {
    getStatus: () => status,
    getAccountStatus: () => accountStatus,
    login: vi.fn(async (provider: "google" | "email_password") => {
      expect(provider).toBe("google");
      accountStatus = {
        state: "signed_in",
        profile: {
          displayName: "Jun Hyeog Im",
          email: "jun@example.com",
          photoUrl: null,
        },
      };
      accountListener?.(accountStatus);
      return accountStatus;
    }),
    logout: vi.fn(async () => {
      accountStatus = { state: "signed_out" };
      accountListener?.(accountStatus);
      return accountStatus;
    }),
    activate: vi.fn(async (parentWindow: DesktopAuthParentWindowLike) => {
      void parentWindow;
      status = { state: "online" };
      listener?.(status);
      return status;
    }),
    deactivate: vi.fn(async () => {
      status = { state: "idle" };
      listener?.(status);
      return status;
    }),
    onStatusChanged: (next: (value: RemoteHostStatus) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    onAccountStatusChanged: (next: (value: RemoteAccountStatus) => void) => {
      accountListener = next;
      return () => {
        accountListener = undefined;
      };
    },
    listTargets: vi.fn(async () => [localTarget]),
    connectTarget: vi.fn(async () => localTarget),
    listRuntimesForTarget: vi.fn(async () => []),
    workspaceRoots: vi.fn(async () => [
      { path: "/Users/codra", label: "Home" },
    ]),
    workspaceList: vi.fn(
      async (...parameters: [AgentExecutionTarget, string]) => ({
        path: parameters[1],
        label: "codra",
        breadcrumbs: [{ path: "/Users/codra", label: "Home" }],
        entries: [],
      }),
    ),
    workspaceValidate: vi.fn(
      async (...parameters: [AgentExecutionTarget, string]) => ({
        path: parameters[1],
        label: "codra",
      }),
    ),
    onTargetsChanged: (next: (value: AgentLaunchTarget[]) => void) => {
      targetsListener = next;
      return () => {
        targetsListener = undefined;
      };
    },
    getPendingSessions: vi.fn(() => pending),
    approveSession: vi.fn(async (request: ApproveRemoteSessionRequest) => {
      pending = pending.filter(
        (session) => session.sessionId !== request.sessionId,
      );
      pendingListener?.(pending);
    }),
    rejectSession: vi.fn(async (request: RejectRemoteSessionRequest) => {
      pending = pending.filter(
        (session) => session.sessionId !== request.sessionId,
      );
      pendingListener?.(pending);
    }),
    onPendingSessionsChanged: (
      next: (value: PendingRemoteSession[]) => void,
    ) => {
      pendingListener = next;
      return () => {
        pendingListener = undefined;
      };
    },
    emit(next: RemoteHostStatus) {
      status = next;
      listener?.(next);
    },
    emitTargets(next: AgentLaunchTarget[]) {
      targetsListener?.(next);
    },
    emitPending(next: PendingRemoteSession[]) {
      pending = next;
      pendingListener?.(next);
    },
  };
}

describe("registerRemoteIpc", () => {
  it("routes account login and host activation independently", async () => {
    const ipc = new FakeIpc();
    const host = controller();
    const client = sender();
    const cleanup = registerRemoteIpc({
      ipc,
      controller: host,
      windows: () => [client.window],
      isTrustedRendererUrl: (url) => url.startsWith("file:///trusted/"),
    });

    expect(
      ipc.handlers.get(IPC_CHANNELS.remoteGetState)?.(client.event),
    ).toEqual({
      state: "idle",
    });
    expect(
      ipc.handlers.get(IPC_CHANNELS.remoteGetAuthState)?.(client.event),
    ).toEqual({ state: "signed_out" });
    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteLogin)?.(client.event, "google"),
    ).resolves.toEqual({
      state: "signed_in",
      profile: {
        displayName: "Jun Hyeog Im",
        email: "jun@example.com",
        photoUrl: null,
      },
    });
    expect(host.login).toHaveBeenCalledOnce();
    expect(host.login).toHaveBeenCalledWith("google", client.window);
    expect(client.sends).toEqual([
      {
        channel: IPC_CHANNELS.remoteAuthState,
        payload: {
          state: "signed_in",
          profile: {
            displayName: "Jun Hyeog Im",
            email: "jun@example.com",
            photoUrl: null,
          },
        },
      },
    ]);

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteLogout)?.(client.event),
    ).resolves.toEqual({ state: "signed_out" });
    expect(host.logout).toHaveBeenCalledOnce();

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteActivate)?.(client.event),
    ).resolves.toEqual({ state: "online" });
    expect(host.activate).toHaveBeenCalledOnce();
    expect(host.activate).toHaveBeenCalledWith(client.window);
    expect(client.sends.at(-1)).toEqual({
      channel: IPC_CHANNELS.remoteState,
      payload: { state: "online" },
    });

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteDeactivate)?.(client.event),
    ).resolves.toEqual({ state: "idle" });
    expect(host.deactivate).toHaveBeenCalledOnce();

    host.emit({ state: "error", message: "REMOTE_ACTIVATION_FAILED" });
    expect(client.sends.at(-1)).toEqual({
      channel: IPC_CHANNELS.remoteState,
      payload: { state: "error", message: "REMOTE_ACTIVATION_FAILED" },
    });

    cleanup();
    expect(ipc.handlers.size).toBe(0);
  });

  it("validates and routes target, runtime, and workspace requests", async () => {
    const ipc = new FakeIpc();
    const host = controller();
    const client = sender();
    registerRemoteIpc({
      ipc,
      controller: host,
      windows: () => [client.window],
      isTrustedRendererUrl: (url) => url.startsWith("file:///trusted/"),
    });
    const local = { kind: "local" as const };

    await expect(
      ipc.handlers.get(IPC_CHANNELS.agentTargets)?.(client.event),
    ).resolves.toEqual([{ target: local, state: "connected" }]);
    await expect(
      ipc.handlers.get(IPC_CHANNELS.agentTargetRuntimes)?.(client.event, {
        target: local,
      }),
    ).resolves.toEqual([]);
    await expect(
      ipc.handlers.get(IPC_CHANNELS.agentWorkspaceRoots)?.(client.event, {
        target: local,
      }),
    ).resolves.toEqual([{ path: "/Users/codra", label: "Home" }]);
    await expect(
      ipc.handlers.get(IPC_CHANNELS.agentWorkspaceList)?.(client.event, {
        target: local,
        path: "/Users/codra",
      }),
    ).resolves.toMatchObject({ path: "/Users/codra" });
    await expect(
      ipc.handlers.get(IPC_CHANNELS.agentWorkspaceValidate)?.(client.event, {
        target: local,
        path: "/Users/codra",
      }),
    ).resolves.toEqual({ path: "/Users/codra", label: "codra" });
    await expect(
      ipc.handlers.get(IPC_CHANNELS.agentWorkspaceList)?.(client.event, {
        target: local,
        path: "",
      }),
    ).rejects.toThrow();
    host.emitTargets([{ target: local, state: "connected" }]);
    expect(client.sends.at(-1)).toEqual({
      channel: IPC_CHANNELS.agentTargetsChanged,
      payload: [{ target: local, state: "connected" }],
    });
  });

  it("rejects an untrusted renderer before invoking the controller", async () => {
    const ipc = new FakeIpc();
    const host = controller();
    const client = sender();
    registerRemoteIpc({
      ipc,
      controller: host,
      windows: () => [client.window],
      isTrustedRendererUrl: () => false,
    });

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteLogin)?.(client.event, "google"),
    ).rejects.toThrow("Unauthorized terminal IPC sender");
    expect(host.login).not.toHaveBeenCalled();
  });

  it("pulls, pushes, and resolves pending remote sessions", async () => {
    const ipc = new FakeIpc();
    const host = controller();
    const client = sender();
    const cleanup = registerRemoteIpc({
      ipc,
      controller: host,
      windows: () => [client.window],
      isTrustedRendererUrl: (url) => url.startsWith("file:///trusted/"),
    });
    const sessionId = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";

    expect(
      ipc.handlers.get(IPC_CHANNELS.remoteGetPendingSessions)?.(client.event),
    ).toEqual([
      {
        sessionId,
        clientDeviceId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        requesterDisplayName: "Laptop Mac",
        requestedScopes: ["workspace.read", "agent.launch"],
        expiresAt: 1_700_000_000_000,
      },
    ]);

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteApproveSession)?.(client.event, {
        sessionId,
        approvedScopes: ["workspace.read"],
      }),
    ).resolves.toBeUndefined();
    expect(host.approveSession).toHaveBeenCalledWith({
      sessionId,
      approvedScopes: ["workspace.read"],
    });
    expect(client.sends.at(-1)).toEqual({
      channel: IPC_CHANNELS.remotePendingSessions,
      payload: [],
    });

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteApproveSession)?.(client.event, {
        sessionId,
        approvedScopes: [],
      }),
    ).rejects.toThrow();
    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteRejectSession)?.(client.event, {
        sessionId,
        reason: "USER_REJECTED",
      }),
    ).rejects.toThrow();

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteRejectSession)?.(client.event, {
        sessionId,
      }),
    ).resolves.toBeUndefined();
    expect(host.rejectSession).toHaveBeenCalledWith({ sessionId });

    cleanup();
    const before = client.sends.length;
    host.emitPending([]);
    expect(client.sends).toHaveLength(before);
  });

  it("rejects an untrusted renderer on every pending-session channel", async () => {
    const ipc = new FakeIpc();
    const host = controller();
    const client = sender();
    registerRemoteIpc({
      ipc,
      controller: host,
      windows: () => [client.window],
      isTrustedRendererUrl: () => false,
    });
    const sessionId = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";

    expect(() =>
      ipc.handlers.get(IPC_CHANNELS.remoteGetPendingSessions)?.(client.event),
    ).toThrow("Unauthorized terminal IPC sender");
    expect(host.getPendingSessions).not.toHaveBeenCalled();

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteApproveSession)?.(client.event, {
        sessionId,
        approvedScopes: ["workspace.read"],
      }),
    ).rejects.toThrow("Unauthorized terminal IPC sender");
    expect(host.approveSession).not.toHaveBeenCalled();

    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteRejectSession)?.(client.event, {
        sessionId,
      }),
    ).rejects.toThrow("Unauthorized terminal IPC sender");
    expect(host.rejectSession).not.toHaveBeenCalled();
  });

  it("withholds a pending-session push from a window whose frame navigated away", () => {
    const ipc = new FakeIpc();
    const host = controller();
    const client = sender();
    registerRemoteIpc({
      ipc,
      controller: host,
      windows: () => [client.window],
      isTrustedRendererUrl: (url) => url.startsWith("file:///trusted/"),
    });

    // webContents.getURL() still reports the trusted origin, but the live
    // main frame has since navigated elsewhere — only the mainFrame.url
    // check catches this.
    client.window.webContents.mainFrame.url = "https://attacker.example/";

    host.emitPending([]);

    expect(client.sends).toHaveLength(0);
  });
});

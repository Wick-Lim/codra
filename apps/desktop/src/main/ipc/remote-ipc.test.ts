import { describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  type RemoteAccountStatus,
  type RemoteHostStatus,
} from "@codra/protocol";
import { registerRemoteIpc } from "./remote-ipc";

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
    window: { webContents, isDestroyed: () => false },
    sends,
  };
}

function controller() {
  let status: RemoteHostStatus = { state: "idle" };
  let accountStatus: RemoteAccountStatus = { state: "signed_out" };
  let listener: ((next: RemoteHostStatus) => void) | undefined;
  let accountListener: ((next: RemoteAccountStatus) => void) | undefined;
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
    activate: vi.fn(async () => {
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
    emit(next: RemoteHostStatus) {
      status = next;
      listener?.(next);
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
});

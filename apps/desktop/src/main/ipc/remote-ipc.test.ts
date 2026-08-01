import { describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
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
    send: (channel: string, payload: unknown) => sends.push({ channel, payload }),
  };
  return {
    event: { sender: webContents, senderFrame: webContents.mainFrame },
    window: { webContents, isDestroyed: () => false },
    sends,
  };
}

function controller() {
  let status: RemoteHostStatus = { state: "idle" };
  let listener: ((next: RemoteHostStatus) => void) | undefined;
  return {
    getStatus: () => status,
    login: vi.fn(async () => {
      status = { state: "online" };
      listener?.(status);
      return status;
    }),
    onStatusChanged: (next: (value: RemoteHostStatus) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    emit(next: RemoteHostStatus) {
      status = next;
      listener?.(next);
    },
  };
}

describe("registerRemoteIpc", () => {
  it("returns state, starts login, and broadcasts validated state changes", async () => {
    const ipc = new FakeIpc();
    const host = controller();
    const client = sender();
    const cleanup = registerRemoteIpc({
      ipc,
      controller: host,
      windows: () => [client.window],
      isTrustedRendererUrl: (url) => url.startsWith("file:///trusted/"),
    });

    expect(ipc.handlers.get(IPC_CHANNELS.remoteGetState)?.(client.event)).toEqual({
      state: "idle",
    });
    await expect(
      ipc.handlers.get(IPC_CHANNELS.remoteLogin)?.(client.event),
    ).resolves.toEqual({ state: "online" });
    expect(host.login).toHaveBeenCalledOnce();
    expect(client.sends).toEqual([
      { channel: IPC_CHANNELS.remoteState, payload: { state: "online" } },
    ]);

    host.emit({ state: "error", message: "REMOTE_LOGIN_FAILED" });
    expect(client.sends.at(-1)).toEqual({
      channel: IPC_CHANNELS.remoteState,
      payload: { state: "error", message: "REMOTE_LOGIN_FAILED" },
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
      ipc.handlers.get(IPC_CHANNELS.remoteLogin)?.(client.event),
    ).rejects.toThrow("Unauthorized terminal IPC sender");
    expect(host.login).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputFrame, RemoteTerminalDescriptor } from "@codra/protocol";
import RemoteConsoleApp from "./RemoteConsoleApp";
import { t } from "../i18n/messages";

afterEach(cleanup);

const copy = t.console;
const terminalId = "3f43f5b1-3a3e-4a67-bb0e-4c9c3ea0d2b1";
const hostDeviceId = "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1";
const cwd = "/Users/codra/Projects";

/**
 * The console's own dependencies are faked; everything between them is real.
 *
 * `ConsoleTerminalSession`, `ProxyTerminalRouter`, and all three components run
 * unmocked, so this covers the one thing the per-component tests cannot: that
 * the flow the host permits is actually reachable end to end, and that output
 * the host sends before it answers `agent.launch` still reaches the screen.
 */
const fakes = vi.hoisted(() => {
  const frameListeners = new Set<(frame: OutputFrame) => void>();
  const launched: Array<{ cwd: string; agent: unknown }> = [];
  const acknowledged: string[] = [];

  const client = {
    workspaceRoots: async () => [{ path: "/Users/codra", label: "Home" }],
    workspaceList: async (path: string) =>
      path === cwd
        ? {
            path,
            label: "Projects",
            breadcrumbs: [
              { path: "/Users/codra", label: "Home" },
              { path, label: "Projects" },
            ],
            entries: [],
          }
        : {
            path,
            label: "Home",
            breadcrumbs: [{ path, label: "Home" }],
            entries: [{ path: cwd, name: "Projects" }],
          },
    workspaceValidate: async (path: string) => ({ path, label: "Projects" }),
    runtimes: async () => [
      {
        kind: "claude",
        label: "Claude Code",
        description: "Anthropic's coding agent.",
        available: true,
        supportsYolo: true,
        modelRequired: false,
        efforts: [],
        models: [],
        installHint: "Install the Claude CLI.",
        setup: { installMethod: "managed_npm", authentication: "required" },
      },
    ],
    launch: async (
      launchCwd: string,
      agent: unknown,
    ): Promise<RemoteTerminalDescriptor> => {
      launched.push({ cwd: launchCwd, agent });
      // The host attaches before it replies, so output for a terminal the
      // console cannot name yet arrives first.
      for (const listener of frameListeners) {
        listener({
          terminalId,
          cursor: 0n,
          data: new TextEncoder().encode("early output"),
        });
      }
      return {
        id: terminalId,
        title: "claude",
        cols: 120,
        rows: 40,
        state: "running",
        createdAt: 1_700_000_000_000,
      };
    },
    attach: async () => undefined,
    write: async () => undefined,
    resize: async () => undefined,
    detach: async () => undefined,
    acknowledge: (_id: string, cursor: bigint) => {
      acknowledged.push(cursor.toString());
    },
    onOutputFrame: (listener: (frame: OutputFrame) => void) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onTerminalChanged: () => () => undefined,
    onDisconnected: () => () => undefined,
    close: () => undefined,
  };

  return { client, launched, acknowledged, frameListeners };
});

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 120;
    rows = 40;
    readonly written: string[] = [];
    constructor() {
      FakeTerminal.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(value: string): void {
      this.written.push(value);
    }
    onData(): { dispose(): void } {
      return { dispose: () => undefined };
    }
    dispose(): void {}
  }
  class FakeFitAddon {
    fit(): void {}
    dispose(): void {}
  }
  return { FakeTerminal, FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xterm.FakeFitAddon }));

vi.mock("@codra/firebase", () => ({
  subscribeClientSessions: () => () => undefined,
}));

vi.mock("@codra/web-account-bootstrap", () => ({
  webAccountBootstrap: "google",
}));

vi.mock("../remote/controller", () => ({
  BrowserRemoteController: class {
    async connect() {
      return {
        runtime: { firestore: {} },
        identity: { deviceId: "browser", keyThumbprint: "thumb" },
        device: {
          deviceId: "browser",
          ownerUid: "owner",
          keyThumbprint: "thumb",
          generation: 1,
        },
        account: { uid: "owner", email: "operator@example.com" },
      };
    }
    async listHosts() {
      return [
        {
          deviceId: hostDeviceId,
          displayName: "Studio Mac",
          capabilities: ["webrtc"],
        },
      ];
    }
    async requestSession() {
      return { sessionId: "session" };
    }
    async signOut() {}
  },
}));

vi.mock("../remote/browser-peer-connector", () => ({
  BrowserPeerConnector: class {
    async connect(
      _host: unknown,
      _session: unknown,
      update: (state: string) => void,
    ) {
      update("waiting_for_approval");
      update("connecting");
      return fakes.client;
    }
    close(): void {}
  },
}));

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
  fakes.launched.length = 0;
  fakes.acknowledged.length = 0;
  fakes.frameListeners.clear();
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      this.callback();
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

describe("RemoteConsoleApp", () => {
  it("walks sign-in, workspace, runtime, and terminal in the host's order", async () => {
    render(<RemoteConsoleApp />);

    await userEvent.click(
      screen.getByRole("button", { name: copy.signIn.google }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: copy.hosts.request }),
    );

    // Step 4: nothing but the workspace picker is offered yet.
    await userEvent.click(await screen.findByRole("button", { name: "Home" }));
    expect(screen.queryByLabelText(copy.runtime.runtimeLabel)).toBeNull();
    await userEvent.click(
      await screen.findByRole("button", {
        name: copy.workspace.open("Projects"),
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: copy.workspace.use("Projects"),
      }),
    );

    // Step 5: the runtime picker, filled from `agent.runtimes`.
    await userEvent.type(
      await screen.findByLabelText(copy.runtime.promptLabel),
      "ship it",
    );
    await userEvent.click(
      screen.getByRole("button", { name: copy.runtime.launch }),
    );

    // Step 6 and 7: the launch used the validated path, and the frames the
    // host sent before answering are on screen.
    const pane = await screen.findByTestId("console-terminal");
    expect(pane.getAttribute("data-terminal-id")).toBe(terminalId);
    expect(fakes.launched).toEqual([
      { cwd, agent: { kind: "claude", yolo: false, prompt: "ship it" } },
    ]);
    await waitFor(() =>
      expect(xterm.FakeTerminal.instances.at(-1)?.written).toEqual([
        "early output",
      ]),
    );
    expect(fakes.acknowledged).toEqual(["12"]);
  });
});

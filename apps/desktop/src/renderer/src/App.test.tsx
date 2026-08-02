import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CodraDesktopApi, PendingRemoteSession } from "@codra/protocol";
import App from "./App";

void React;

const pendingSession: PendingRemoteSession = {
  sessionId: "3f0f8f1a-1f7e-4c4a-9a2f-1a2b3c4d5e6f",
  clientDeviceId: "40c77568-ae29-4af2-a57e-453ffc248a7b",
  requesterDisplayName: "Studio Mac",
  requestedScopes: ["workspace.read", "agent.launch"],
  expiresAt: 1_800_000_000_000,
};

function createDesktopApiFake() {
  let pendingListener: ((sessions: PendingRemoteSession[]) => void) | undefined;

  const api: CodraDesktopApi = {
    agents: {
      list: vi.fn().mockResolvedValue([]),
      targets: vi
        .fn()
        .mockResolvedValue([{ target: { kind: "local" }, state: "connected" }]),
      connectTarget: vi.fn(),
      listForTarget: vi.fn().mockResolvedValue([]),
      workspaceRoots: vi.fn().mockResolvedValue([]),
      workspaceList: vi.fn(),
      workspaceValidate: vi.fn(),
      onTargetsChanged: vi.fn(() => vi.fn()),
      setup: vi.fn(),
    },
    terminal: {
      defaultCwd: vi.fn().mockResolvedValue("/Users/codra"),
      chooseCwd: vi.fn().mockResolvedValue("/workspace/selected"),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      replay: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn(() => vi.fn()),
      onChanged: vi.fn(() => vi.fn()),
    },
    remote: {
      getState: vi.fn().mockResolvedValue({ state: "online" }),
      getAuthState: vi.fn().mockResolvedValue({ state: "signed_out" }),
      login: vi.fn(),
      logout: vi.fn(),
      activate: vi.fn(),
      deactivate: vi.fn(),
      onStateChanged: vi.fn(() => vi.fn()),
      onAuthStateChanged: vi.fn(() => vi.fn()),
      getPendingSessions: vi.fn().mockResolvedValue([]),
      approveSession: vi.fn().mockResolvedValue(undefined),
      rejectSession: vi.fn().mockResolvedValue(undefined),
      onPendingSessionsChanged: vi.fn((listener) => {
        pendingListener = listener;
        return vi.fn();
      }),
    },
  };

  return {
    api,
    emitPending(sessions: PendingRemoteSession[]) {
      pendingListener?.(sessions);
    },
  };
}

describe("App remote session approval", () => {
  it("pulls the pending set on mount and approves the granted scopes", async () => {
    const fake = createDesktopApiFake();
    vi.mocked(fake.api.remote.getPendingSessions).mockResolvedValue([
      pendingSession,
    ]);
    window.codra = fake.api;

    render(<App />);

    expect(fake.api.remote.getPendingSessions).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("dialog", {
        name: "Allow Studio Mac to connect?",
      }),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(fake.api.remote.approveSession).toHaveBeenCalledWith({
        sessionId: pendingSession.sessionId,
        approvedScopes: ["workspace.read"],
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Allow Studio Mac to connect?" }),
      ).toBeNull(),
    );
  });

  it("shows a session pushed after mount and denies it", async () => {
    const fake = createDesktopApiFake();
    window.codra = fake.api;

    render(<App />);

    expect(fake.api.remote.onPendingSessionsChanged).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("dialog", { name: "Allow Studio Mac to connect?" }),
    ).toBeNull();

    act(() => {
      fake.emitPending([pendingSession]);
    });

    expect(
      await screen.findByRole("dialog", {
        name: "Allow Studio Mac to connect?",
      }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(fake.api.remote.rejectSession).toHaveBeenCalledWith({
        sessionId: pendingSession.sessionId,
      }),
    );
    expect(fake.api.remote.approveSession).not.toHaveBeenCalled();
  });

  it("replaces the rendered set on a second push instead of appending", async () => {
    const fake = createDesktopApiFake();
    window.codra = fake.api;

    render(<App />);

    act(() => {
      fake.emitPending([pendingSession]);
    });

    expect(
      await screen.findByRole("dialog", {
        name: "Allow Studio Mac to connect?",
      }),
    ).toBeVisible();

    act(() => {
      fake.emitPending([]);
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Allow Studio Mac to connect?" }),
      ).toBeNull(),
    );
  });

  it("disables the buttons while a decision is in flight, blocking a second click", async () => {
    const fake = createDesktopApiFake();
    let resolveApprove: (() => void) | undefined;
    vi.mocked(fake.api.remote.approveSession).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveApprove = resolve;
      }),
    );
    vi.mocked(fake.api.remote.getPendingSessions).mockResolvedValue([
      pendingSession,
    ]);
    window.codra = fake.api;

    render(<App />);

    await screen.findByRole("dialog", {
      name: "Allow Studio Mac to connect?",
    });

    const approveButton = screen.getByRole("button", { name: "Approve" });
    await userEvent.click(approveButton);
    expect(approveButton).toBeDisabled();

    await userEvent.click(approveButton);
    resolveApprove?.();

    await waitFor(() =>
      expect(fake.api.remote.approveSession).toHaveBeenCalledTimes(1),
    );
  });
});

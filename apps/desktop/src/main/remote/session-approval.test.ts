import { describe, expect, it, vi } from "vitest";
import type { PendingRemoteSession, RemoteSession } from "@codra/protocol";
import {
  SessionApprovalRegistry,
  type SessionApprovalDependencies,
} from "./session-approval";

const SESSION_ID = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";
const CLIENT_DEVICE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function pendingSession(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    sessionId: SESSION_ID,
    ownerUid: "uid-1",
    clientDeviceId: CLIENT_DEVICE_ID,
    hostDeviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    clientKeyThumbprint: "client-thumbprint",
    hostKeyThumbprint: "host-thumbprint",
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 1,
    protocolVersion: 1,
    requestedScopes: ["workspace.read", "agent.launch"],
    clientChallenge: "challenge",
    requestSignature: "signature",
    createdAt: 1_000,
    expiresAt: 61_000,
    status: "requested",
    ...overrides,
  };
}

function harness(overrides: Partial<SessionApprovalDependencies> = {}) {
  const changes: PendingRemoteSession[][] = [];
  const dependencies = {
    approve: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    resolveRequesterName: vi.fn(async () => "Studio Mac"),
    ensureWindow: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000),
    reportError: vi.fn(),
    ...overrides,
  } satisfies SessionApprovalDependencies;
  const registry = new SessionApprovalRegistry(dependencies);
  registry.onChanged((sessions) => changes.push(sessions));
  return { changes, dependencies, registry };
}

describe("SessionApprovalRegistry", () => {
  it("announces the complete pending set once per session and resolves the requester name", async () => {
    const { changes, dependencies, registry } = harness();

    registry.handlePending(pendingSession());
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(changes.length).toBe(2));

    expect(dependencies.ensureWindow).toHaveBeenCalledOnce();
    expect(changes[0]).toEqual([
      {
        sessionId: SESSION_ID,
        clientDeviceId: CLIENT_DEVICE_ID,
        requestedScopes: ["workspace.read", "agent.launch"],
        expiresAt: 61_000,
      },
    ]);
    expect(changes[1]).toEqual([
      {
        sessionId: SESSION_ID,
        clientDeviceId: CLIENT_DEVICE_ID,
        requesterDisplayName: "Studio Mac",
        requestedScopes: ["workspace.read", "agent.launch"],
        expiresAt: 61_000,
      },
    ]);
    expect(registry.list()).toEqual(changes[1]);
  });

  it("rejects the session when no window can be shown", async () => {
    const failure = new Error("Renderer URL policy is not initialized");
    const { changes, dependencies, registry } = harness({
      ensureWindow: vi.fn(async () => {
        throw failure;
      }),
    });

    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(dependencies.reject).toHaveBeenCalledOnce());

    expect(dependencies.reportError).toHaveBeenCalledWith(failure);
    expect(registry.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
    expect(dependencies.resolveRequesterName).not.toHaveBeenCalled();
  });

  it("refuses scopes that were never requested without dropping the session", async () => {
    const { dependencies, registry } = harness();
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));

    await expect(
      registry.approve({
        sessionId: SESSION_ID,
        approvedScopes: ["workspace.read", "terminal.create"],
      }),
    ).rejects.toThrow("REMOTE_SCOPES_NOT_REQUESTED");
    expect(dependencies.approve).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
  });

  it("clears the pending entry when the approval callable fails", async () => {
    const { dependencies, registry } = harness({
      approve: vi.fn(async () => {
        throw new Error("REMOTE_HOST_NOT_STARTED");
      }),
    });
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));

    await expect(
      registry.approve({
        sessionId: SESSION_ID,
        approvedScopes: ["workspace.read"],
      }),
    ).rejects.toThrow("REMOTE_HOST_NOT_STARTED");
    expect(dependencies.approve).toHaveBeenCalledWith(expect.anything(), [
      "workspace.read",
    ]);
    expect(registry.list()).toEqual([]);
    await expect(
      registry.approve({
        sessionId: SESSION_ID,
        approvedScopes: ["workspace.read"],
      }),
    ).rejects.toThrow("REMOTE_SESSION_NOT_PENDING");
  });

  it("clears the pending entry when the reject callable fails", async () => {
    const { dependencies, registry } = harness({
      reject: vi.fn(async () => {
        throw new Error("REMOTE_HOST_NOT_STARTED");
      }),
    });
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));

    await expect(registry.reject({ sessionId: SESSION_ID })).rejects.toThrow(
      "REMOTE_HOST_NOT_STARTED",
    );
    expect(dependencies.reject).toHaveBeenCalledWith(expect.anything());
    expect(registry.list()).toEqual([]);
    await expect(registry.reject({ sessionId: SESSION_ID })).rejects.toThrow(
      "REMOTE_SESSION_NOT_PENDING",
    );
  });

  it("swallows a reject failure that follows an ensureWindow failure", async () => {
    const windowFailure = new Error("Renderer URL policy is not initialized");
    const rejectFailure = new Error("REMOTE_HOST_NOT_STARTED");
    const { changes, dependencies, registry } = harness({
      ensureWindow: vi.fn(async () => {
        throw windowFailure;
      }),
      reject: vi.fn(async () => {
        throw rejectFailure;
      }),
    });

    registry.handlePending(pendingSession());
    await vi.waitFor(() =>
      expect(dependencies.reportError).toHaveBeenCalledWith(rejectFailure),
    );

    expect(dependencies.reportError).toHaveBeenCalledWith(windowFailure);
    expect(registry.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });

  it("stops notifying an unsubscribed listener while others keep receiving", async () => {
    const { registry } = harness();
    const firstChanges: PendingRemoteSession[][] = [];
    const secondChanges: PendingRemoteSession[][] = [];
    const unsubscribeFirst = registry.onChanged((sessions) =>
      firstChanges.push(sessions),
    );
    registry.onChanged((sessions) => secondChanges.push(sessions));

    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(secondChanges.length).toBeGreaterThan(0));

    unsubscribeFirst();
    const firstCountAtUnsubscribe = firstChanges.length;
    registry.clear();

    expect(firstChanges).toHaveLength(firstCountAtUnsubscribe);
    expect(secondChanges.length).toBeGreaterThan(firstCountAtUnsubscribe);
    expect(secondChanges.at(-1)).toEqual([]);
  });

  it("treats an expired session as no longer pending and clears every entry on demand", async () => {
    const clock = { value: 1_000 };
    const { changes, dependencies, registry } = harness({
      now: vi.fn(() => clock.value),
    });
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));

    clock.value = 61_000;
    expect(registry.list()).toEqual([]);
    await expect(registry.reject({ sessionId: SESSION_ID })).rejects.toThrow(
      "REMOTE_SESSION_NOT_PENDING",
    );
    expect(dependencies.reject).not.toHaveBeenCalled();

    clock.value = 1_000;
    registry.handlePending(pendingSession({ sessionId: SESSION_ID }));
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });
});

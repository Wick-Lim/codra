import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteSession } from "@codra/protocol";
import { SessionApprovalRegistry } from "./session-approval";
import {
  installSessionAutoApprove,
  seamMarker,
} from "./session-auto-approve-test-only";

const SESSION_ID = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";
const CLIENT_DEVICE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const FULL_SCOPES = ["workspace.read", "agent.launch", "terminal.write"];

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
    requestedScopes: FULL_SCOPES,
    clientChallenge: "challenge",
    requestSignature: "signature",
    createdAt: 1_000,
    expiresAt: 61_000,
    status: "requested",
    ...overrides,
  };
}

function harness() {
  const approve = vi.fn(async () => undefined);
  const reject = vi.fn(async () => undefined);
  const registry = new SessionApprovalRegistry({
    approve,
    reject,
    resolveRequesterName: vi.fn(async () => undefined),
    ensureWindow: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000),
    reportError: vi.fn(),
  });
  return { approve, reject, registry };
}

describe("installSessionAutoApprove (test-only)", () => {
  it("exports the artifact-scanner marker matching its own alias", () => {
    // docs/security/remote-baseline.json's session-auto-approve-test-alias
    // rule denies this exact literal. Pinning it here catches a rename of
    // either side (this constant or the alias/rule id) drifting apart.
    expect(seamMarker).toBe("session-auto-approve-test-only");
  });

  const originalFlag = process.env.CODRA_REMOTE_TEST_AUTO_APPROVE;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.CODRA_REMOTE_TEST_AUTO_APPROVE;
    } else {
      process.env.CODRA_REMOTE_TEST_AUTO_APPROVE = originalFlag;
    }
  });

  it('approves a pending session with its full requested scopes when the flag is "1"', async () => {
    process.env.CODRA_REMOTE_TEST_AUTO_APPROVE = "1";
    const { approve, registry } = harness();
    const reportError = vi.fn();

    installSessionAutoApprove(registry, reportError);
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID }),
      FULL_SCOPES,
    );
    expect(reportError).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });

  it("does not approve anything when the flag is unset", async () => {
    delete process.env.CODRA_REMOTE_TEST_AUTO_APPROVE;
    const { approve, registry } = harness();

    installSessionAutoApprove(registry, vi.fn());
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(approve).not.toHaveBeenCalled();
  });

  it.each(["0", "true", "TRUE", "yes", " 1", "1 "])(
    "does not approve anything when the flag is %j",
    async (value) => {
      process.env.CODRA_REMOTE_TEST_AUTO_APPROVE = value;
      const { approve, registry } = harness();

      installSessionAutoApprove(registry, vi.fn());
      registry.handlePending(pendingSession());
      await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(approve).not.toHaveBeenCalled();
    },
  );

  it("stops approving further sessions once the returned disposer runs", async () => {
    process.env.CODRA_REMOTE_TEST_AUTO_APPROVE = "1";
    const { approve, registry } = harness();

    const dispose = installSessionAutoApprove(registry, vi.fn());
    dispose();
    registry.handlePending(pendingSession());
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(approve).not.toHaveBeenCalled();
  });
});

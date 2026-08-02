import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapRemoteAccount: vi.fn(),
  bootstrapRemoteAuth: vi.fn(),
  createRemoteFirebaseRuntime: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signOut: vi.fn(async () => undefined),
  hostname: vi.fn(() => "Studio-Mac.local"),
  httpsCallable: vi.fn(() => async () => ({ data: {} })),
  loadOrCreateHostIdentity: vi.fn(),
  registerDevice: vi.fn(),
  listHostDevices: vi.fn(
    async (): Promise<{ deviceId: string; displayName: string }[]> => [],
  ),
  subscribePendingSessions: vi.fn(
    (options: { onChange: (sessions: RemoteSession[]) => void }) => {
      void options;
      return (): void => undefined;
    },
  ),
  approveRemoteSession: vi.fn(),
  rejectRemoteSession: vi.fn(),
  installSessionAutoApprove: vi.fn(
    (registry: unknown, reportError: (error: unknown) => void) => {
      void registry;
      void reportError;
      return (): void => undefined;
    },
  ),
}));

vi.mock("node:os", () => ({ hostname: mocks.hostname }));

vi.mock("@codra/remote-account-bootstrap", () => ({
  bootstrapRemoteAccount: mocks.bootstrapRemoteAccount,
  bootstrapRemoteAuth: mocks.bootstrapRemoteAuth,
}));

vi.mock("@codra/remote-firebase-config", () => ({
  createRemoteFirebaseRuntime: mocks.createRemoteFirebaseRuntime,
}));

vi.mock("@codra/remote-session-auto-approve", () => ({
  installSessionAutoApprove: mocks.installSessionAutoApprove,
}));

vi.mock("firebase/auth", () => ({
  signInWithCustomToken: mocks.signInWithCustomToken,
  signOut: mocks.signOut,
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: mocks.httpsCallable,
}));

vi.mock("./host-identity", () => ({
  loadOrCreateHostIdentity: mocks.loadOrCreateHostIdentity,
}));

vi.mock("@codra/firebase", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerDevice: mocks.registerDevice,
  listHostDevices: mocks.listHostDevices,
  subscribePendingSessions: mocks.subscribePendingSessions,
  approveRemoteSession: mocks.approveRemoteSession,
  rejectRemoteSession: mocks.rejectRemoteSession,
}));

import { generateKeyPairSync } from "node:crypto";
import {
  createRfc7638Thumbprint,
  type PublicEcJwk,
  type RemoteSession,
} from "@codra/protocol";
import { RemoteHostController } from "./host-controller";

function parentWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe("RemoteHostController account lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps logout authoritative when an in-flight login finishes late", async () => {
    const auth = {
      currentUser: null as null | {
        displayName: string;
        email: string;
        photoURL: null;
      },
    };
    const runtime = { auth };
    let finishAuth: (() => void) | undefined;
    let loginSignal: AbortSignal | undefined;
    mocks.createRemoteFirebaseRuntime.mockReturnValue(runtime);
    mocks.bootstrapRemoteAuth.mockImplementation(
      async (_runtime, _provider, signal?: AbortSignal) => {
        loginSignal = signal;
        await new Promise<void>((resolve) => {
          finishAuth = resolve;
        });
        auth.currentUser = {
          displayName: "CODRA Operator",
          email: "operator@example.com",
          photoURL: null,
        };
      },
    );
    const controller = new RemoteHostController({
      userDataPath: "/tmp/codra-host-controller-test",
      reportError: vi.fn(),
    });

    const login = controller.login("google", parentWindow());
    await vi.waitFor(() => expect(finishAuth).toBeTypeOf("function"));
    await expect(controller.logout()).resolves.toEqual({
      state: "signed_out",
    });
    expect(loginSignal?.aborted).toBe(true);
    finishAuth?.();

    await expect(login).rejects.toThrow("REMOTE_LOGIN_CANCELLED");
    expect(controller.getAccountStatus()).toEqual({ state: "signed_out" });
  });

  it("carries the invoking CODRA window into the OAuth bootstrap", async () => {
    const auth = {
      currentUser: null as null | {
        displayName: string;
        email: string;
        photoURL: null;
      },
    };
    const runtime = { auth };
    const loginParent = parentWindow();
    mocks.createRemoteFirebaseRuntime.mockReturnValue(runtime);
    mocks.bootstrapRemoteAuth.mockImplementation(async () => {
      auth.currentUser = {
        displayName: "CODRA Operator",
        email: "operator@example.com",
        photoURL: null,
      };
    });
    const controller = new RemoteHostController({
      userDataPath: "/tmp/codra-host-controller-test",
      reportError: vi.fn(),
    });

    await controller.login("google", loginParent);

    expect(mocks.bootstrapRemoteAuth).toHaveBeenCalledWith(
      runtime,
      "google",
      expect.any(AbortSignal),
      loginParent,
    );
  });
});

const CLIENT_DEVICE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const HOST_DEVICE_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const SESSION_ID = "7f1d3b2a-0c4e-4a9b-9d1e-5c6f7a8b9c0d";

function keyMaterial() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyJwk = pair.publicKey.export({ format: "jwk" }) as PublicEcJwk;
  return {
    publicKeyJwk,
    privateKey: pair.privateKey.export({ format: "jwk" }),
    keyThumbprint: createRfc7638Thumbprint(publicKeyJwk),
  };
}

function pendingSession(): RemoteSession {
  return {
    sessionId: SESSION_ID,
    ownerUid: "uid-1",
    clientDeviceId: CLIENT_DEVICE_ID,
    hostDeviceId: HOST_DEVICE_ID,
    clientKeyThumbprint: "client-thumbprint",
    hostKeyThumbprint: "host-thumbprint",
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 1,
    protocolVersion: 1,
    requestedScopes: ["workspace.read", "agent.launch"],
    clientChallenge: "challenge",
    requestSignature: "signature",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    status: "requested",
  };
}

async function activatedController(
  ensureWindow = vi.fn(async () => undefined),
) {
  const material = keyMaterial();
  const accountAuth = {
    currentUser: null as null | {
      displayName: string;
      email: string;
      photoURL: null;
      uid: string;
    },
  };
  const accountRuntime = { auth: accountAuth, functions: {}, firestore: {} };
  const deviceRuntime = {
    auth: { currentUser: { uid: "uid-1" } },
    functions: {},
    firestore: {},
  };
  mocks.createRemoteFirebaseRuntime.mockImplementation((name?: string) =>
    name === "codra-host-device" ? deviceRuntime : accountRuntime,
  );
  mocks.bootstrapRemoteAuth.mockImplementation(async () => {
    accountAuth.currentUser = {
      displayName: "CODRA Operator",
      email: "operator@example.com",
      photoURL: null,
      uid: "uid-1",
    };
  });
  mocks.bootstrapRemoteAccount.mockResolvedValue(undefined);
  mocks.loadOrCreateHostIdentity.mockResolvedValue({
    deviceId: HOST_DEVICE_ID,
    publicKeyJwk: material.publicKeyJwk,
    privateKey: material.privateKey,
    keyThumbprint: material.keyThumbprint,
    created: true,
  });
  mocks.registerDevice.mockImplementation(
    async (_functions: unknown, request: { displayName: string }) => ({
      token: "device-token",
      device: {
        deviceId: HOST_DEVICE_ID,
        ownerUid: "uid-1",
        kind: "host",
        displayName: request.displayName,
        publicKeyJwk: material.publicKeyJwk,
        keyThumbprint: material.keyThumbprint,
        active: true,
        generation: 1,
        remoteAccessEnabled: true,
        capabilities: ["terminal", "webrtc", "turn-udp"],
        createdAt: 1_000,
        lastSeenAt: 2_000,
        expiresAt: 3_000,
      },
    }),
  );
  let onChange: ((sessions: RemoteSession[]) => void) | undefined;
  mocks.subscribePendingSessions.mockImplementation(
    (options: { onChange: (sessions: RemoteSession[]) => void }) => {
      onChange = options.onChange;
      return () => undefined;
    },
  );
  const controller = new RemoteHostController({
    userDataPath: "/tmp/codra-host-controller-test",
    reportError: vi.fn(),
    ensureWindow,
    createPeer: vi.fn(),
  });
  await controller.login("google", parentWindow());
  await controller.activate(parentWindow());
  return {
    controller,
    ensureWindow,
    deliverPending: (session: RemoteSession) => onChange?.([session]),
  };
}

describe("RemoteHostController session approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostname.mockReturnValue("Studio-Mac.local");
    mocks.listHostDevices.mockResolvedValue([]);
  });

  it("wires the session approval registry into the auto-approve seam", () => {
    const reportError = vi.fn();

    new RemoteHostController({
      userDataPath: "/tmp/codra-host-controller-test",
      reportError,
    });

    expect(mocks.installSessionAutoApprove).toHaveBeenCalledTimes(1);
    const [registryArg, reportErrorArg] =
      mocks.installSessionAutoApprove.mock.calls[0]!;
    expect(typeof (registryArg as { approve: unknown }).approve).toBe(
      "function",
    );
    expect(typeof (registryArg as { list: unknown }).list).toBe("function");

    const failure = new Error("boom");
    reportErrorArg(failure);
    expect(reportError).toHaveBeenCalledWith(failure);
  });

  it("registers the device under the resolved host name", async () => {
    await activatedController();

    expect(mocks.registerDevice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ displayName: "Studio-Mac" }),
    );
  });

  it("publishes pending sessions with the requester name from listHostDevices", async () => {
    mocks.listHostDevices.mockResolvedValue([
      { deviceId: CLIENT_DEVICE_ID, displayName: "Laptop Mac" },
    ]);
    const { controller, deliverPending, ensureWindow } =
      await activatedController();
    const changes: unknown[] = [];
    controller.onPendingSessionsChanged((sessions) => changes.push(sessions));

    deliverPending(pendingSession());
    await vi.waitFor(() => expect(changes.length).toBe(2));

    expect(ensureWindow).toHaveBeenCalledOnce();
    expect(controller.getPendingSessions()).toEqual([
      {
        sessionId: SESSION_ID,
        clientDeviceId: CLIENT_DEVICE_ID,
        requesterDisplayName: "Laptop Mac",
        requestedScopes: ["workspace.read", "agent.launch"],
        expiresAt: expect.any(Number),
      },
    ]);
  });

  it("leaves requesterDisplayName unset when the requester is absent from listHostDevices", async () => {
    mocks.listHostDevices.mockResolvedValue([
      { deviceId: HOST_DEVICE_ID, displayName: "Studio-Mac" },
    ]);
    const { controller, deliverPending } = await activatedController();

    deliverPending(pendingSession());
    await vi.waitFor(() =>
      expect(controller.getPendingSessions()).toHaveLength(1),
    );
    // handlePending inserts the entry synchronously, before the async
    // requester-name resolution it kicks off has run. That resolution can
    // only ever *add* a requesterDisplayName (session-approval.ts's
    // `present()` assigns it and never clears it), so waiting here for it
    // to settle and then re-asserting is what actually exercises the
    // absent-requester path, rather than reading a snapshot taken before
    // resolution had a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(controller.getPendingSessions()).toEqual([
      {
        sessionId: SESSION_ID,
        clientDeviceId: CLIENT_DEVICE_ID,
        requestedScopes: ["workspace.read", "agent.launch"],
        expiresAt: expect.any(Number),
      },
    ]);
  });

  it("refuses scopes outside the request and clears the registry on deactivate", async () => {
    const { controller, deliverPending } = await activatedController();
    deliverPending(pendingSession());
    await vi.waitFor(() =>
      expect(controller.getPendingSessions()).toHaveLength(1),
    );

    await expect(
      controller.approveSession({
        sessionId: SESSION_ID,
        approvedScopes: ["terminal.create"],
      }),
    ).rejects.toThrow("REMOTE_SCOPES_NOT_REQUESTED");
    expect(mocks.approveRemoteSession).not.toHaveBeenCalled();

    await controller.deactivate();
    expect(controller.getPendingSessions()).toEqual([]);
    await expect(
      controller.rejectSession({ sessionId: SESSION_ID }),
    ).rejects.toThrow("REMOTE_SESSION_NOT_PENDING");
  });

  it("refuses to approve a session that was pending before deactivate", async () => {
    const { controller, deliverPending } = await activatedController();
    deliverPending(pendingSession());
    await vi.waitFor(() =>
      expect(controller.getPendingSessions()).toHaveLength(1),
    );

    await controller.deactivate();

    await expect(
      controller.approveSession({
        sessionId: SESSION_ID,
        approvedScopes: ["workspace.read", "agent.launch"],
      }),
    ).rejects.toThrow("REMOTE_SESSION_NOT_PENDING");
    expect(mocks.approveRemoteSession).not.toHaveBeenCalled();
  });
});

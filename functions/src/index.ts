import { Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  DEVICE_PRESENCE_LEASE_MS,
  deriveSessionState,
  FUNCTION_REGION,
  PublicEcJwkSchema,
  RemoteDeviceSchema,
  RemoteSessionSchema,
  SignalSchema,
  buildSessionApprovalSigningPayload,
  buildSessionRejectionSigningPayload,
  buildSessionRequestSigningPayload,
  buildSignalSigningPayload,
  createRfc7638Thumbprint,
  type RemoteDevice,
  type RemoteSession,
  verifyCanonicalPayload,
} from "@codra/protocol";
import { adminAuth, adminDb } from "./runtime";
export { issueTurnCredentials } from "./turn";
export {
  authorizeDesktopLogin,
  desktopLoginCancel,
  desktopLoginRedeem,
  desktopLoginStart,
} from "./desktop-login";
import {
  DeviceRegistrationInputSchema,
  parseCallableInput,
  assertActiveDevice,
  assertCanInitiateRemoteSession,
  assertRemoteClientKind,
  requireAccount,
  requireDeviceClaims,
  resolveSessionPeerBinding,
} from "./auth";

const sessionInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    hostDeviceId: z.string().uuid(),
    hostKeyThumbprint: z.string().min(1),
    hostDeviceGeneration: z.number().int().positive().safe(),
    protocolVersion: z.literal(1),
    requestedScopes: z.array(z.string().min(1).max(80)).min(1).max(16),
    clientChallenge: z.string().min(1).max(4096),
    requestSignature: z.string().min(1),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();

const approvalInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    approvedScopes: z.array(z.string().min(1).max(80)).max(16),
    hostChallenge: z.string().min(1).max(4096),
    approvalSignature: z.string().min(1),
  })
  .strict();

const rejectionInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    rejectionReason: z.enum(["USER_REJECTED", "HOST_BUSY", "HOST_DISABLED"]),
    rejectionSignature: z.string().min(1),
  })
  .strict();

const signalInputSchema = z.object({ signal: SignalSchema }).strict();
const sessionPeerInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();

function toMillis(value: Timestamp | number): number {
  return value instanceof Timestamp ? value.toMillis() : value;
}

function deviceForClient(device: RemoteDevice): RemoteDevice {
  return RemoteDeviceSchema.parse({
    ...device,
    createdAt: toMillis(device.createdAt),
    lastSeenAt: toMillis(device.lastSeenAt),
    expiresAt: toMillis(device.expiresAt),
  });
}

export const registerDevice = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const account = requireAccount(request);
    const input = parseCallableInput(
      DeviceRegistrationInputSchema,
      request.data,
    );
    const publicKeyJwk = PublicEcJwkSchema.parse(input.publicKeyJwk);
    if (createRfc7638Thumbprint(publicKeyJwk) !== input.keyThumbprint)
      throw new HttpsError("invalid-argument", "KEY_THUMBPRINT_MISMATCH");
    const ref = adminDb.doc(`users/${account.uid}/devices/${input.deviceId}`);
    const now = Timestamp.now();
    const existing = await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists
        ? RemoteDeviceSchema.parse({
            ...snapshot.data(),
            createdAt: toMillis(snapshot.data()?.createdAt as Timestamp),
            lastSeenAt: toMillis(snapshot.data()?.lastSeenAt as Timestamp),
            expiresAt: toMillis(snapshot.data()?.expiresAt as Timestamp),
          })
        : undefined;
      if (current && current.ownerUid !== account.uid)
        throw new HttpsError("permission-denied", "DEVICE_OWNER_MISMATCH");
      if (current && current.keyThumbprint !== input.keyThumbprint)
        throw new HttpsError("already-exists", "DEVICE_KEY_MISMATCH");
      const generation = current
        ? input.action === "reenable"
          ? current.generation + 1
          : current.generation
        : 1;
      if (current && input.action === "register")
        throw new HttpsError("already-exists", "DEVICE_ALREADY_REGISTERED");
      if (current && input.action === "resume" && !current.active)
        throw new HttpsError("failed-precondition", "DEVICE_DISABLED");
      if (current && input.action === "reenable" && current.active)
        throw new HttpsError("failed-precondition", "DEVICE_ALREADY_ACTIVE");
      const stored = {
        deviceId: input.deviceId,
        ownerUid: account.uid,
        kind: input.kind,
        displayName: input.displayName,
        publicKeyJwk,
        keyThumbprint: input.keyThumbprint,
        active: true,
        generation,
        remoteAccessEnabled: input.remoteAccessEnabled,
        capabilities: input.capabilities,
        createdAt: current ? snapshot.data()?.createdAt : now,
        lastSeenAt: now,
        expiresAt: Timestamp.fromMillis(
          now.toMillis() + DEVICE_PRESENCE_LEASE_MS,
        ),
      };
      transaction.set(ref, stored);
      return stored;
    });
    const customToken = await adminAuth.createCustomToken(account.uid, {
      codraDeviceId: input.deviceId,
      codraKeyThumbprint: input.keyThumbprint,
      codraDeviceKind: input.kind,
      codraDeviceGeneration: existing.generation,
    });
    return {
      token: customToken,
      serverTimeMillis: now.toMillis(),
      device: deviceForClient(existing as unknown as RemoteDevice),
    };
  },
);

export const heartbeatDevice = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const claims = requireDeviceClaims(request);
    await assertActiveDevice(claims);
    const ref = adminDb.doc(`users/${claims.uid}/devices/${claims.deviceId}`);
    const now = Timestamp.now();
    await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists)
        throw new HttpsError("not-found", "DEVICE_NOT_FOUND");
      const device = snapshot.data();
      if (
        device?.active !== true ||
        device.keyThumbprint !== claims.keyThumbprint ||
        device.generation !== claims.generation
      )
        throw new HttpsError("permission-denied", "DEVICE_REVOKED");
      transaction.update(ref, {
        lastSeenAt: now,
        expiresAt: Timestamp.fromMillis(
          now.toMillis() + DEVICE_PRESENCE_LEASE_MS,
        ),
      });
    });
    return { serverTimeMillis: now.toMillis() };
  },
);

export const createRemoteSession = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const claims = requireDeviceClaims(request);
    await assertActiveDevice(claims);
    const input = parseCallableInput(sessionInputSchema, request.data);
    assertCanInitiateRemoteSession(claims, input.hostDeviceId);
    const hostRef = adminDb.doc(
      `users/${claims.uid}/devices/${input.hostDeviceId}`,
    );
    const host = await hostRef.get();
    const now = Timestamp.now();
    const hostData = host.data();
    if (
      !host.exists ||
      hostData?.ownerUid !== claims.uid ||
      hostData.kind !== "host" ||
      hostData.active !== true ||
      hostData.remoteAccessEnabled !== true ||
      hostData.keyThumbprint !== input.hostKeyThumbprint ||
      hostData.generation !== input.hostDeviceGeneration ||
      toMillis(hostData.expiresAt as Timestamp) <= now.toMillis()
    )
      throw new HttpsError("failed-precondition", "HOST_OFFLINE");
    const session = RemoteSessionSchema.parse({
      sessionId: input.sessionId,
      ownerUid: claims.uid,
      clientDeviceId: claims.deviceId,
      hostDeviceId: input.hostDeviceId,
      clientKeyThumbprint: claims.keyThumbprint,
      hostKeyThumbprint: input.hostKeyThumbprint,
      clientDeviceGeneration: claims.generation,
      hostDeviceGeneration: input.hostDeviceGeneration,
      protocolVersion: input.protocolVersion,
      requestedScopes: input.requestedScopes,
      clientChallenge: input.clientChallenge,
      requestSignature: input.requestSignature,
      createdAt: now.toMillis(),
      expiresAt: input.expiresAt,
      status: "requested",
    });
    const clientKey = PublicEcJwkSchema.parse(
      (
        await adminDb
          .doc(`users/${claims.uid}/devices/${claims.deviceId}`)
          .get()
      ).data()?.publicKeyJwk,
    );
    if (
      !(await verifyCanonicalPayload(
        clientKey,
        session.requestSignature,
        buildSessionRequestSigningPayload(session),
      ))
    )
      throw new HttpsError("permission-denied", "SESSION_SIGNATURE_INVALID");
    const ref = adminDb.doc(
      `users/${claims.uid}/remoteSessions/${session.sessionId}`,
    );
    await ref.create({
      ...session,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(session.expiresAt),
    });
    return session;
  },
);

export const approveRemoteSession = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const claims = requireDeviceClaims(request);
    await assertActiveDevice(claims);
    if (claims.kind !== "host")
      throw new HttpsError("permission-denied", "HOST_DEVICE_REQUIRED");
    const input = parseCallableInput(approvalInputSchema, request.data);
    const ref = adminDb.doc(
      `users/${claims.uid}/remoteSessions/${input.sessionId}`,
    );
    const hostSnapshot = await adminDb
      .doc(`users/${claims.uid}/devices/${claims.deviceId}`)
      .get();
    const hostKey = PublicEcJwkSchema.parse(hostSnapshot.data()?.publicKeyJwk);
    const now = Timestamp.now();
    let session: RemoteSession | undefined;
    await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists)
        throw new HttpsError("not-found", "SESSION_NOT_FOUND");
      const data = snapshot.data() ?? {};
      if (
        data.status !== "requested" ||
        data.hostDeviceId !== claims.deviceId ||
        data.hostKeyThumbprint !== claims.keyThumbprint ||
        data.hostDeviceGeneration !== claims.generation
      )
        throw new HttpsError("failed-precondition", "SESSION_NOT_ACTIONABLE");
      if (toMillis(data.expiresAt as Timestamp) <= now.toMillis())
        throw new HttpsError("failed-precondition", "SESSION_EXPIRED");
      session = RemoteSessionSchema.parse({
        ...data,
        createdAt: toMillis(data.createdAt as Timestamp),
        expiresAt: toMillis(data.expiresAt as Timestamp),
        status: "approved",
        approvedScopes: input.approvedScopes,
        hostChallenge: input.hostChallenge,
        approvalSignature: input.approvalSignature,
        decidedAt: now.toMillis(),
      });
      const approvalPayload = {
        domain: "codra.session-approval.v1" as const,
        protocolVersion: session.protocolVersion,
        sessionId: session.sessionId,
        clientDeviceId: session.clientDeviceId,
        hostDeviceId: session.hostDeviceId,
        clientKeyThumbprint: session.clientKeyThumbprint,
        hostKeyThumbprint: session.hostKeyThumbprint,
        clientDeviceGeneration: session.clientDeviceGeneration,
        hostDeviceGeneration: session.hostDeviceGeneration,
        requestedScopes: session.requestedScopes,
        approvedScopes: input.approvedScopes,
        clientChallenge: session.clientChallenge,
        hostChallenge: input.hostChallenge,
        expiresAtMillis: session.expiresAt,
        signature: input.approvalSignature,
      };
      if (
        !(await verifyCanonicalPayload(
          hostKey,
          input.approvalSignature,
          buildSessionApprovalSigningPayload(approvalPayload),
        ))
      )
        throw new HttpsError("permission-denied", "APPROVAL_SIGNATURE_INVALID");
      transaction.update(ref, {
        status: "approved",
        approvedScopes: input.approvedScopes,
        hostChallenge: input.hostChallenge,
        approvalSignature: input.approvalSignature,
        decidedAt: now,
        updatedAt: now,
      });
    });
    return session;
  },
);

export const listHostDevices = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const claims = requireDeviceClaims(request);
    await assertActiveDevice(claims);
    assertRemoteClientKind(claims.kind);
    const now = Timestamp.now().toMillis();
    const snapshot = await adminDb
      .collection(`users/${claims.uid}/devices`)
      .where("kind", "==", "host")
      .where("active", "==", true)
      .where("remoteAccessEnabled", "==", true)
      .limit(32)
      .get();
    return {
      devices: snapshot.docs
        .map((item) => item.data())
        .filter((item) => item.deviceId !== claims.deviceId)
        .filter((item) => toMillis(item.expiresAt as Timestamp) > now)
        .map((item) =>
          deviceForClient(
            RemoteDeviceSchema.parse({
              ...item,
              createdAt: toMillis(item.createdAt as Timestamp),
              lastSeenAt: toMillis(item.lastSeenAt as Timestamp),
              expiresAt: toMillis(item.expiresAt as Timestamp),
            }),
          ),
        ),
    };
  },
);

export const rejectRemoteSession = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const claims = requireDeviceClaims(request);
    await assertActiveDevice(claims);
    if (claims.kind !== "host")
      throw new HttpsError("permission-denied", "HOST_DEVICE_REQUIRED");
    const input = parseCallableInput(rejectionInputSchema, request.data);
    const ref = adminDb.doc(
      `users/${claims.uid}/remoteSessions/${input.sessionId}`,
    );
    const hostSnapshot = await adminDb
      .doc(`users/${claims.uid}/devices/${claims.deviceId}`)
      .get();
    const hostKey = PublicEcJwkSchema.parse(hostSnapshot.data()?.publicKeyJwk);
    const now = Timestamp.now();
    let session: RemoteSession | undefined;
    await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists)
        throw new HttpsError("not-found", "SESSION_NOT_FOUND");
      const data = snapshot.data() ?? {};
      if (
        data.status !== "requested" ||
        data.hostDeviceId !== claims.deviceId ||
        data.hostKeyThumbprint !== claims.keyThumbprint ||
        data.hostDeviceGeneration !== claims.generation
      )
        throw new HttpsError("failed-precondition", "SESSION_NOT_ACTIONABLE");
      if (toMillis(data.expiresAt as Timestamp) <= now.toMillis())
        throw new HttpsError("failed-precondition", "SESSION_EXPIRED");
      const candidate = RemoteSessionSchema.parse({
        ...data,
        createdAt: toMillis(data.createdAt as Timestamp),
        expiresAt: toMillis(data.expiresAt as Timestamp),
        status: "rejected",
        approvedScopes: [],
        rejectionReason: input.rejectionReason,
        rejectionSignature: input.rejectionSignature,
        decidedAt: now.toMillis(),
      });
      const rejectionPayload = {
        domain: "codra.session-rejection.v1" as const,
        protocolVersion: candidate.protocolVersion,
        sessionId: candidate.sessionId,
        ownerUid: candidate.ownerUid,
        clientDeviceId: candidate.clientDeviceId,
        hostDeviceId: candidate.hostDeviceId,
        clientKeyThumbprint: candidate.clientKeyThumbprint,
        hostKeyThumbprint: candidate.hostKeyThumbprint,
        clientDeviceGeneration: candidate.clientDeviceGeneration,
        hostDeviceGeneration: candidate.hostDeviceGeneration,
        requestedScopes: candidate.requestedScopes,
        clientChallenge: candidate.clientChallenge,
        rejectionReason: input.rejectionReason,
        expiresAtMillis: candidate.expiresAt,
        signature: input.rejectionSignature,
      };
      if (
        !(await verifyCanonicalPayload(
          hostKey,
          input.rejectionSignature,
          buildSessionRejectionSigningPayload(rejectionPayload),
        ))
      )
        throw new HttpsError(
          "permission-denied",
          "REJECTION_SIGNATURE_INVALID",
        );
      session = candidate;
      transaction.update(ref, {
        status: "rejected",
        approvedScopes: [],
        rejectionReason: input.rejectionReason,
        rejectionSignature: input.rejectionSignature,
        decidedAt: now,
        updatedAt: now,
      });
    });
    return session;
  },
);

export const publishSignal = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const claims = requireDeviceClaims(request);
    await assertActiveDevice(claims);
    const input = parseCallableInput(signalInputSchema, request.data);
    if (
      input.signal.senderDeviceId !== claims.deviceId ||
      input.signal.signerThumbprint !== claims.keyThumbprint ||
      input.signal.signerDeviceGeneration !== claims.generation
    )
      throw new HttpsError("permission-denied", "SIGNAL_SENDER_MISMATCH");
    const sessionRef = adminDb.doc(
      `users/${claims.uid}/remoteSessions/${input.signal.sessionId}`,
    );
    const session = await sessionRef.get();
    if (!session.exists) throw new HttpsError("not-found", "SESSION_NOT_FOUND");
    const data = session.data() ?? {};
    if (
      data.clientDeviceId !== claims.deviceId &&
      data.hostDeviceId !== claims.deviceId
    )
      throw new HttpsError("permission-denied", "SESSION_PARTICIPANT_REQUIRED");
    const now = Timestamp.now();
    const isClient = data.clientDeviceId === claims.deviceId;
    if (
      (isClient && input.signal.recipientDeviceId !== data.hostDeviceId) ||
      (!isClient && input.signal.recipientDeviceId !== data.clientDeviceId) ||
      !["approved", "signaling", "connected"].includes(String(data.status)) ||
      toMillis(data.expiresAt as Timestamp) <= now.toMillis()
    )
      throw new HttpsError("failed-precondition", "SESSION_NOT_SIGNALABLE");
    const sender = await adminDb
      .doc(`users/${claims.uid}/devices/${claims.deviceId}`)
      .get();
    const senderKey = PublicEcJwkSchema.parse(sender.data()?.publicKeyJwk);
    const signal = SignalSchema.parse({
      ...input.signal,
      createdAt: now.toMillis(),
      expiresAt: Math.min(
        input.signal.expiresAt,
        now.toMillis() + 60 * 60 * 1000,
      ),
    });
    if (
      !(await verifyCanonicalPayload(
        senderKey,
        signal.signature,
        buildSignalSigningPayload(signal),
      ))
    )
      throw new HttpsError("permission-denied", "SIGNAL_SIGNATURE_INVALID");
    const ref = adminDb.doc(
      `users/${claims.uid}/remoteSessions/${signal.sessionId}/signals/${signal.negotiationId}-${signal.senderDeviceId}-${signal.sequence}`,
    );
    await ref.create({
      ...signal,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(signal.expiresAt),
    });
    return signal;
  },
);

export const getSessionPeerDevice = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const claims = requireDeviceClaims(request);
    await assertActiveDevice(claims);
    const input = parseCallableInput(sessionPeerInputSchema, request.data);
    const sessionSnapshot = await adminDb
      .doc(`users/${claims.uid}/remoteSessions/${input.sessionId}`)
      .get();
    if (!sessionSnapshot.exists) {
      throw new HttpsError("not-found", "SESSION_NOT_FOUND");
    }
    const raw = sessionSnapshot.data() ?? {};
    const remoteSession = RemoteSessionSchema.parse({
      ...raw,
      createdAt: toMillis(raw.createdAt as Timestamp),
      expiresAt: toMillis(raw.expiresAt as Timestamp),
      ...(raw.decidedAt === undefined
        ? {}
        : { decidedAt: toMillis(raw.decidedAt as Timestamp) }),
      ...(raw.connectedAt === undefined
        ? {}
        : { connectedAt: toMillis(raw.connectedAt as Timestamp) }),
      ...(raw.disconnectedAt === undefined
        ? {}
        : { disconnectedAt: toMillis(raw.disconnectedAt as Timestamp) }),
      ...(raw.closedAt === undefined
        ? {}
        : { closedAt: toMillis(raw.closedAt as Timestamp) }),
      ...(raw.updatedAt === undefined
        ? {}
        : { updatedAt: toMillis(raw.updatedAt as Timestamp) }),
    });
    const now = Timestamp.now().toMillis();
    if (
      deriveSessionState(remoteSession, now) === "expired" ||
      !["approved", "signaling", "connected"].includes(remoteSession.status)
    ) {
      throw new HttpsError("failed-precondition", "SESSION_NOT_CONNECTABLE");
    }
    const peerBinding = resolveSessionPeerBinding(claims, remoteSession);
    const peerSnapshot = await adminDb
      .doc(`users/${claims.uid}/devices/${peerBinding.deviceId}`)
      .get();
    if (!peerSnapshot.exists) {
      throw new HttpsError("not-found", "PEER_DEVICE_NOT_FOUND");
    }
    const peer = RemoteDeviceSchema.parse({
      ...peerSnapshot.data(),
      createdAt: toMillis(peerSnapshot.data()?.createdAt as Timestamp),
      lastSeenAt: toMillis(peerSnapshot.data()?.lastSeenAt as Timestamp),
      expiresAt: toMillis(peerSnapshot.data()?.expiresAt as Timestamp),
    });
    if (
      peer.ownerUid !== claims.uid ||
      peer.keyThumbprint !== peerBinding.keyThumbprint ||
      peer.generation !== peerBinding.generation ||
      peer.active !== true
    ) {
      throw new HttpsError("permission-denied", "PEER_DEVICE_REVOKED");
    }
    return deviceForClient(peer);
  },
);

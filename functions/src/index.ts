import { Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  DEVICE_PRESENCE_LEASE_MS,
  FUNCTION_REGION,
  PublicEcJwkSchema,
  RemoteDeviceSchema,
  RemoteSessionSchema,
  SignalSchema,
  createRfc7638Thumbprint,
  type RemoteDevice,
  type RemoteSession,
} from "@codra/protocol";
import { adminAuth, adminDb } from "./runtime";
import {
  DeviceRegistrationInputSchema,
  parseCallableInput,
  requireAccount,
  requireDeviceClaims,
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

const signalInputSchema = z.object({ signal: SignalSchema }).strict();

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
    if (claims.kind !== "browser")
      throw new HttpsError("permission-denied", "BROWSER_DEVICE_REQUIRED");
    const input = parseCallableInput(sessionInputSchema, request.data);
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
    if (claims.kind !== "host")
      throw new HttpsError("permission-denied", "HOST_DEVICE_REQUIRED");
    const input = parseCallableInput(approvalInputSchema, request.data);
    const ref = adminDb.doc(
      `users/${claims.uid}/remoteSessions/${input.sessionId}`,
    );
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

export const publishSignal = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const claims = requireDeviceClaims(request);
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
    const signal = SignalSchema.parse({
      ...input.signal,
      createdAt: now.toMillis(),
      expiresAt: Math.min(
        input.signal.expiresAt,
        now.toMillis() + 60 * 60 * 1000,
      ),
    });
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

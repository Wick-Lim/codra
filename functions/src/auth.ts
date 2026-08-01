import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { adminDb } from "./runtime";

export const DeviceRegistrationInputSchema = z
  .object({
    action: z.enum(["register", "resume", "reenable"]),
    deviceId: z.string().uuid(),
    kind: z.enum(["host", "browser"]),
    displayName: z.string().min(1).max(200),
    publicKeyJwk: z.record(z.string(), z.unknown()),
    keyThumbprint: z.string().min(1),
    capabilities: z.array(z.string().min(1).max(80)).max(32),
    remoteAccessEnabled: z.boolean(),
  })
  .strict();

export type DeviceRegistrationInput = z.infer<
  typeof DeviceRegistrationInputSchema
>;

export function requireAccount(request: CallableRequest<unknown>): {
  uid: string;
  provider: string;
} {
  if (!request.auth?.uid)
    throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  const provider = String(request.auth.token.firebase?.sign_in_provider ?? "");
  if (
    provider !== "google.com" &&
    !(process.env.FUNCTIONS_EMULATOR === "true" && provider === "password")
  ) {
    throw new HttpsError("permission-denied", "ACCOUNT_PROVIDER_NOT_ALLOWED");
  }
  return { uid: request.auth.uid, provider };
}

export function parseCallableInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new HttpsError("invalid-argument", "INVALID_REQUEST");
  return parsed.data;
}

export interface DeviceClaims {
  uid: string;
  deviceId: string;
  keyThumbprint: string;
  kind: "host" | "browser";
  generation: number;
}

export function requireDeviceClaims(
  request: CallableRequest<unknown>,
): DeviceClaims {
  if (!request.auth?.uid)
    throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  const token = request.auth.token;
  if (token.firebase?.sign_in_provider !== "custom")
    throw new HttpsError("permission-denied", "CUSTOM_DEVICE_TOKEN_REQUIRED");
  const deviceId = token.codraDeviceId;
  const keyThumbprint = token.codraKeyThumbprint;
  const kind = token.codraDeviceKind;
  const generation = token.codraDeviceGeneration;
  if (
    typeof deviceId !== "string" ||
    typeof keyThumbprint !== "string" ||
    (kind !== "host" && kind !== "browser") ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new HttpsError("permission-denied", "DEVICE_CLAIMS_REQUIRED");
  }
  return {
    uid: request.auth.uid,
    deviceId,
    keyThumbprint,
    kind,
    generation,
  };
}

export async function assertActiveDevice(claims: DeviceClaims): Promise<void> {
  const snapshot = await adminDb
    .doc(`users/${claims.uid}/devices/${claims.deviceId}`)
    .get();
  const data = snapshot.data();
  if (
    !snapshot.exists ||
    data?.ownerUid !== claims.uid ||
    data.deviceId !== claims.deviceId ||
    data.keyThumbprint !== claims.keyThumbprint ||
    data.kind !== claims.kind ||
    data.generation !== claims.generation ||
    data.active !== true
  ) {
    throw new HttpsError("permission-denied", "DEVICE_REVOKED");
  }
}

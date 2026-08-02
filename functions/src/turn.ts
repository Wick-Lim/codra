import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  FUNCTION_REGION,
  TurnCredentialResponseSchema,
  TurnIceServerSchema,
  TurnIssuanceSchema,
  sha256Base64Url,
} from "@codra/protocol";
import { adminDb } from "./runtime";
import {
  assertActiveDevice,
  parseCallableInput,
  requireDeviceClaims,
} from "./auth";

const CLOUDFLARE_TURN_CONFIG = defineSecret("CLOUDFLARE_TURN_CONFIG");
const TURN_TTL_SECONDS = 86_400;
const TURN_REQUEST_TIMEOUT_MS = 5_000;

const inputSchema = z.object({ sessionId: z.string().uuid() }).strict();
const configSchema = z
  .object({
    keyId: z.string().min(1).max(128),
    bearerToken: z.string().min(1).max(4096),
  })
  .strict();
const cloudflareResponseSchema = z
  .object({
    iceServers: z.array(TurnIceServerSchema).min(1).max(8),
  })
  .strict();

export type CloudflareTurnConfig = z.infer<typeof configSchema>;
export type CloudflareTurnIceServer = z.infer<typeof TurnIceServerSchema>;
// Cloudflare's generate-ice-servers response mixes a credential-less STUN
// entry in with the TURN relay entry (see requestCloudflareTurnCredentials
// below). Once that STUN entry is filtered out, every remaining entry is
// guaranteed to carry both fields — this type says so at the boundary that
// owns the filtering, rather than leaving it implicit.
export type CloudflareRelayIceServer = CloudflareTurnIceServer & {
  username: string;
  credential: string;
};

function millis(value: Timestamp | number): number {
  return value instanceof Timestamp ? value.toMillis() : value;
}

function ambiguousTurnError(): HttpsError {
  return new HttpsError("unavailable", "TURN_GENERATION_AMBIGUOUS");
}

export async function requestCloudflareTurnCredentials(
  config: CloudflareTurnConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudflareRelayIceServer[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: controller.signal,
      },
    );
  } catch {
    throw new Error("TURN_GENERATION_AMBIGUOUS");
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 201) throw new Error("TURN_GENERATION_AMBIGUOUS");
  try {
    const parsed = cloudflareResponseSchema.parse(await response.json());
    // The STUN-only entry has no username/credential and uses `stun:` URLs;
    // CODRA's only ICE consumer is the desktop native peer, which forces
    // relay-only UDP TURN (normalizeHostIceServers in
    // packages/webrtc/src/ice.ts) and never gathers STUN/host candidates, so
    // that entry is both useless to the client and rejected outright by
    // ice.ts's normalizeInput (which requires username/credential on every
    // entry it is given). Filter it out here, at the boundary that owns the
    // raw Cloudflare shape, instead of teaching the client to tolerate a
    // server type it will never use.
    const relayServers = parsed.iceServers.filter(
      (entry): entry is CloudflareRelayIceServer =>
        Boolean(entry.username) && Boolean(entry.credential),
    );
    if (relayServers.length === 0) throw new Error("TURN_GENERATION_AMBIGUOUS");
    return relayServers;
  } catch {
    throw new Error("TURN_GENERATION_AMBIGUOUS");
  }
}

export const issueTurnCredentials = onCall(
  {
    region: FUNCTION_REGION,
    secrets: [CLOUDFLARE_TURN_CONFIG],
  },
  async (request) => {
    const claims = requireDeviceClaims(request);
    await assertActiveDevice(claims);
    const input = parseCallableInput(inputSchema, request.data);
    const sessionSnapshot = await adminDb
      .doc(`users/${claims.uid}/remoteSessions/${input.sessionId}`)
      .get();
    if (!sessionSnapshot.exists)
      throw new HttpsError("not-found", "SESSION_NOT_FOUND");
    const session = sessionSnapshot.data() ?? {};
    const now = Timestamp.now();
    if (
      (session.clientDeviceId !== claims.deviceId &&
        session.hostDeviceId !== claims.deviceId) ||
      !["approved", "signaling", "connected"].includes(
        String(session.status),
      ) ||
      millis(session.expiresAt as Timestamp | number) <= now.toMillis()
    )
      throw new HttpsError("failed-precondition", "SESSION_NOT_TURNABLE");

    let config: z.infer<typeof configSchema>;
    try {
      config = configSchema.parse(JSON.parse(CLOUDFLARE_TURN_CONFIG.value()));
    } catch {
      throw new HttpsError("failed-precondition", "TURN_CONFIG_UNAVAILABLE");
    }

    let iceServers: CloudflareRelayIceServer[];
    try {
      iceServers = await requestCloudflareTurnCredentials(config);
    } catch {
      throw ambiguousTurnError();
    }
    const issuedAtMillis = now.toMillis();
    const expiresAtMillis = Math.min(
      issuedAtMillis + TURN_TTL_SECONDS * 1000,
      millis(session.expiresAt as Timestamp | number),
    );
    const issuanceId = randomUUID();
    const credentialHash = sha256Base64Url(JSON.stringify(iceServers));
    const issuance = TurnIssuanceSchema.parse({
      issuanceId,
      sessionId: input.sessionId,
      ownerUid: claims.uid,
      hostDeviceId: session.hostDeviceId,
      credentialExpiresAt: expiresAtMillis,
      createdAt: issuedAtMillis,
      updatedAt: issuedAtMillis,
      status: "active",
      cloudflareCredentialHash: credentialHash,
    });
    await adminDb.doc(`serverTurnIssuances/${issuanceId}`).create({
      ...issuance,
      createdAt: now,
      updatedAt: now,
    });
    return TurnCredentialResponseSchema.parse({
      issuanceId,
      iceServers,
      issuedAtMillis,
      expiresAtMillis,
    });
  },
);

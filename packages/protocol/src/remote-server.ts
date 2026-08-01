import { z } from "zod";
import {
  deriveSessionState,
  RemoteSessionSchema,
  type RemoteSession,
} from "./remote";
import { PkceChallengeSchema, ThumbprintSchema } from "./remote-signing";

const safeInteger = z.number().int().nonnegative().safe();
const positiveInteger = z.number().int().positive().safe();
const id = z.string().uuid();
const text = z.string().min(1).max(4096);
const serverSecretUsername = z.string().min(1).max(512);

export const TurnIceServerSchema = z
  .object({
    urls: z.union([z.string().url(), z.array(z.string().url()).min(1).max(8)]),
    username: z.string().min(1).max(512).optional(),
    credential: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const TurnCredentialResponseSchema = z
  .object({
    issuanceId: id,
    iceServers: z.array(TurnIceServerSchema).min(1).max(8),
    issuedAtMillis: safeInteger,
    expiresAtMillis: safeInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAtMillis <= value.issuedAtMillis)
      context.addIssue({
        code: "custom",
        path: ["expiresAtMillis"],
        message: "TURN credentials must expire after issue",
      });
  });
export type TurnCredentialResponse = z.infer<
  typeof TurnCredentialResponseSchema
>;

export const TurnIssuanceSchema = z
  .object({
    issuanceId: id,
    sessionId: id,
    ownerUid: text,
    hostDeviceId: id,
    credentialExpiresAt: safeInteger,
    createdAt: safeInteger,
    updatedAt: safeInteger,
    status: z.enum([
      "active",
      "revocation_pending",
      "revoked",
      "naturally_expired",
    ]),
    cloudflareCredentialHash: ThumbprintSchema,
    ttlDeleteAt: safeInteger.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.credentialExpiresAt < value.createdAt)
      context.addIssue({
        code: "custom",
        path: ["credentialExpiresAt"],
        message: "Credential expiry precedes issuance",
      });
    if (value.status === "active" && value.ttlDeleteAt !== undefined)
      context.addIssue({
        code: "custom",
        path: ["ttlDeleteAt"],
        message: "Active issuance cannot have TTL",
      });
  });

export const TurnRateLimitSchema = z
  .object({
    scopeHash: ThumbprintSchema,
    windowStartAt: safeInteger,
    attemptCount: z.number().int().nonnegative().max(100_000),
    reservationCount: z.number().int().nonnegative().max(100_000),
    updatedAt: safeInteger,
  })
  .strict();
export const BootstrapRateLimitSchema = z
  .object({
    scopeHash: ThumbprintSchema,
    windowStartAt: safeInteger,
    attemptCount: z.number().int().nonnegative().max(100_000),
    updatedAt: safeInteger,
  })
  .strict();

const revocationBase = {
  issuanceId: id,
  encodedUsername: serverSecretUsername,
  reason: z.enum([
    "SESSION_CLOSED",
    "SESSION_EXPIRED",
    "NATURALLY_EXPIRED",
    "MANUAL",
  ]),
  attemptCount: z.number().int().nonnegative().max(1000),
  nextAttemptAt: safeInteger,
  leaseOwnerHash: ThumbprintSchema.optional(),
  leaseExpiresAt: safeInteger.optional(),
  createdAt: safeInteger,
  updatedAt: safeInteger,
  completedAt: safeInteger.optional(),
  terminalAt: safeInteger.optional(),
  naturallyExpiredAt: safeInteger.optional(),
  credentialExpiresAt: safeInteger,
  ttlDeleteAt: safeInteger.optional(),
  lastErrorCode: z.string().min(1).max(64).optional(),
};
export const TurnRevocationJobSchema = z
  .object({
    ...revocationBase,
    state: z.enum([
      "pending",
      "leased",
      "retry_wait",
      "completed",
      "terminal_failure",
      "naturally_expired",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const hasLease =
      value.leaseOwnerHash !== undefined || value.leaseExpiresAt !== undefined;
    if (
      value.state === "leased" &&
      (!value.leaseOwnerHash || value.leaseExpiresAt === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Leased job requires a lease",
      });
    if (value.state !== "leased" && hasLease)
      context.addIssue({
        code: "custom",
        message: "Only leased jobs have lease fields",
      });
    if (
      ["pending", "leased", "retry_wait"].includes(value.state) &&
      value.ttlDeleteAt !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["ttlDeleteAt"],
        message: "Open jobs cannot have a TTL",
      });
    if (["pending", "leased", "retry_wait"].includes(value.state)) {
      if (
        value.completedAt !== undefined ||
        value.naturallyExpiredAt !== undefined ||
        value.terminalAt !== undefined
      )
        context.addIssue({
          code: "custom",
          message: "Open jobs cannot have terminal timestamps",
        });
    }
    if (value.state === "completed") {
      if (
        value.terminalAt !== undefined ||
        value.naturallyExpiredAt !== undefined
      )
        context.addIssue({
          code: "custom",
          message: "Completed job has terminal-only fields",
        });
      if (
        value.completedAt === undefined ||
        value.ttlDeleteAt !== value.completedAt + 7 * 24 * 60 * 60 * 1000
      )
        context.addIssue({
          code: "custom",
          message: "Completed job retention is seven days",
        });
    }
    if (value.state === "terminal_failure") {
      const terminalAt = value.terminalAt ?? value.completedAt;
      if (value.naturallyExpiredAt !== undefined)
        context.addIssue({
          code: "custom",
          message: "Terminal failure cannot be naturally expired",
        });
      if (
        value.ttlDeleteAt === undefined ||
        terminalAt === undefined ||
        value.ttlDeleteAt !== terminalAt + 30 * 24 * 60 * 60 * 1000
      )
        context.addIssue({
          code: "custom",
          message: "Terminal failure retention is thirty days",
        });
    }
    if (value.state === "naturally_expired") {
      if (value.completedAt !== undefined || value.terminalAt !== undefined)
        context.addIssue({
          code: "custom",
          message: "Natural expiry cannot have completion fields",
        });
      if (
        value.naturallyExpiredAt === undefined ||
        value.ttlDeleteAt !==
          value.naturallyExpiredAt + 30 * 24 * 60 * 60 * 1000
      )
        context.addIssue({
          code: "custom",
          message: "Natural expiry retention is thirty days",
        });
    }
  });
export type TurnRevocationJob = z.infer<typeof TurnRevocationJobSchema>;

export const ServerDeviceSessionRegistrySchema = z
  .object({
    deviceScopeHash: ThumbprintSchema,
    ownerUid: text,
    deviceId: id,
    generation: positiveInteger,
    activeSessionIds: z.array(id).max(16),
    updatedAt: safeInteger,
    expiresAt: safeInteger.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.activeSessionIds.length > 0 && value.expiresAt !== undefined)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Active registry cannot expire",
      });
    if (value.activeSessionIds.length === 0 && value.expiresAt === undefined)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Empty registry requires an expiry",
      });
  });

const liveRunBase = {
  schemaVersion: z.literal(1),
  runId: id,
  purpose: z.enum(["live-release-smoke", "claim-isolation-canary"]),
  knownUidFingerprint: ThumbprintSchema,
  stableDeviceProfileFingerprints: z.array(ThumbprintSchema).max(8),
  state: z.enum([
    "running",
    "terminalizing",
    "terminal",
    "revocation_pending",
    "abandoned",
  ]),
  createdAt: safeInteger,
  updatedAt: safeInteger,
  runLeaseExpiresAt: safeInteger,
  knownSessionIds: z.array(id).max(64),
  knownIssuanceIds: z.array(id).max(128),
  counters: z
    .object({
      sessions: z.number().int().nonnegative().max(1000),
      issuances: z.number().int().nonnegative().max(1000),
      revocations: z.number().int().nonnegative().max(1000),
    })
    .strict(),
  lastSafeStatus: z.string().max(512),
  ambiguousTurnUntil: safeInteger.optional(),
  candidateSha256: ThumbprintSchema.optional(),
  releaseReceiptHash: ThumbprintSchema.optional(),
  terminalSummary: z
    .object({
      closedSessions: z.number().int().nonnegative(),
      reconciledIssuances: z.number().int().nonnegative(),
    })
    .strict()
    .optional(),
  ttlDeleteAt: safeInteger.optional(),
};
export const ServerLiveTestRunSchema = z
  .object(liveRunBase)
  .strict()
  .superRefine((value, context) => {
    if (
      value.purpose === "claim-isolation-canary" &&
      (value.candidateSha256 || value.releaseReceiptHash)
    )
      context.addIssue({
        code: "custom",
        message: "Claim canary cannot contain release receipt fields",
      });
    if (value.purpose === "claim-isolation-canary") {
      if (value.knownSessionIds.length > 0 || value.knownIssuanceIds.length > 0)
        context.addIssue({
          code: "custom",
          message: "Claim canary cannot contain product IDs",
        });
      if (Object.values(value.counters).some((counter) => counter !== 0))
        context.addIssue({
          code: "custom",
          message: "Claim canary counters must be zero",
        });
    }
    if (
      value.purpose === "live-release-smoke" &&
      (!value.candidateSha256 || !value.releaseReceiptHash)
    )
      context.addIssue({
        code: "custom",
        message: "Release smoke requires candidate and receipt fingerprints",
      });
    if (
      ["terminal", "abandoned", "revocation_pending"].includes(value.state) &&
      value.ttlDeleteAt === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["ttlDeleteAt"],
        message: "Terminal live runs require retention TTL",
      });
    if (
      ["terminal", "abandoned", "revocation_pending"].includes(value.state) &&
      value.ttlDeleteAt !== value.updatedAt + 30 * 24 * 60 * 60 * 1000
    )
      context.addIssue({
        code: "custom",
        path: ["ttlDeleteAt"],
        message:
          "Live run retention must be thirty days from terminal transition",
      });
    if (
      ["running", "terminalizing"].includes(value.state) &&
      value.ttlDeleteAt !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["ttlDeleteAt"],
        message: "Active live runs cannot have retention TTL",
      });
  });

export const ServerLiveTestLeaseSchema = z
  .object({
    projectId: z.literal("codra-1b3bb"),
    runId: id,
    candidateSha256: ThumbprintSchema.optional(),
    releaseReceiptHash: ThumbprintSchema.optional(),
    profileFingerprints: z.array(ThumbprintSchema).max(8),
    state: z.enum(["active", "terminalizing"]),
    createdAt: safeInteger,
    heartbeatAt: safeInteger,
    expiresAt: safeInteger,
  })
  .strict();

export const ServerRemoteReleaseOperationSchema = z
  .object({
    operationId: id,
    candidateSha256: ThumbprintSchema,
    accountFingerprint: ThumbprintSchema,
    releaseControlPrincipalHash: ThumbprintSchema,
    selectorHash: ThumbprintSchema,
    preStateHash: ThumbprintSchema,
    attestationHash: ThumbprintSchema,
    fencingToken: positiveInteger,
    leaseAt: safeInteger,
    leaseExpiresAt: safeInteger,
    heartbeatAt: safeInteger,
    lroResourceHashes: z.array(ThumbprintSchema).max(32),
    state: z.enum(["deploying", "failed_blocking", "succeeded", "superseded"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.leaseExpiresAt <= value.leaseAt)
      context.addIssue({
        code: "custom",
        path: ["leaseExpiresAt"],
        message: "Release lease must expire after acquisition",
      });
  });
export const ServerRemoteReleaseReceiptSchema = z
  .object({
    candidateSha256: ThumbprintSchema,
    authoritativeAttestationHash: ThumbprintSchema,
    releaseControlPrincipalFingerprint: ThumbprintSchema,
    operationId: id,
    fencingToken: positiveInteger,
    createdAt: safeInteger,
    updatedAt: safeInteger,
  })
  .strict();

export const DesktopLoginTransactionSchema = z
  .object({
    transactionId: id,
    deviceId: id,
    keyThumbprint: ThumbprintSchema,
    pkceChallenge: PkceChallengeSchema,
    stateHash: ThumbprintSchema,
    nonceHash: ThumbprintSchema,
    expiresAt: safeInteger,
    consumedAt: safeInteger.optional(),
  })
  .strict();
export const SignalSequenceKeySchema = z
  .object({
    sessionId: id,
    negotiationId: text,
    senderDeviceId: id,
    recipientDeviceId: id,
  })
  .strict();

export interface ExpiredSessionCleanupPort {
  readServerNow(): Promise<number>;
  readSession(
    ownerUid: string,
    sessionId: string,
  ): Promise<RemoteSession | undefined>;
  commitExpiredSession(input: {
    ownerUid: string;
    sessionId: string;
    expectedUpdateTime: number;
    closedAt: number;
    failureCode: "LEASE_EXPIRED";
    removeSessionId: string;
    removeFromOwnerRegistry: true;
    removeFromHostRegistry: true;
    reconcileKnownIssuances: true;
    idempotentRetry: boolean;
  }): Promise<void>;
}

export interface ExpiredSessionCleanupRequest {
  ownerUid: string;
  sessionId: string;
  expectedUpdateTime: number;
}

/**
 * Returns an Admin-only cleanup callback. The callback rereads authoritative
 * state through the injected port and never accepts a caller-supplied session
 * snapshot or clock.
 */
export function createExpiredSessionCleanup(
  port: ExpiredSessionCleanupPort,
): (input: ExpiredSessionCleanupRequest) => Promise<void> {
  return async (input) => {
    const current = await port.readSession(input.ownerUid, input.sessionId);
    if (
      !current ||
      current.ownerUid !== input.ownerUid ||
      current.sessionId !== input.sessionId
    )
      throw new Error("SESSION_NOT_FOUND");
    const parsed = RemoteSessionSchema.parse(current);
    const alreadyExpired =
      parsed.status === "failed" && parsed.failureCode === "LEASE_EXPIRED";
    if (!alreadyExpired && parsed.updatedAt !== input.expectedUpdateTime)
      throw new Error("SESSION_UPDATE_RACE");
    const now = await port.readServerNow();
    if (!alreadyExpired) {
      if (deriveSessionState(parsed, now) !== "expired")
        throw new Error("SESSION_NOT_EXPIRED");
      if (["rejected", "closed", "failed"].includes(parsed.status))
        throw new Error("SESSION_TERMINAL");
    }
    await port.commitExpiredSession({
      ...input,
      closedAt: alreadyExpired ? (parsed.closedAt ?? now) : now,
      failureCode: "LEASE_EXPIRED",
      removeSessionId: input.sessionId,
      removeFromOwnerRegistry: true,
      removeFromHostRegistry: true,
      reconcileKnownIssuances: true,
      idempotentRetry: alreadyExpired,
    });
  };
}

import { z } from "zod";
import {
  canonicalJson,
  canonicalPayloadDigest,
  P256SignatureSchema,
  PkceChallengeSchema,
  PkceVerifierSchema,
  PublicEcJwkSchema,
  ThumbprintSchema,
  createRfc7638Thumbprint,
} from "./remote-signing";
import { TerminalIdSchema, TerminalSizeSchema } from "./terminal";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const ACCOUNT_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
export const ACCOUNT_AUTH_FUTURE_SKEW_MS = 30 * 1000;
export const PKCE_VERIFIER_RANDOM_BYTES = 32;
export const PKCE_VERIFIER_LENGTH = 43;
export const REMOTE_SESSION_MAX_LEASE_MS = 8 * 60 * 60 * 1000;
export const SIGNAL_LEASE_MS = 60 * 60 * 1000;
export const DEVICE_PRESENCE_LEASE_MS = 120 * 1000;
export const CONTROL_MAX_UTF8_BYTES = 72 * 1024;
export const TERMINAL_INPUT_MAX_UTF8_BYTES = 64 * 1024;
export const TERMINAL_FRAME_MAX_BYTES = 16 * 1024;
export const SIGNAL_PAGE_LIMIT = 500;
export const PENDING_SESSION_LIMIT = 50;
export const MAX_ACTIVE_REMOTE_SESSIONS_PER_DEVICE = 16;
export const MAX_ACTIVE_TURN_ISSUANCES_PER_SESSION = 12;
export const FUNCTION_REGION = "asia-northeast3" as const;

const safeInteger = z.number().int().nonnegative().safe();
const positiveSafeInteger = z.number().int().positive().safe();
const deviceId = z.string().uuid();
const nonEmptyText = z.string().min(1).max(4096);
const requestedScopes = z.array(z.string().min(1).max(80)).min(1).max(16);
const timestamp = safeInteger;

export const RemoteFailureCodeSchema = z.enum([
  "AUTH_FAILED",
  "HOST_OFFLINE",
  "APPROVAL_INVALID",
  "NEGOTIATION_TIMEOUT",
  "ICE_FAILED",
  "CHANNEL_CLOSED",
  "PROTOCOL_ERROR",
  "INTERNAL_ERROR",
  "LEASE_EXPIRED",
]);
export type RemoteFailureCode = z.infer<typeof RemoteFailureCodeSchema>;

export const RemoteDeviceSchema = z
  .object({
    deviceId,
    ownerUid: nonEmptyText,
    kind: z.enum(["host", "browser"]),
    displayName: z.string().min(1).max(200),
    publicKeyJwk: PublicEcJwkSchema,
    keyThumbprint: ThumbprintSchema,
    active: z.boolean(),
    generation: positiveSafeInteger,
    remoteAccessEnabled: z.boolean(),
    capabilities: z.array(z.string().min(1).max(80)).max(32),
    createdAt: timestamp,
    lastSeenAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (createRfc7638Thumbprint(value.publicKeyJwk) !== value.keyThumbprint) {
      context.addIssue({
        code: "custom",
        path: ["keyThumbprint"],
        message: "Thumbprint does not match public key",
      });
    }
    if (value.expiresAt < value.lastSeenAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Presence expiry must not precede lastSeenAt",
      });
    }
  });
export type RemoteDevice = z.infer<typeof RemoteDeviceSchema>;

export const DesktopLoginActionSchema = z.enum([
  "register",
  "resume",
  "reenable",
]);
export type DesktopLoginAction = z.infer<typeof DesktopLoginActionSchema>;

const desktopLoginStateSchema = PkceVerifierSchema;
const desktopLoginCodeSchema = PkceVerifierSchema;
const desktopLoginNonceSchema = PkceVerifierSchema;

export const DesktopLoginStartRequestSchema = z
  .object({
    attemptId: deviceId,
    action: DesktopLoginActionSchema,
    deviceId,
    displayName: z.string().min(1).max(200),
    publicKeyJwk: PublicEcJwkSchema,
    keyThumbprint: ThumbprintSchema,
    pkceChallenge: PkceChallengeSchema,
    stateHash: ThumbprintSchema,
    nonce: desktopLoginNonceSchema,
    callbackPort: z.number().int().min(1).max(65_535).safe(),
    callbackPath: z.literal("/auth/callback"),
    startSignature: P256SignatureSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (createRfc7638Thumbprint(value.publicKeyJwk) !== value.keyThumbprint) {
      context.addIssue({
        code: "custom",
        path: ["keyThumbprint"],
        message: "Thumbprint does not match public key",
      });
    }
  });
export type DesktopLoginStartRequest = z.infer<
  typeof DesktopLoginStartRequestSchema
>;

export const DesktopLoginAuthorizeRequestSchema = z
  .object({
    action: z.enum(["inspect", "allow"]),
    attemptId: deviceId,
    state: desktopLoginStateSchema,
  })
  .strict();
export type DesktopLoginAuthorizeRequest = z.infer<
  typeof DesktopLoginAuthorizeRequestSchema
>;

export const DesktopLoginRedeemRequestSchema = z
  .object({
    attemptId: deviceId,
    code: desktopLoginCodeSchema,
    state: desktopLoginStateSchema,
    nonce: desktopLoginNonceSchema,
    pkceVerifier: PkceVerifierSchema,
    deviceSignature: P256SignatureSchema,
  })
  .strict();
export type DesktopLoginRedeemRequest = z.infer<
  typeof DesktopLoginRedeemRequestSchema
>;

export const DesktopLoginCancelRequestSchema = z
  .object({
    attemptId: deviceId,
    state: desktopLoginStateSchema,
  })
  .strict();
export type DesktopLoginCancelRequest = z.infer<
  typeof DesktopLoginCancelRequestSchema
>;

export const DesktopLoginInspectResponseSchema = z
  .object({
    attemptId: deviceId,
    action: DesktopLoginActionSchema,
    displayName: z.string().min(1).max(200),
    fingerprintSuffix: z.string().min(1).max(64),
  })
  .strict();
export type DesktopLoginInspectResponse = z.infer<
  typeof DesktopLoginInspectResponseSchema
>;

export const DesktopLoginAllowResponseSchema = z
  .object({
    attemptId: deviceId,
    callbackUrl: z.url(),
    state: desktopLoginStateSchema,
    code: desktopLoginCodeSchema,
  })
  .strict();
export type DesktopLoginAllowResponse = z.infer<
  typeof DesktopLoginAllowResponseSchema
>;

export const DesktopLoginRedeemResponseSchema = z
  .object({
    token: nonEmptyText,
    serverTimeMillis: timestamp,
    device: RemoteDeviceSchema,
  })
  .strict();
export type DesktopLoginRedeemResponse = z.infer<
  typeof DesktopLoginRedeemResponseSchema
>;

export const DesktopLoginCancelResponseSchema = z
  .object({ cancelled: z.boolean() })
  .strict();
export type DesktopLoginCancelResponse = z.infer<
  typeof DesktopLoginCancelResponseSchema
>;

export function buildDesktopLoginStartSigningPayload(
  request: DesktopLoginStartRequest,
): Omit<DesktopLoginStartRequest, "startSignature"> {
  const { startSignature, ...unsigned } =
    DesktopLoginStartRequestSchema.parse(request);
  void startSignature;
  return unsigned;
}

const DesktopLoginRedeemSigningPayloadSchema = z
  .object({
    domain: z.literal("codra.desktop-login.redeem.v1"),
    attemptId: deviceId,
    code: desktopLoginCodeSchema,
    state: desktopLoginStateSchema,
    nonce: desktopLoginNonceSchema,
    deviceId,
    keyThumbprint: ThumbprintSchema,
  })
  .strict();
export type DesktopLoginRedeemSigningPayload = z.infer<
  typeof DesktopLoginRedeemSigningPayloadSchema
>;

export function buildDesktopLoginRedeemSigningPayload(input: {
  attemptId: string;
  code: string;
  state: string;
  nonce: string;
  deviceId: string;
  keyThumbprint: string;
}): DesktopLoginRedeemSigningPayload {
  return DesktopLoginRedeemSigningPayloadSchema.parse({
    ...input,
    domain: "codra.desktop-login.redeem.v1",
  });
}

const immutableSessionShape = {
  sessionId: z.string().uuid(),
  ownerUid: nonEmptyText,
  clientDeviceId: deviceId,
  hostDeviceId: deviceId,
  clientKeyThumbprint: ThumbprintSchema,
  hostKeyThumbprint: ThumbprintSchema,
  clientDeviceGeneration: positiveSafeInteger,
  hostDeviceGeneration: positiveSafeInteger,
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  requestedScopes,
  clientChallenge: nonEmptyText,
  requestSignature: P256SignatureSchema,
  createdAt: timestamp,
  expiresAt: timestamp,
};

function validateSessionLease(
  value: { createdAt: number; expiresAt: number },
  context: z.RefinementCtx,
): void {
  if (
    value.expiresAt <= value.createdAt ||
    value.expiresAt > value.createdAt + REMOTE_SESSION_MAX_LEASE_MS
  ) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Session lease exceeds its bounded lifetime",
    });
  }
}

export const SessionRequestSchema = z
  .object(immutableSessionShape)
  .strict()
  .superRefine(validateSessionLease);
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

export const RejectionReasonSchema = z.enum([
  "USER_REJECTED",
  "HOST_BUSY",
  "HOST_DISABLED",
]);

export const RemoteSessionSchema = z
  .object({
    ...immutableSessionShape,
    status: z.enum([
      "requested",
      "approved",
      "rejected",
      "signaling",
      "connected",
      "disconnected",
      "closed",
      "failed",
    ]),
    updatedAt: timestamp.optional(),
    approvedScopes: z.array(z.string().min(1).max(80)).max(16).optional(),
    hostChallenge: nonEmptyText.optional(),
    approvalSignature: P256SignatureSchema.optional(),
    decidedAt: timestamp.optional(),
    rejectionReason: RejectionReasonSchema.optional(),
    rejectionSignature: P256SignatureSchema.optional(),
    connectedAt: timestamp.optional(),
    disconnectedAt: timestamp.optional(),
    closedAt: timestamp.optional(),
    failureCode: RemoteFailureCodeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    validateSessionLease(value, context);
    if (
      value.approvedScopes &&
      value.approvedScopes.some(
        (scope) => !value.requestedScopes.includes(scope),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvedScopes"],
        message: "Approved scopes must be requested",
      });
    }
    const require = (key: keyof typeof value, message: string): void => {
      if (value[key] === undefined)
        context.addIssue({ code: "custom", path: [key], message });
    };
    const absent = (key: keyof typeof value): void => {
      if (value[key] !== undefined)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Field is not valid for this status",
        });
    };
    const requireApprovalPrefix = (): void => {
      for (const key of [
        "decidedAt",
        "hostChallenge",
        "approvalSignature",
        "approvedScopes",
      ] as const)
        require(key, "Approved session history is required");
    };
    if (value.status === "requested") {
      for (const key of [
        "decidedAt",
        "connectedAt",
        "disconnectedAt",
        "closedAt",
        "failureCode",
        "hostChallenge",
        "approvalSignature",
        "approvedScopes",
        "rejectionReason",
        "rejectionSignature",
      ] as const)
        absent(key);
    } else if (value.status === "approved" || value.status === "signaling") {
      for (const key of [
        "decidedAt",
        "hostChallenge",
        "approvalSignature",
      ] as const)
        require(key, "Approval field is required");
      require("approvedScopes", "Approved scopes are required");
      for (const key of [
        "connectedAt",
        "disconnectedAt",
        "closedAt",
        "failureCode",
        "rejectionReason",
        "rejectionSignature",
      ] as const)
        absent(key);
    } else if (value.status === "rejected") {
      for (const key of [
        "decidedAt",
        "closedAt",
        "rejectionReason",
        "rejectionSignature",
      ] as const)
        require(key, "Rejection field is required");
      if (!value.approvedScopes || value.approvedScopes.length > 0)
        context.addIssue({
          code: "custom",
          path: ["approvedScopes"],
          message: "Rejected session cannot approve scopes",
        });
      for (const key of [
        "hostChallenge",
        "approvalSignature",
        "connectedAt",
        "disconnectedAt",
        "failureCode",
      ] as const)
        absent(key);
    } else if (value.status === "connected") {
      requireApprovalPrefix();
      for (const key of ["decidedAt", "connectedAt"] as const)
        require(key, "Connected session timestamp is required");
      for (const key of [
        "disconnectedAt",
        "closedAt",
        "failureCode",
        "rejectionReason",
        "rejectionSignature",
      ] as const)
        absent(key);
    } else if (value.status === "disconnected") {
      requireApprovalPrefix();
      for (const key of ["decidedAt", "connectedAt", "disconnectedAt"] as const)
        require(key, "Disconnected session timestamp is required");
      if (
        value.failureCode !== "ICE_FAILED" &&
        value.failureCode !== "CHANNEL_CLOSED"
      )
        context.addIssue({
          code: "custom",
          path: ["failureCode"],
          message: "Disconnected requires a channel failure",
        });
      absent("closedAt");
      absent("rejectionReason");
      absent("rejectionSignature");
    } else if (value.status === "closed") {
      require("closedAt", "Closed timestamp is required");
      absent("failureCode");
      if (value.decidedAt === undefined) {
        for (const key of [
          "hostChallenge",
          "approvalSignature",
          "approvedScopes",
          "rejectionReason",
          "rejectionSignature",
          "connectedAt",
          "disconnectedAt",
        ] as const)
          absent(key);
      } else {
        requireApprovalPrefix();
        absent("rejectionReason");
        absent("rejectionSignature");
      }
      if (value.disconnectedAt !== undefined && value.connectedAt === undefined)
        context.addIssue({
          code: "custom",
          path: ["disconnectedAt"],
          message: "A disconnect requires a connection",
        });
      if (value.connectedAt !== undefined && value.decidedAt === undefined)
        context.addIssue({
          code: "custom",
          path: ["connectedAt"],
          message: "A connection requires a decision",
        });
      if (value.decidedAt === undefined && value.connectedAt !== undefined)
        context.addIssue({
          code: "custom",
          path: ["decidedAt"],
          message: "Closed session history is invalid",
        });
    } else if (value.status === "failed") {
      require("closedAt", "Failed timestamp is required");
      require("failureCode", "Failure code is required");
      const code = value.failureCode;
      if (
        code === "AUTH_FAILED" ||
        code === "HOST_OFFLINE" ||
        code === "APPROVAL_INVALID"
      ) {
        for (const key of [
          "decidedAt",
          "connectedAt",
          "disconnectedAt",
        ] as const)
          absent(key);
        for (const key of [
          "hostChallenge",
          "approvalSignature",
          "approvedScopes",
          "rejectionReason",
          "rejectionSignature",
        ] as const)
          absent(key);
      } else if (code === "NEGOTIATION_TIMEOUT" || code === "ICE_FAILED") {
        requireApprovalPrefix();
        require("decidedAt", "Negotiation failure requires a decision");
        absent("connectedAt");
        absent("disconnectedAt");
      } else if (code === "CHANNEL_CLOSED" || code === "PROTOCOL_ERROR") {
        requireApprovalPrefix();
        require("decidedAt", "Channel failure requires a decision");
        require("connectedAt", "Channel failure requires a connection");
      } else if (code === "INTERNAL_ERROR" || code === "LEASE_EXPIRED") {
        if (value.decidedAt === undefined) {
          for (const key of [
            "hostChallenge",
            "approvalSignature",
            "approvedScopes",
            "connectedAt",
            "disconnectedAt",
            "rejectionReason",
            "rejectionSignature",
          ] as const)
            absent(key);
        } else {
          requireApprovalPrefix();
          absent("rejectionReason");
          absent("rejectionSignature");
          if (value.disconnectedAt !== undefined)
            require("connectedAt", "A disconnect requires a connection");
        }
      }
      if (code !== "INTERNAL_ERROR" && code !== "LEASE_EXPIRED") {
        absent("rejectionReason");
        absent("rejectionSignature");
      }
    }
    if (value.decidedAt !== undefined && value.decidedAt < value.createdAt)
      context.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "Decision precedes request",
      });
    const timeline = [
      ["createdAt", value.createdAt],
      ["decidedAt", value.decidedAt],
      ["connectedAt", value.connectedAt],
      ["disconnectedAt", value.disconnectedAt],
      ["closedAt", value.closedAt],
    ] as const;
    let previous: number | undefined;
    for (const [key, point] of timeline) {
      if (point === undefined) continue;
      if (previous !== undefined && point < previous)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Session timestamps must be monotonic",
        });
      previous = point;
    }
  });
export type RemoteSession = z.infer<typeof RemoteSessionSchema>;

export type DerivedSessionState = RemoteSession["status"] | "expired";
export function deriveSessionState(
  session: RemoteSession,
  now: number,
): DerivedSessionState {
  const parsed = RemoteSessionSchema.parse(session);
  if (
    [
      "requested",
      "approved",
      "signaling",
      "connected",
      "disconnected",
    ].includes(parsed.status) &&
    now >= parsed.expiresAt
  )
    return "expired";
  return parsed.status;
}

export const SignalPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("offer"),
      sdp: z
        .string()
        .min(1)
        .max(256 * 1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("answer"),
      sdp: z
        .string()
        .min(1)
        .max(256 * 1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("candidate"),
      candidate: z
        .string()
        .min(1)
        .max(16 * 1024),
      sdpMid: z.string().max(256).nullable().optional(),
      sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("end-of-candidates") }).strict(),
]);
export const SignalSchema = z
  .object({
    sessionId: z.string().uuid(),
    negotiationId: nonEmptyText,
    senderDeviceId: deviceId,
    recipientDeviceId: deviceId,
    signerThumbprint: ThumbprintSchema,
    signerDeviceGeneration: positiveSafeInteger,
    sequence: positiveSafeInteger,
    kind: z.enum(["offer", "answer", "candidate", "end-of-candidates"]),
    payload: SignalPayloadSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    signature: P256SignatureSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.payload.type !== value.kind)
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "Signal kind must match payload",
      });
    if (
      value.expiresAt <= value.createdAt ||
      value.expiresAt > value.createdAt + SIGNAL_LEASE_MS
    )
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Signal lease is outside its bound",
      });
  });
export type Signal = z.infer<typeof SignalSchema>;

const signedBinding = {
  domain: z.literal("codra.session-request.v1"),
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  sessionId: z.string().uuid(),
  ownerUid: nonEmptyText,
  clientDeviceId: deviceId,
  hostDeviceId: deviceId,
  clientKeyThumbprint: ThumbprintSchema,
  hostKeyThumbprint: ThumbprintSchema,
  clientDeviceGeneration: positiveSafeInteger,
  hostDeviceGeneration: positiveSafeInteger,
  requestedScopes,
  clientChallenge: nonEmptyText,
  expiresAtMillis: timestamp,
};
export const SessionRequestSignedPayloadSchema = z
  .object(signedBinding)
  .strict();
export const SessionApprovalSchema = z
  .object({
    domain: z.literal("codra.session-approval.v1"),
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    sessionId: z.string().uuid(),
    clientDeviceId: deviceId,
    hostDeviceId: deviceId,
    clientKeyThumbprint: ThumbprintSchema,
    hostKeyThumbprint: ThumbprintSchema,
    clientDeviceGeneration: positiveSafeInteger,
    hostDeviceGeneration: positiveSafeInteger,
    requestedScopes,
    approvedScopes: requestedScopes,
    clientChallenge: nonEmptyText,
    hostChallenge: nonEmptyText,
    expiresAtMillis: timestamp,
    signature: P256SignatureSchema,
  })
  .strict();
export const SessionRejectionSchema = z
  .object({
    domain: z.literal("codra.session-rejection.v1"),
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    sessionId: z.string().uuid(),
    ownerUid: nonEmptyText,
    clientDeviceId: deviceId,
    hostDeviceId: deviceId,
    clientKeyThumbprint: ThumbprintSchema,
    hostKeyThumbprint: ThumbprintSchema,
    clientDeviceGeneration: positiveSafeInteger,
    hostDeviceGeneration: positiveSafeInteger,
    requestedScopes,
    clientChallenge: nonEmptyText,
    rejectionReason: RejectionReasonSchema,
    expiresAtMillis: timestamp,
    signature: P256SignatureSchema,
  })
  .strict();

const handshakeBinding = {
  type: z.literal("hello"),
  domain: z.literal("codra.hello.v1"),
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  sessionId: z.string().uuid(),
  negotiationId: nonEmptyText,
  clientDeviceId: deviceId,
  hostDeviceId: deviceId,
  clientKeyThumbprint: ThumbprintSchema,
  hostKeyThumbprint: ThumbprintSchema,
  clientDeviceGeneration: positiveSafeInteger,
  hostDeviceGeneration: positiveSafeInteger,
  clientChallenge: nonEmptyText,
  hostChallenge: nonEmptyText,
  signature: P256SignatureSchema,
};
export const HelloSchema = z.object(handshakeBinding).strict();
export const HelloAckSchema = z
  .object({
    ...handshakeBinding,
    type: z.literal("hello_ack"),
    helloTranscriptHash: ThumbprintSchema,
  })
  .strict();
export type Hello = z.infer<typeof HelloSchema>;

const requestId = z.string().min(1).max(128);
export const RemoteCursorSchema = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/u),
]);
const remoteDescriptorShape = {
  id: TerminalIdSchema,
  title: z.string().min(1).max(200),
  cols: TerminalSizeSchema.shape.cols,
  rows: TerminalSizeSchema.shape.rows,
  state: z.enum(["running", "exited"]),
  createdAt: z.union([timestamp, z.string().datetime()]),
  exitCode: z.number().int().optional(),
};
export const RemoteTerminalDescriptorSchema = z
  .object(remoteDescriptorShape)
  .strict();
export type RemoteTerminalDescriptor = z.infer<
  typeof RemoteTerminalDescriptorSchema
>;

const terminalList = z
  .object({ type: z.literal("terminal.list"), requestId })
  .strict();
const terminalCreate = z
  .object({
    type: z.literal("terminal.create"),
    requestId,
    ...TerminalSizeSchema.shape,
  })
  .strict();
const terminalAttach = z
  .object({
    type: z.literal("terminal.attach"),
    requestId,
    terminalId: TerminalIdSchema,
  })
  .strict();
const terminalDetach = z
  .object({
    type: z.literal("terminal.detach"),
    requestId,
    terminalId: TerminalIdSchema,
  })
  .strict();
const terminalWrite = z
  .object({
    type: z.literal("terminal.write"),
    requestId,
    terminalId: TerminalIdSchema,
    data: z
      .string()
      .min(1)
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <=
          TERMINAL_INPUT_MAX_UTF8_BYTES,
        "Terminal input exceeds 64 KiB",
      ),
  })
  .strict();
const terminalResize = z
  .object({
    type: z.literal("terminal.resize"),
    requestId,
    terminalId: TerminalIdSchema,
    ...TerminalSizeSchema.shape,
  })
  .strict();
const terminalOk = z.discriminatedUnion("operation", [
  z
    .object({
      type: z.literal("terminal.ok"),
      requestId,
      operation: z.literal("terminal.list"),
      result: z
        .object({ terminals: z.array(RemoteTerminalDescriptorSchema).max(100) })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal.ok"),
      requestId,
      operation: z.literal("terminal.create"),
      result: z.object({ terminal: RemoteTerminalDescriptorSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal.ok"),
      requestId,
      operation: z.enum([
        "terminal.attach",
        "terminal.detach",
        "terminal.write",
        "terminal.resize",
      ]),
      result: z.object({ terminalId: TerminalIdSchema }).strict(),
    })
    .strict(),
]);
const terminalError = z
  .object({
    type: z.literal("terminal.error"),
    requestId,
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
  })
  .strict();
const cursorAck = z
  .object({
    type: z.literal("terminal.cursor_ack"),
    terminalId: TerminalIdSchema,
    cursor: RemoteCursorSchema,
  })
  .strict();
const pingPong = z
  .object({ type: z.enum(["ping", "pong"]), nonce: nonEmptyText })
  .strict();
const close = z
  .object({
    type: z.literal("session.close"),
    reason: z.enum([
      "USER_REQUESTED",
      "LEASE_EXPIRED",
      "PROTOCOL_ERROR",
      "CHANNEL_CLOSED",
    ]),
  })
  .strict();

export const RemoteControlMessageSchema = z
  .union([
    HelloSchema,
    HelloAckSchema,
    terminalList,
    terminalCreate,
    terminalAttach,
    terminalDetach,
    terminalWrite,
    terminalResize,
    terminalOk,
    terminalError,
    cursorAck,
    pingPong,
    close,
  ])
  .superRefine((value, context) => {
    if (
      new TextEncoder().encode(
        JSON.stringify(value, (_key, child) =>
          typeof child === "bigint" ? child.toString() : child,
        ),
      ).byteLength > CONTROL_MAX_UTF8_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Control message exceeds 72 KiB",
      });
  });
export type RemoteControlMessage = z.infer<typeof RemoteControlMessageSchema>;

export function validateRemoteControlMessage(
  message: unknown,
): RemoteControlMessage {
  return RemoteControlMessageSchema.parse(message);
}

export function encodeRemoteControlMessage(
  message: RemoteControlMessage,
): Uint8Array {
  const parsed = RemoteControlMessageSchema.parse(message);
  const encoded = new TextEncoder().encode(canonicalJson(parsed));
  if (encoded.byteLength > CONTROL_MAX_UTF8_BYTES)
    throw new RangeError("Control message exceeds 72 KiB");
  return encoded;
}

export function encodeRemoteControlMessageBinary(
  message: RemoteControlMessage,
): ArrayBuffer {
  const bytes = encodeRemoteControlMessage(message);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function decodeRemoteControlMessage(
  bytes: Uint8Array | ArrayBuffer,
): RemoteControlMessage {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (input.byteLength > CONTROL_MAX_UTF8_BYTES)
    throw new RangeError("Control message exceeds 72 KiB");
  return RemoteControlMessageSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)),
  );
}

export const SignalCursorSchema = z
  .object({
    sessionId: z.string().uuid(),
    negotiationId: nonEmptyText,
    senderDeviceId: deviceId,
    recipientDeviceId: deviceId,
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(SIGNAL_PAGE_LIMIT),
  })
  .strict();

export function validateSignalSequence(
  previous: Signal | undefined,
  current: Signal,
): void {
  const parsed = SignalSchema.parse(current);
  if (previous === undefined) {
    if (parsed.sequence !== 1) throw new Error("SIGNAL_SEQUENCE_START");
    return;
  }
  const prior = SignalSchema.parse(previous);
  const sameKey =
    prior.sessionId === parsed.sessionId &&
    prior.senderDeviceId === parsed.senderDeviceId &&
    prior.recipientDeviceId === parsed.recipientDeviceId;
  if (!sameKey) throw new Error("SIGNAL_SEQUENCE_KEY_MISMATCH");
  if (prior.negotiationId !== parsed.negotiationId) {
    if (parsed.sequence !== 1) throw new Error("SIGNAL_SEQUENCE_START");
    return;
  }
  if (parsed.sequence !== prior.sequence + 1)
    throw new Error("SIGNAL_SEQUENCE_GAP");
}

export function canonicalSessionRequestPayload(
  request: SessionRequest,
): string {
  return canonicalJson(buildSessionRequestSigningPayload(request));
}

export function buildSessionRequestSigningPayload(
  request: SessionRequest,
): z.infer<typeof SessionRequestSignedPayloadSchema> {
  return SessionRequestSignedPayloadSchema.parse({
    domain: "codra.session-request.v1",
    protocolVersion: request.protocolVersion,
    sessionId: request.sessionId,
    ownerUid: request.ownerUid,
    clientDeviceId: request.clientDeviceId,
    hostDeviceId: request.hostDeviceId,
    clientKeyThumbprint: request.clientKeyThumbprint,
    hostKeyThumbprint: request.hostKeyThumbprint,
    clientDeviceGeneration: request.clientDeviceGeneration,
    hostDeviceGeneration: request.hostDeviceGeneration,
    requestedScopes: request.requestedScopes,
    clientChallenge: request.clientChallenge,
    expiresAtMillis: request.expiresAt,
  });
}

export function canonicalSignalPayload(signal: Signal): string {
  return canonicalJson(buildSignalSigningPayload(signal));
}

export function buildSignalSigningPayload(
  signal: Signal,
): Record<string, unknown> {
  return {
    domain: "codra.signal.v1",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    sessionId: signal.sessionId,
    negotiationId: signal.negotiationId,
    senderDeviceId: signal.senderDeviceId,
    recipientDeviceId: signal.recipientDeviceId,
    signerThumbprint: signal.signerThumbprint,
    signerDeviceGeneration: signal.signerDeviceGeneration,
    sequence: signal.sequence,
    kind: signal.kind,
    payloadDigest: canonicalPayloadDigest(signal.payload),
    expiresAtMillis: signal.expiresAt,
  };
}

export function canonicalSignalDigest(signal: Signal): string {
  return canonicalPayloadDigest(buildSignalSigningPayload(signal));
}

export function canonicalSessionApprovalPayload(
  approval: z.infer<typeof SessionApprovalSchema>,
): string {
  return canonicalJson(buildSessionApprovalSigningPayload(approval));
}

export function buildSessionApprovalSigningPayload(
  approval: z.infer<typeof SessionApprovalSchema>,
): Omit<z.infer<typeof SessionApprovalSchema>, "signature"> {
  const { signature, ...unsigned } = approval;
  void signature;
  return SessionApprovalSchema.omit({ signature: true }).parse(unsigned);
}

export function canonicalSessionRejectionPayload(
  rejection: z.infer<typeof SessionRejectionSchema>,
): string {
  return canonicalJson(buildSessionRejectionSigningPayload(rejection));
}

export function buildSessionRejectionSigningPayload(
  rejection: z.infer<typeof SessionRejectionSchema>,
): Omit<z.infer<typeof SessionRejectionSchema>, "signature"> {
  const { signature, ...unsigned } = rejection;
  void signature;
  return SessionRejectionSchema.omit({ signature: true }).parse(unsigned);
}

export function canonicalHelloPayload(hello: Hello): string {
  return canonicalJson(buildHelloSigningPayload(hello));
}

export function buildHelloSigningPayload(
  hello: Hello,
): Omit<Hello, "signature"> {
  const { signature, ...unsigned } = hello;
  void signature;
  return unsigned;
}

export function canonicalHelloTranscriptHash(hello: Hello): string {
  return canonicalPayloadDigest(hello);
}

export function canonicalHelloAckPayload(
  ack: z.infer<typeof HelloAckSchema>,
): string {
  return canonicalJson(buildHelloAckSigningPayload(ack));
}

export function buildHelloAckSigningPayload(
  ack: z.infer<typeof HelloAckSchema>,
): Omit<z.infer<typeof HelloAckSchema>, "signature"> {
  const { signature, ...unsigned } = ack;
  void signature;
  return unsigned;
}

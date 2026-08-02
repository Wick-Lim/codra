import {
  RemoteAccountStatusSchema,
  RemoteHostStatusSchema,
  type RemoteAccountStatus,
  type RemoteHostStatus,
} from "@codra/protocol";

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,79}$/u;

export function remoteErrorStatus(error: unknown): RemoteHostStatus {
  const candidate = error instanceof Error ? error.message : "";
  return RemoteHostStatusSchema.parse({
    state: "error",
    message: SAFE_ERROR_CODE.test(candidate)
      ? candidate
      : "REMOTE_ACTIVATION_FAILED",
  });
}

export function remoteAccountErrorStatus(error: unknown): RemoteAccountStatus {
  const candidate = error instanceof Error ? error.message : "";
  return RemoteAccountStatusSchema.parse({
    state: "error",
    message: SAFE_ERROR_CODE.test(candidate)
      ? candidate
      : "REMOTE_AUTH_FAILED",
  });
}

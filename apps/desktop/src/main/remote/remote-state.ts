import { RemoteHostStatusSchema, type RemoteHostStatus } from "@codra/protocol";

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,79}$/u;

export function remoteErrorStatus(error: unknown): RemoteHostStatus {
  const candidate = error instanceof Error ? error.message : "";
  return RemoteHostStatusSchema.parse({
    state: "error",
    message: SAFE_ERROR_CODE.test(candidate)
      ? candidate
      : "REMOTE_LOGIN_FAILED",
  });
}

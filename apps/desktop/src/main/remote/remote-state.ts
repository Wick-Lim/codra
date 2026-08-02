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
    message: SAFE_ERROR_CODE.test(candidate) ? candidate : "REMOTE_AUTH_FAILED",
  });
}

export interface RemoteAccountUserProfile {
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}

function trustedProfilePhotoUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "googleusercontent.com" &&
        !url.hostname.endsWith(".googleusercontent.com"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function remoteSignedInStatus(
  user: RemoteAccountUserProfile,
): RemoteAccountStatus {
  const displayName = user.displayName?.trim() || null;
  const email = user.email?.trim() || null;
  return RemoteAccountStatusSchema.parse({
    state: "signed_in",
    profile: {
      displayName,
      email,
      photoUrl: trustedProfilePhotoUrl(user.photoURL),
    },
  });
}

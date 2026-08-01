import { signInWithGoogle } from "@codra/firebase";
import type { FirebaseRuntime } from "@codra/firebase";
import type { UserCredential } from "firebase/auth";

export const webAccountBootstrap = "google" as const;

export function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
): Promise<UserCredential> {
  return signInWithGoogle(runtime.auth);
}

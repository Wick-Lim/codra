import { signInWithEmailAndPassword, type UserCredential } from "firebase/auth";
import type { FirebaseRuntime } from "@codra/firebase";

export const remoteAccountBootstrapBinding = "password-test-only-main" as const;

export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
): Promise<UserCredential> {
  const email = process.env.CODRA_REMOTE_TEST_EMAIL;
  const password = process.env.CODRA_REMOTE_TEST_PASSWORD;
  if (!email || !password)
    throw new Error("REMOTE_TEST_EMAIL_AND_PASSWORD_REQUIRED");
  return signInWithEmailAndPassword(runtime.auth, email, password);
}

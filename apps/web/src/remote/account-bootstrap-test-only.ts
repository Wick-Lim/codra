import { signInWithEmailPasswordForEmulator } from "@codra/firebase";
import type { FirebaseRuntime } from "@codra/firebase";
import type { UserCredential } from "firebase/auth";

export const webAccountBootstrap = "password-test-only" as const;

export function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
): Promise<UserCredential> {
  const email = import.meta.env.VITE_CODRA_REMOTE_TEST_EMAIL as
    string | undefined;
  const password = import.meta.env.VITE_CODRA_REMOTE_TEST_PASSWORD as
    string | undefined;
  if (!email || !password)
    return Promise.reject(new Error("REMOTE_TEST_EMAIL_AND_PASSWORD_REQUIRED"));
  return signInWithEmailPasswordForEmulator(runtime.auth, email, password);
}

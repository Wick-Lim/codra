import { signInWithEmailAndPassword } from "firebase/auth";
import type { FirebaseRuntime } from "@codra/firebase";
import type { DesktopLoginBootstrapOptions } from "./desktop-login";

export const remoteAccountBootstrapBinding = "password-test-only-main" as const;

export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
  options: DesktopLoginBootstrapOptions,
): Promise<undefined> {
  void options;
  const email = process.env.CODRA_REMOTE_TEST_EMAIL;
  const password = process.env.CODRA_REMOTE_TEST_PASSWORD;
  if (!email || !password)
    throw new Error("REMOTE_TEST_EMAIL_AND_PASSWORD_REQUIRED");
  await signInWithEmailAndPassword(runtime.auth, email, password);
  return undefined;
}

import type { FirebaseRuntime } from "@codra/firebase";

export const remoteAccountBootstrapBinding = "google-main" as const;

export async function bootstrapRemoteAccount(
  runtime: FirebaseRuntime,
): Promise<never> {
  void runtime;
  throw new Error("PRODUCTION_SYSTEM_BROWSER_BRIDGE_REQUIRED");
}

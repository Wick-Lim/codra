import type { SessionApprovalRegistry } from "./session-approval";

export const remoteSessionAutoApproveBinding = "production" as const;

/**
 * The production counterpart of `@codra/remote-session-auto-approve`. It is
 * an inert no-op: no reference to `CODRA_REMOTE_TEST_AUTO_APPROVE`, no path
 * to `SessionApprovalRegistry.approve`. The release build's Vite alias
 * (electron.vite.config.ts) points here instead of at
 * session-auto-approve-test-only.ts, so the code capable of auto-approving a
 * remote session is physically absent from anything CODRA ships — setting
 * the env var on a shipped build has nothing to trigger. The parameters
 * exist only to match the `@codra/remote-session-auto-approve` contract;
 * they are never read.
 */
export function installSessionAutoApprove(
  registry: SessionApprovalRegistry,
  reportError: (error: unknown) => void,
): () => void {
  void registry;
  void reportError;
  return () => undefined;
}

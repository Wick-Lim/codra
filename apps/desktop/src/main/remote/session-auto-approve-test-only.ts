import type { SessionApprovalRegistry } from "./session-approval";

export const remoteSessionAutoApproveBinding = "test-only" as const;

/**
 * Auto-approves every pending remote session at its full requested scope
 * when `CODRA_REMOTE_TEST_AUTO_APPROVE` is exactly `"1"`. This exists only
 * so `remote-reconnect` and `remote-agent-workspace` can reach their actual
 * subject matter without re-driving the approval modal that `remote-direct`
 * already covers. It is wired in only for the remote-test build via the
 * `@codra/remote-session-auto-approve` alias in
 * electron.remote-test.vite.config.ts — see session-auto-approve-production.ts
 * for the build that ships to users.
 */
export function installSessionAutoApprove(
  registry: SessionApprovalRegistry,
  reportError: (error: unknown) => void,
): () => void {
  if (process.env.CODRA_REMOTE_TEST_AUTO_APPROVE !== "1") {
    return () => undefined;
  }
  const attempted = new Set<string>();
  return registry.onChanged((sessions) => {
    for (const session of sessions) {
      if (attempted.has(session.sessionId)) continue;
      attempted.add(session.sessionId);
      registry
        .approve({
          sessionId: session.sessionId,
          approvedScopes: [...session.requestedScopes],
        })
        .catch(reportError);
    }
  });
}

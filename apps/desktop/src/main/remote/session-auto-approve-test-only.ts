import type { SessionApprovalRegistry } from "./session-approval";

// Matches this module's artifact-scanner alias
// (docs/security/remote-baseline.json: "session-auto-approve-test-alias").
// A bare unused export of this literal gets tree-shaken out of the built
// bundle — confirmed for the sibling `remoteSessionAutoApproveBinding`
// export below, and a first attempt at this fix (`void seamMarker;` as a
// standalone statement inside installSessionAutoApprove) was *also*
// eliminated by esbuild as a provably side-effect-free expression. See
// task-15a-report.md, Finding 2, for both real-build proofs. Only an actual
// mutation — Object.assign onto the returned disposer below — survives,
// because a bundler cannot prove a property assignment on an escaping
// object has no observable effect.
export const seamMarker = "session-auto-approve-test-only";

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
  let disposer: () => void;
  if (process.env.CODRA_REMOTE_TEST_AUTO_APPROVE !== "1") {
    disposer = () => undefined;
  } else {
    const attempted = new Set<string>();
    disposer = registry.onChanged((sessions) => {
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
  // See the module-level comment on seamMarker: this assignment is what
  // actually keeps the literal in the built bundle.
  return Object.assign(disposer, { seamMarker });
}

import type { PendingRemoteSession } from "@codra/protocol";
import React from "react";
import { ModalDialog } from "../components/ModalDialog";

const AGENT_LAUNCH_SCOPE = "agent.launch";

const SCOPE_LABELS: Record<string, string> = {
  "workspace.read": "Browse folders on this Mac",
  "agent.runtimes": "List the agent CLIs installed on this Mac",
  "agent.launch": "Run an agent on this Mac",
  "terminal.write": "Type into terminals on this Mac",
  "terminal.resize": "Resize terminals on this Mac",
  "terminal.detach": "Detach from terminals on this Mac",
  "terminal.attach": "Attach to terminals on this Mac",
};

export interface SessionApprovalDialogProps {
  session: PendingRemoteSession;
  busy: boolean;
  error?: string;
  onApprove(approvedScopes: string[]): void;
  onDeny(): void;
}

export function SessionApprovalDialog({
  session,
  busy,
  error,
  onApprove,
  onDeny,
}: SessionApprovalDialogProps) {
  const [deniedScopes, setDeniedScopes] = React.useState<string[]>([]);
  const denyRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    setDeniedScopes([]);
    denyRef.current?.focus();
  }, [session.sessionId]);

  const deviceLabel = `${session.clientDeviceId.slice(0, 8)}…`;
  const requesterName = session.requesterDisplayName ?? `Device ${deviceLabel}`;

  function toggleScope(scope: string): void {
    setDeniedScopes((current) =>
      current.includes(scope)
        ? current.filter((denied) => denied !== scope)
        : [...current, scope],
    );
  }

  function confirmApproval(): void {
    if (busy) return;
    const approvedScopes = session.requestedScopes.filter(
      (scope) => !deniedScopes.includes(scope),
    );
    if (approvedScopes.length === 0) {
      onDeny();
      return;
    }
    onApprove(approvedScopes);
  }

  return (
    <ModalDialog
      open
      title={`Allow ${requesterName} to connect?`}
      description={`Requesting device ${deviceLabel}. Grant only what this device needs.`}
      className="session-approval-dialog"
      onClose={() => {
        if (!busy) onDeny();
      }}
    >
      <section aria-label="Requested permissions">
        {session.requestedScopes.map((scope) => {
          const label = SCOPE_LABELS[scope];
          return (
            <div className="session-scope-row" key={scope}>
              <div>
                <strong>{label ?? scope}</strong>
                {label ? <p>{scope}</p> : null}
              </div>
              <button
                className="switch-control"
                type="button"
                role="switch"
                aria-label={`Grant ${scope}`}
                aria-checked={!deniedScopes.includes(scope)}
                disabled={busy}
                onClick={() => toggleScope(scope)}
              >
                <span className="switch-thumb" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </section>
      {session.requestedScopes.includes(AGENT_LAUNCH_SCOPE) ? (
        <p className="dialog-footnote">
          Granting agent.launch lets this device run an agent on this Mac,
          possibly with its own tool approvals disabled.
        </p>
      ) : null}
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="agent-dialog-actions">
        <button
          ref={denyRef}
          className="agent-cancel-button"
          type="button"
          disabled={busy}
          onClick={onDeny}
        >
          Deny
        </button>
        <button
          className="agent-start-button"
          type="button"
          disabled={busy}
          onClick={confirmApproval}
        >
          {busy ? "Approving…" : "Approve"}
        </button>
      </footer>
    </ModalDialog>
  );
}

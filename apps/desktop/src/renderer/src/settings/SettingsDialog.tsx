import type { RemoteAccountStatus, RemoteHostStatus } from "@codra/protocol";
import React from "react";
import { ModalDialog } from "../components/ModalDialog";

void React;

export interface SettingsDialogProps {
  open: boolean;
  accountStatus: RemoteAccountStatus;
  remoteStatus: RemoteHostStatus;
  onClose(): void;
  onRemoteChange(enabled: boolean): void;
  onSignIn(): void;
}

function remoteStateCopy(status: RemoteHostStatus): {
  label: string;
  detail: string;
} {
  if (status.state === "online") {
    return {
      label: "This Mac is available remotely",
      detail:
        "Signed-in clients can request a connection. Every session still requires local approval.",
    };
  }
  if (status.state === "activating") {
    return {
      label: "Starting remote host…",
      detail:
        "Registering this device and opening the secure session listener.",
    };
  }
  if (status.state === "error") {
    return {
      label: "Remote access needs attention",
      detail: "Turn it on again to retry. Local CLI sessions are unaffected.",
    };
  }
  return {
    label: "Remote access is off",
    detail: "This Mac is not accepting remote session requests.",
  };
}

export function SettingsDialog({
  open,
  accountStatus,
  remoteStatus,
  onClose,
  onRemoteChange,
  onSignIn,
}: SettingsDialogProps) {
  const signedIn = accountStatus.state === "signed_in";
  const busy = remoteStatus.state === "activating";
  const enabled = remoteStatus.state === "online";
  const copy = remoteStateCopy(remoteStatus);

  return (
    <ModalDialog
      open={open}
      title="Settings"
      description="Supporting controls for this CODRA desktop host."
      className="settings-dialog"
      onClose={onClose}
    >
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          <span className="settings-navigation-label">Desktop</span>
          <button type="button" aria-current="page">
            <span className="settings-nav-signal" aria-hidden="true" />
            Remote access
          </button>
        </nav>
        <section
          className="settings-content"
          aria-labelledby="remote-settings-title"
        >
          <div className="settings-section-heading">
            <div>
              <p className="settings-kicker">CONNECTIVITY</p>
              <h3 id="remote-settings-title">Remote access</h3>
            </div>
            <button
              className="switch-control"
              type="button"
              role="switch"
              aria-label="Remote access"
              aria-checked={enabled}
              disabled={!signedIn || busy}
              onClick={() => onRemoteChange(!enabled)}
            >
              <span className="switch-thumb" />
            </button>
          </div>

          <div className="settings-status" data-state={remoteStatus.state}>
            <span className="settings-status-indicator" aria-hidden="true" />
            <div>
              <strong>{copy.label}</strong>
              <p>{copy.detail}</p>
            </div>
          </div>

          {!signedIn ? (
            <div className="settings-callout">
              <div>
                <strong>Sign in to enable remote access</strong>
                <p>Your local terminals remain available without an account.</p>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={onSignIn}
              >
                Sign in
              </button>
            </div>
          ) : null}

          <div className="settings-boundary">
            <p className="settings-kicker">SECURITY BOUNDARY</p>
            <ul>
              <li>Terminal traffic stays peer-to-peer over WebRTC.</li>
              <li>
                Cloudflare TURN is used only when a direct path is unavailable.
              </li>
              <li>Each incoming session requires approval on this Mac.</li>
            </ul>
          </div>
        </section>
      </div>
    </ModalDialog>
  );
}

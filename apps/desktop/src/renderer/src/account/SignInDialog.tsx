import type { RemoteAuthProvider } from "@codra/protocol";
import React from "react";
import { ModalDialog } from "../components/ModalDialog";

void React;

export interface SignInDialogProps {
  open: boolean;
  busy: boolean;
  message?: string;
  onClose(): void;
  onProvider(provider: RemoteAuthProvider): void;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
      <path
        fill="#4285f4"
        d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.2h5.4a4.6 4.6 0 0 1-2 3v2.7h3.5c2-1.9 3.2-4.6 3.2-7.7Z"
      />
      <path
        fill="#34a853"
        d="M12 22c2.9 0 5.3-1 7-2.6l-3.5-2.7c-1 .7-2.2 1-3.5 1a6.2 6.2 0 0 1-5.8-4.3H2.6v2.8A10.5 10.5 0 0 0 12 22Z"
      />
      <path
        fill="#fbbc05"
        d="M6.2 13.4a6.3 6.3 0 0 1 0-4V6.6H2.6a10.5 10.5 0 0 0 0 9.6l3.6-2.8Z"
      />
      <path
        fill="#ea4335"
        d="M12 5.2c1.6 0 3 .6 4.1 1.6l3-3A10 10 0 0 0 2.6 6.6l3.6 2.8A6.2 6.2 0 0 1 12 5.2Z"
      />
    </svg>
  );
}

export function SignInDialog({
  open,
  busy,
  message,
  onClose,
  onProvider,
}: SignInDialogProps) {
  return (
    <ModalDialog
      open={open}
      title="Sign in to CODRA"
      description="Keep local CLI work independent. Sign in only for remote access and account settings."
      className="sign-in-dialog"
      onClose={onClose}
    >
      <div className="provider-list" aria-label="Sign-in methods">
        <button
          className="provider-option provider-option-primary"
          type="button"
          disabled={busy}
          onClick={() => onProvider("google")}
        >
          <span className="provider-logo">
            <GoogleMark />
          </span>
          <span>
            <strong>
              {busy ? "Opening sign-in…" : "Continue with Google"}
            </strong>
            <small>Opens in a secure CODRA window</small>
          </span>
          <span className="provider-arrow" aria-hidden="true">
            →
          </span>
        </button>
        <button
          className="provider-option"
          type="button"
          aria-label="Email and password — test only"
          disabled
        >
          <span
            className="provider-logo provider-logo-email"
            aria-hidden="true"
          >
            @
          </span>
          <span>
            <strong>Email and password</strong>
            <small>Test builds only</small>
          </span>
          <span className="provider-badge">Unavailable</span>
        </button>
      </div>
      {message ? (
        <p className="dialog-error" role="alert">
          {message}
        </p>
      ) : null}
      <p className="dialog-footnote">
        CODRA never receives your Google password. The sign-in window returns an
        authenticated Firebase session to this desktop app.
      </p>
    </ModalDialog>
  );
}

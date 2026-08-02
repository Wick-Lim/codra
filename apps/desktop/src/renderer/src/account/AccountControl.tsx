import type {
  RemoteAccountProfile,
  RemoteAccountStatus,
} from "@codra/protocol";
import React from "react";

export interface AccountControlProps {
  accountStatus: RemoteAccountStatus;
  onSignIn(): void;
  onOpenSettings(): void;
  onLogout(): void;
}

function accountLabel(profile: RemoteAccountProfile): string {
  return profile.displayName ?? profile.email ?? "CODRA account";
}

function accountInitials(profile: RemoteAccountProfile): string {
  const source = profile.displayName ?? profile.email?.split("@")[0] ?? "C";
  const parts = source.trim().split(/\s+/u).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function AccountAvatar({ profile }: { profile: RemoteAccountProfile }) {
  const label = accountLabel(profile);
  const [failedPhotoUrl, setFailedPhotoUrl] = React.useState<string | null>(
    null,
  );
  if (profile.photoUrl && failedPhotoUrl !== profile.photoUrl) {
    return (
      <img
        className="account-avatar-image"
        src={profile.photoUrl}
        alt={label}
        referrerPolicy="no-referrer"
        onError={() => setFailedPhotoUrl(profile.photoUrl)}
      />
    );
  }
  return (
    <span className="account-avatar-fallback" aria-hidden="true">
      {accountInitials(profile)}
    </span>
  );
}

export function AccountControl({
  accountStatus,
  onSignIn,
  onOpenSettings,
  onLogout,
}: AccountControlProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  if (accountStatus.state !== "signed_in") {
    const busy = accountStatus.state === "signing_in";
    return (
      <div className="account-control account-control-signed-out">
        <button
          className="account-trigger"
          type="button"
          aria-label={busy ? "Cancel sign-in" : "Sign in to CODRA"}
          onClick={busy ? onLogout : onSignIn}
        >
          <span className="account-avatar-fallback" aria-hidden="true">
            {busy ? "×" : "C"}
          </span>
          <span className="account-copy">
            <strong>{busy ? "Cancel sign-in" : "Sign in"}</strong>
            <small>
              {busy ? "Waiting for your browser" : "Remote access & settings"}
            </small>
          </span>
          <span className="account-chevron" aria-hidden="true">
            {busy ? "×" : "→"}
          </span>
        </button>
        {accountStatus.state === "error" ? (
          <p className="account-error" role="alert">
            Sign-in needs attention
          </p>
        ) : null}
      </div>
    );
  }

  const { profile } = accountStatus;
  const label = accountLabel(profile);
  return (
    <div className="account-control" ref={rootRef}>
      {menuOpen ? (
        <div className="account-menu" role="menu" aria-label="Account">
          <div className="account-menu-profile">
            <AccountAvatar profile={profile} />
            <span className="account-copy">
              <strong>{label}</strong>
              <small>{profile.email ?? "Signed in to CODRA"}</small>
            </span>
          </div>
          <div className="account-menu-divider" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onOpenSettings();
            }}
          >
            <span aria-hidden="true">⌘</span>
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onLogout();
            }}
          >
            <span aria-hidden="true">↪</span>
            Sign out
          </button>
        </div>
      ) : null}
      <button
        className="account-trigger"
        type="button"
        aria-label={`Open account menu for ${label}`}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <AccountAvatar profile={profile} />
        <span className="account-copy">
          <strong>{label}</strong>
          <small>{profile.email ?? "CODRA account"}</small>
        </span>
        <span className="account-chevron" aria-hidden="true">
          {menuOpen ? "⌃" : "⌄"}
        </span>
      </button>
    </div>
  );
}

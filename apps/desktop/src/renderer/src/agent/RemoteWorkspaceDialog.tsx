import type {
  RemoteAgentExecutionTarget,
  WorkspaceDirectoryPage,
  WorkspaceRoot,
  WorkspaceSelection,
} from "@codra/protocol";
import React from "react";
import { ModalDialog } from "../components/ModalDialog";

export interface RemoteWorkspaceDialogProps {
  open: boolean;
  target: RemoteAgentExecutionTarget;
  currentPath: string;
  onClose(): void;
  onSelect(selection: WorkspaceSelection): void;
  workspaceRoots(target: RemoteAgentExecutionTarget): Promise<WorkspaceRoot[]>;
  workspaceList(
    target: RemoteAgentExecutionTarget,
    path: string,
  ): Promise<WorkspaceDirectoryPage>;
  workspaceValidate(
    target: RemoteAgentExecutionTarget,
    path: string,
  ): Promise<WorkspaceSelection>;
}

export function RemoteWorkspaceDialog({
  open,
  target,
  currentPath,
  onClose,
  onSelect,
  workspaceRoots,
  workspaceList,
  workspaceValidate,
}: RemoteWorkspaceDialogProps) {
  const [roots, setRoots] = React.useState<WorkspaceRoot[]>([]);
  const [page, setPage] = React.useState<WorkspaceDirectoryPage>();
  const [loading, setLoading] = React.useState(false);
  const [selecting, setSelecting] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const openPath = React.useCallback(
    async (path: string): Promise<void> => {
      setLoading(true);
      setError(undefined);
      try {
        setPage(await workspaceList(target, path));
      } catch {
        setError("The remote folder could not be opened.");
      } finally {
        setLoading(false);
      }
    },
    [target, workspaceList],
  );

  React.useEffect(() => {
    if (!open) return;
    let current = true;
    setRoots([]);
    setPage(undefined);
    setError(undefined);
    setLoading(true);
    void workspaceRoots(target)
      .then((availableRoots) => {
        if (current) setRoots(availableRoots);
      })
      .catch(() => {
        if (current) setError("Remote workspace locations are unavailable.");
      })
      .finally(() => {
        if (current && !currentPath.trim()) setLoading(false);
      });
    if (currentPath.trim()) {
      void workspaceList(target, currentPath)
        .then((currentPage) => {
          if (current) setPage(currentPage);
        })
        .catch(() => {
          if (current) setError("The remote folder could not be opened.");
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }
    return () => {
      current = false;
    };
  }, [currentPath, open, target, workspaceList, workspaceRoots]);

  async function selectCurrent(): Promise<void> {
    if (!page || selecting) return;
    setSelecting(true);
    setError(undefined);
    try {
      onSelect(await workspaceValidate(target, page.path));
    } catch {
      setError("This remote folder cannot be used as a workspace.");
    } finally {
      setSelecting(false);
    }
  }

  return (
    <ModalDialog
      open={open}
      title={`Choose workspace on ${target.displayName}`}
      description="Browse folders on the selected device. Only the chosen path is shared with this session."
      className="remote-workspace-dialog"
      onClose={onClose}
    >
      <div className="remote-workspace-shell">
        <nav className="remote-workspace-breadcrumbs" aria-label="Folder path">
          {page ? (
            <React.Fragment>
              <button
                type="button"
                onClick={() => setPage(undefined)}
                disabled={loading || selecting}
              >
                Locations
              </button>
              {page.breadcrumbs.map((breadcrumb) => (
                <React.Fragment key={breadcrumb.path}>
                  <span aria-hidden="true">/</span>
                  <button
                    type="button"
                    aria-current={
                      breadcrumb.path === page.path ? "location" : undefined
                    }
                    disabled={
                      loading || selecting || breadcrumb.path === page.path
                    }
                    onClick={() => void openPath(breadcrumb.path)}
                  >
                    {breadcrumb.label}
                  </button>
                </React.Fragment>
              ))}
            </React.Fragment>
          ) : (
            <span>Available locations</span>
          )}
        </nav>

        <div className="remote-workspace-browser" aria-busy={loading}>
          {loading ? (
            <p className="remote-workspace-state">Loading folders…</p>
          ) : page ? (
            page.entries.length > 0 ? (
              <ul className="remote-workspace-list">
                {page.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      aria-label={`Open ${entry.name}`}
                      title={entry.path}
                      disabled={selecting}
                      onClick={() => void openPath(entry.path)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M1.75 4.25h4l1.1 1.5h7.4v6.5H1.75z" />
                      </svg>
                      <span>{entry.name}</span>
                      <span aria-hidden="true">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="remote-workspace-state">No subfolders here.</p>
            )
          ) : roots.length > 0 ? (
            <ul className="remote-workspace-list remote-workspace-roots">
              {roots.map((root) => (
                <li key={root.path}>
                  <button
                    type="button"
                    title={root.path}
                    disabled={selecting}
                    onClick={() => void openPath(root.path)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="2" y="2.25" width="12" height="11.5" rx="2" />
                      <path d="M5 6.25h6M5 9.25h6" />
                    </svg>
                    <span>{root.label}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="remote-workspace-state">No folders are available.</p>
          )}
        </div>

        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="remote-workspace-actions">
          <div className="remote-workspace-current" title={page?.path}>
            <span>Selected</span>
            <strong>{page?.label ?? "Choose a location"}</strong>
          </div>
          <button type="button" onClick={onClose} disabled={selecting}>
            Cancel
          </button>
          <button
            className="agent-start-button"
            type="button"
            disabled={!page || loading || selecting}
            onClick={() => void selectCurrent()}
          >
            {selecting ? "Checking…" : `Use ${page?.label ?? "folder"}`}
          </button>
        </footer>
      </div>
    </ModalDialog>
  );
}

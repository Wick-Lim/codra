import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type {
  WorkspaceDirectoryPage,
  WorkspaceRoot,
  WorkspaceSelection,
} from "@codra/protocol";
import { t } from "../i18n/messages";

const copy = t.console.workspace;

export interface WorkspacePickerProps {
  /** `workspace.roots` — the only directories the host offers as a start. */
  roots(): Promise<WorkspaceRoot[]>;
  /** `workspace.list` — one page of a directory the host permits. */
  list(path: string): Promise<WorkspaceDirectoryPage>;
  /** `workspace.validate` — the host's verdict on a path as a workspace. */
  validate(path: string): Promise<WorkspaceSelection>;
  onSelect(selection: WorkspaceSelection): void;
  disabled?: boolean;
}

/**
 * Step 4 of the console flow: `workspace.roots` -> `workspace.list` to browse,
 * `workspace.validate` to confirm.
 *
 * The three operations arrive as injected functions rather than as a
 * `RemoteAgentChannelClient`, so this component knows nothing about WebRTC, the
 * handshake, or the session — and its tests need none of them.
 *
 * The validated `WorkspaceSelection` is what leaves through `onSelect`, never
 * the path the user browsed to. The host normalises and re-checks the path
 * inside `workspace.validate`, and `agent.launch` validates it a second time
 * (`host-control-gateway.ts:416`); propagating the host's answer keeps the
 * console's idea of the workspace identical to the host's.
 */
export function WorkspacePicker({
  roots,
  list,
  validate,
  onSelect,
  disabled = false,
}: WorkspacePickerProps): ReactElement {
  const [locations, setLocations] = useState<WorkspaceRoot[]>([]);
  const [page, setPage] = useState<WorkspaceDirectoryPage>();
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string>();

  // The parent re-renders on every step of the session, so the operations it
  // passes are new function identities each time. Reading them through a ref
  // keeps the mount effect from re-running `workspace.roots` on every render.
  const operations = useRef({ roots, list, validate });
  operations.current = { roots, list, validate };

  useEffect(() => {
    let active = true;
    void operations.current
      .roots()
      .then((available) => {
        if (active) setLocations(available);
      })
      .catch(() => {
        if (active) setError(copy.rootsFailed);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function openPath(path: string): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      setPage(await operations.current.list(path));
    } catch {
      setError(copy.listFailed);
    } finally {
      setLoading(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!page || selecting) return;
    setSelecting(true);
    setError(undefined);
    try {
      onSelect(await operations.current.validate(page.path));
    } catch {
      setError(copy.validateFailed);
    } finally {
      setSelecting(false);
    }
  }

  const locked = disabled || selecting;

  return (
    <section className="picker-panel" aria-label={copy.title}>
      <div className="panel-heading">
        <div>
          <p className="card-kicker">{copy.kicker}</p>
          <h3>{copy.title}</h3>
        </div>
      </div>
      <p className="muted picker-lead">{copy.lead}</p>

      <nav className="workspace-breadcrumbs" aria-label={copy.breadcrumbLabel}>
        <button
          className="text-button"
          type="button"
          disabled={locked || loading || !page}
          onClick={() => setPage(undefined)}
        >
          {copy.locations}
        </button>
        {page?.breadcrumbs.map((breadcrumb) => (
          <Fragment key={breadcrumb.path}>
            <span aria-hidden="true">/</span>
            <button
              className="text-button"
              type="button"
              aria-current={
                breadcrumb.path === page.path ? "location" : undefined
              }
              disabled={locked || loading || breadcrumb.path === page.path}
              onClick={() => void openPath(breadcrumb.path)}
            >
              {breadcrumb.label}
            </button>
          </Fragment>
        ))}
      </nav>

      <div className="workspace-browser" aria-busy={loading}>
        {loading ? (
          <p className="empty">{copy.loading}</p>
        ) : page ? (
          page.entries.length > 0 ? (
            <ul className="workspace-list">
              {page.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    aria-label={copy.open(entry.name)}
                    title={entry.path}
                    disabled={locked}
                    onClick={() => void openPath(entry.path)}
                  >
                    <span>{entry.name}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">{copy.noEntries}</p>
          )
        ) : locations.length > 0 ? (
          <ul className="workspace-list">
            {locations.map((root) => (
              <li key={root.path}>
                <button
                  type="button"
                  title={root.path}
                  disabled={locked}
                  onClick={() => void openPath(root.path)}
                >
                  <span>{root.label}</span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">{copy.noRoots}</p>
        )}
      </div>

      {error ? (
        <p className="message" role="alert">
          {error}
        </p>
      ) : null}

      <footer className="picker-actions">
        <div className="workspace-selected" title={page?.path}>
          <span>{copy.selectedLabel}</span>
          <strong>{page?.label ?? copy.selectedNone}</strong>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={locked || loading || !page}
          onClick={() => void confirm()}
        >
          {selecting ? copy.checking : copy.use(page?.label ?? "")}
        </button>
      </footer>
    </section>
  );
}

export default WorkspacePicker;

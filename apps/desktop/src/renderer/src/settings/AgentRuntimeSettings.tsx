import type {
  AgentKind,
  AgentRuntime,
  AgentSetupRequest,
} from "@codra/protocol";
import React from "react";

void React;

export interface AgentRuntimeSettingsProps {
  runtimes: readonly AgentRuntime[];
  setupKind?: AgentKind;
  error?: string;
  onSetup(request: AgentSetupRequest): void;
}

function runtimeAction(runtime: AgentRuntime): {
  action: AgentSetupRequest["action"];
  label: string;
  accessibleLabel: string;
} | null {
  if (!runtime.available) {
    if (runtime.setup.installMethod === "external") {
      return {
        action: "install",
        label: "Get Ollama",
        accessibleLabel: "Get Ollama",
      };
    }
    return {
      action: "install",
      label: "Install & sign in",
      accessibleLabel: `Install and sign in to ${runtime.label}`,
    };
  }
  if (runtime.setup.authentication === "required") {
    return {
      action: "authenticate",
      label: "Sign in / switch account",
      accessibleLabel: `Sign in or switch ${runtime.label} account`,
    };
  }
  return null;
}

function runtimeDetail(runtime: AgentRuntime): string {
  if (!runtime.available && runtime.setup.installMethod === "managed_npm") {
    return "Install privately for CODRA, then continue in the provider's own sign-in flow.";
  }
  if (!runtime.available) {
    return "Install the official macOS app, then return here to refresh local discovery.";
  }
  if (runtime.setup.authentication === "required") {
    return "Available to New Agent. Authentication remains owned by this CLI.";
  }
  return "Available to New Agent. Models are discovered from this Mac.";
}

export function AgentRuntimeSettings({
  runtimes,
  setupKind,
  error,
  onSetup,
}: AgentRuntimeSettingsProps) {
  return (
    <section
      className="settings-content agent-runtime-settings"
      aria-labelledby="agent-runtime-settings-title"
    >
      <div className="settings-section-heading">
        <div>
          <p className="settings-kicker">LOCAL TOOLCHAIN</p>
          <h3 id="agent-runtime-settings-title">Agent runtimes</h3>
        </div>
        <span
          className="runtime-count"
          aria-label={`${runtimes.length} runtimes`}
        >
          {runtimes.length.toString().padStart(2, "0")}
        </span>
      </div>
      <p className="agent-runtime-intro">
        Keep setup here. New Agent stays focused on the prompt and run options.
      </p>

      <div className="runtime-rack" role="list" aria-label="Agent runtimes">
        {runtimes.map((runtime) => {
          const action = runtimeAction(runtime);
          const busy = setupKind === runtime.kind;
          return (
            <article
              className="runtime-row"
              data-available={runtime.available}
              data-busy={busy}
              role="listitem"
              key={runtime.kind}
            >
              <span
                className="runtime-status-node"
                data-available={runtime.available}
                aria-hidden="true"
              />
              <div className="runtime-row-copy">
                <div className="runtime-row-title">
                  <strong>{runtime.label}</strong>
                  <span>{runtime.kind}</span>
                </div>
                <p>{runtimeDetail(runtime)}</p>
              </div>
              <div className="runtime-row-action">
                <span className="runtime-state-label">
                  {runtime.available ? "CLI ready" : "Not installed"}
                </span>
                {action ? (
                  <button
                    className="runtime-action-button"
                    type="button"
                    aria-label={
                      busy
                        ? `Setting up ${runtime.label}`
                        : action.accessibleLabel
                    }
                    disabled={busy}
                    onClick={() =>
                      onSetup({ kind: runtime.kind, action: action.action })
                    }
                  >
                    {busy ? "Opening setup…" : action.label}
                  </button>
                ) : (
                  <span className="runtime-no-auth">No sign-in required</span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {runtimes.length === 0 ? (
        <p className="runtime-empty">Runtime discovery is still loading.</p>
      ) : null}
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="runtime-credential-note">
        CODRA never reads or stores provider tokens. Each CLI owns its account
        session.
      </p>
    </section>
  );
}

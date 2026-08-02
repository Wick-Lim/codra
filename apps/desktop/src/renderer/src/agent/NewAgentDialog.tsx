import type {
  AgentKind,
  AgentExecutionTarget,
  AgentLaunchTarget,
  AgentLaunchRequest,
  AgentRuntime,
  RemoteAgentExecutionTarget,
  WorkspaceDirectoryPage,
  WorkspaceRoot,
  WorkspaceSelection,
} from "@codra/protocol";
import { workspacePathLabel } from "@codra/protocol";
import React from "react";
import { ModalDialog } from "../components/ModalDialog";
import { RemoteWorkspaceDialog } from "./RemoteWorkspaceDialog";

export interface NewAgentDialogProps {
  open: boolean;
  agents: readonly AgentRuntime[];
  targets?: readonly AgentLaunchTarget[];
  initialCwd: string;
  busy?: boolean;
  error?: string;
  onClose(): void;
  onStart(
    request: AgentLaunchRequest,
    cwd: string,
    target: AgentExecutionTarget,
  ): void;
  onChooseCwd(currentCwd: string): Promise<string | null>;
  onTargetChange?(target: AgentLaunchTarget): void | Promise<void>;
  workspaceRoots?(target: RemoteAgentExecutionTarget): Promise<WorkspaceRoot[]>;
  workspaceList?(
    target: RemoteAgentExecutionTarget,
    path: string,
  ): Promise<WorkspaceDirectoryPage>;
  workspaceValidate?(
    target: RemoteAgentExecutionTarget,
    path: string,
  ): Promise<WorkspaceSelection>;
  onOpenAgentSettings?(): void;
}

const CUSTOM_MODEL = "__custom__";
type RuntimeValues = Partial<Record<AgentKind, string>>;

const LOCAL_TARGET: AgentLaunchTarget = {
  target: { kind: "local" },
  state: "connected",
};

const unavailableWorkspaceRoots = async (): Promise<WorkspaceRoot[]> => [];
const unavailableWorkspaceList = async (): Promise<WorkspaceDirectoryPage> => {
  throw new Error("REMOTE_WORKSPACE_UNAVAILABLE");
};
const unavailableWorkspaceValidate = async (): Promise<WorkspaceSelection> => {
  throw new Error("REMOTE_WORKSPACE_UNAVAILABLE");
};

function targetKey(target: AgentLaunchTarget["target"]): string {
  return target.kind === "local" ? "local" : `remote:${target.deviceId}`;
}

function targetLabel(target: AgentLaunchTarget["target"]): string {
  return target.kind === "local" ? "This Mac" : target.displayName;
}

function initialModel(runtime: AgentRuntime): string {
  if (!runtime.modelRequired) return "";
  return runtime.models[0]?.id ?? CUSTOM_MODEL;
}

export function NewAgentDialog({
  open,
  agents,
  targets = [LOCAL_TARGET],
  initialCwd,
  busy = false,
  error,
  onClose,
  onStart,
  onChooseCwd,
  onTargetChange = () => undefined,
  workspaceRoots = unavailableWorkspaceRoots,
  workspaceList = unavailableWorkspaceList,
  workspaceValidate = unavailableWorkspaceValidate,
  onOpenAgentSettings = () => undefined,
}: NewAgentDialogProps) {
  const [selectedKind, setSelectedKind] = React.useState<AgentKind>();
  const [modelChoices, setModelChoices] = React.useState<RuntimeValues>({});
  const [customModels, setCustomModels] = React.useState<RuntimeValues>({});
  const [effortChoices, setEffortChoices] = React.useState<RuntimeValues>({});
  const [yolo, setYolo] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const [workingDirectories, setWorkingDirectories] = React.useState<
    Record<string, string>
  >({ local: initialCwd });
  const [choosingCwd, setChoosingCwd] = React.useState(false);
  const [changingTarget, setChangingTarget] = React.useState(false);
  const [targetError, setTargetError] = React.useState<string>();
  const [remoteWorkspaceOpen, setRemoteWorkspaceOpen] = React.useState(false);
  const [selectedTargetKey, setSelectedTargetKey] = React.useState("local");
  const targetChangeGeneration = React.useRef(0);
  const promptRef = React.useRef<HTMLTextAreaElement>(null);

  const launchTargets = targets.length > 0 ? targets : [LOCAL_TARGET];
  const selectedTarget =
    launchTargets.find(
      ({ target }) => targetKey(target) === selectedTargetKey,
    ) ??
    launchTargets[0] ??
    LOCAL_TARGET;
  const selectedTargetLabel = targetLabel(selectedTarget.target);
  const workingDirectory = workingDirectories[selectedTargetKey] ?? "";

  React.useEffect(() => {
    if (!open) return;
    setSelectedKind(undefined);
    setModelChoices({});
    setCustomModels({});
    setEffortChoices({});
    setYolo(false);
    setPrompt("");
    setWorkingDirectories({ local: initialCwd });
    setChoosingCwd(false);
    setChangingTarget(false);
    setTargetError(undefined);
    setRemoteWorkspaceOpen(false);
    setSelectedTargetKey(
      targetKey(
        launchTargets.find(({ target }) => target.kind === "local")?.target ??
          launchTargets[0]?.target ??
          LOCAL_TARGET.target,
      ),
    );
  }, [initialCwd, open]);

  React.useEffect(() => {
    if (!open) return;
    setSelectedKind((current) =>
      agents.some((agent) => agent.kind === current)
        ? current
        : (agents.find((agent) => agent.available)?.kind ?? agents[0]?.kind),
    );
    setModelChoices((current) => {
      const next = { ...current };
      for (const runtime of agents) {
        next[runtime.kind] ??= initialModel(runtime);
      }
      return next;
    });
  }, [agents, open]);

  const selectedRuntime = agents.find(
    (runtime) => runtime.kind === selectedKind,
  );
  React.useEffect(() => {
    if (open) promptRef.current?.focus();
  }, [open]);
  const modelChoice = selectedRuntime
    ? (modelChoices[selectedRuntime.kind] ?? initialModel(selectedRuntime))
    : "";
  const customModel = selectedRuntime
    ? (customModels[selectedRuntime.kind] ?? "")
    : "";
  const selectedModel =
    modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice;
  const selectedModelOption = selectedRuntime?.models.find(
    (model) => model.id === selectedModel,
  );
  const effortOptions = selectedModelOption?.efforts?.length
    ? selectedModelOption.efforts
    : (selectedRuntime?.efforts ?? []);
  const configuredEffort = selectedRuntime
    ? (effortChoices[selectedRuntime.kind] ?? "")
    : "";
  const selectedEffort = effortOptions.some(
    (effort) => effort.id === configuredEffort,
  )
    ? configuredEffort
    : "";
  const firstPrompt = prompt.trim();
  const cwd = workingDirectory.trim();
  const modelIsValid = Boolean(
    selectedRuntime &&
    (!selectedRuntime.modelRequired || selectedModel.length > 0),
  );
  const canStart = Boolean(
    selectedRuntime?.available &&
    selectedTarget.state === "connected" &&
    firstPrompt &&
    cwd &&
    modelIsValid &&
    !busy &&
    !choosingCwd &&
    !changingTarget,
  );

  function selectRuntime(kind: AgentKind): void {
    setSelectedKind(kind);
    setYolo(false);
  }

  async function selectTarget(next: AgentLaunchTarget): Promise<void> {
    const nextKey = targetKey(next.target);
    const generation = ++targetChangeGeneration.current;
    setSelectedTargetKey(nextKey);
    setWorkingDirectories((current) =>
      Object.hasOwn(current, nextKey) ? current : { ...current, [nextKey]: "" },
    );
    setYolo(false);
    setTargetError(undefined);
    setChangingTarget(true);
    try {
      await onTargetChange(next);
    } catch {
      if (generation === targetChangeGeneration.current) {
        setTargetError("The selected device could not be connected.");
      }
    } finally {
      if (generation === targetChangeGeneration.current) {
        setChangingTarget(false);
      }
    }
  }

  return (
    <React.Fragment>
      <ModalDialog
        open={open && !remoteWorkspaceOpen}
        title="New agent"
        description="Start with the task. Tune the runtime only when this session needs it."
        className="new-agent-dialog"
        onClose={onClose}
      >
        <form
          className="agent-launch-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedRuntime || !firstPrompt || !canStart) return;
            onStart(
              {
                kind: selectedRuntime.kind,
                yolo: selectedRuntime.supportsYolo ? yolo : false,
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(selectedEffort ? { effort: selectedEffort } : {}),
                prompt: firstPrompt,
              },
              cwd,
              selectedTarget.target,
            );
          }}
        >
          <div className="agent-launch-stack">
            <section
              className="agent-context-panel"
              aria-label="Task and workspace"
            >
              <label className="agent-prompt-field">
                <span>First prompt</span>
                <textarea
                  ref={promptRef}
                  autoFocus
                  required
                  aria-label="First prompt"
                  value={prompt}
                  maxLength={16_000}
                  rows={8}
                  disabled={busy}
                  placeholder="Describe the first task for this agent…"
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                />
                <small>{prompt.length.toLocaleString()} / 16,000</small>
              </label>

              <div className="agent-launch-context">
                <div className="agent-context-chips">
                  <label className="agent-target-chip">
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="2" y="2.5" width="12" height="8.5" rx="1.5" />
                      <path d="M6 13.5h4M8 11v2.5" />
                    </svg>
                    <select
                      aria-label="Device"
                      value={targetKey(selectedTarget.target)}
                      disabled={busy || launchTargets.length === 1}
                      onChange={(event) => {
                        const next = launchTargets.find(
                          ({ target }) =>
                            targetKey(target) === event.currentTarget.value,
                        );
                        if (!next) return;
                        void selectTarget(next);
                      }}
                    >
                      {launchTargets.map((launchTarget) => (
                        <option
                          value={targetKey(launchTarget.target)}
                          key={targetKey(launchTarget.target)}
                        >
                          {targetLabel(launchTarget.target)}
                          {launchTarget.state === "connected"
                            ? ""
                            : ` — ${launchTarget.state.replaceAll("_", " ")}`}
                        </option>
                      ))}
                    </select>
                    <span className="agent-chip-chevron" aria-hidden="true">
                      ⌄
                    </span>
                  </label>

                  <button
                    className="agent-workspace-chip"
                    type="button"
                    title={`${selectedTargetLabel} · ${workingDirectory}`}
                    aria-label={`Working directory on ${selectedTargetLabel}: ${workingDirectory}`}
                    disabled={
                      busy ||
                      choosingCwd ||
                      changingTarget ||
                      selectedTarget.state !== "connected"
                    }
                    onClick={() => {
                      if (selectedTarget.target.kind === "remote") {
                        setRemoteWorkspaceOpen(true);
                        return;
                      }
                      setChoosingCwd(true);
                      void onChooseCwd(cwd)
                        .then((selectedCwd) => {
                          if (selectedCwd) {
                            setWorkingDirectories((current) => ({
                              ...current,
                              [selectedTargetKey]: selectedCwd,
                            }));
                          }
                        })
                        .catch(() => undefined)
                        .finally(() => setChoosingCwd(false));
                    }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M1.75 4.25h4l1.1 1.5h7.4v6.5H1.75z" />
                    </svg>
                    <span>
                      {choosingCwd
                        ? "Choosing…"
                        : changingTarget
                          ? "Connecting…"
                          : workingDirectory
                            ? workspacePathLabel(workingDirectory)
                            : "Choose folder"}
                    </span>
                  </button>
                </div>

                <div className="agent-yolo-inline">
                  <span>YOLO</span>
                  <button
                    className="switch-control agent-yolo-switch"
                    type="button"
                    role="switch"
                    aria-label="YOLO mode"
                    aria-checked={selectedRuntime?.supportsYolo ? yolo : false}
                    data-enabled={selectedRuntime?.supportsYolo ? yolo : false}
                    disabled={busy || !selectedRuntime?.supportsYolo}
                    onClick={() => setYolo((current) => !current)}
                  >
                    <span className="switch-thumb" aria-hidden="true" />
                  </button>
                  <span className="agent-yolo-help-wrap">
                    <button
                      className="agent-yolo-help"
                      type="button"
                      aria-label="About YOLO mode"
                      data-tooltip={
                        selectedRuntime?.supportsYolo
                          ? "Skips approval prompts and removes this CLI's sandbox for the session."
                          : "The selected runtime does not support YOLO mode."
                      }
                    >
                      ?
                    </button>
                    <span className="agent-yolo-tooltip" role="tooltip">
                      {selectedRuntime?.supportsYolo
                        ? "Skips approval prompts and removes this CLI's sandbox for this session."
                        : "The selected runtime does not support YOLO mode."}
                    </span>
                  </span>
                </div>
              </div>
            </section>

            <section
              className="agent-runtime-panel"
              aria-label="Runtime configuration"
            >
              <header className="agent-runtime-header">
                <div>
                  <span>Runtime</span>
                  <h3>Run configuration</h3>
                </div>
                {selectedRuntime ? (
                  <span
                    className="agent-availability"
                    data-available={selectedRuntime.available}
                  >
                    {selectedRuntime.available ? "CLI READY" : "CLI MISSING"}
                  </span>
                ) : null}
              </header>

              <div
                className="agent-runtime-grid"
                data-has-effort={effortOptions.length > 0}
              >
                <label className="agent-runtime-field">
                  <span>Agent</span>
                  <select
                    aria-label="Agent"
                    value={selectedKind ?? ""}
                    disabled={busy || agents.length === 0}
                    onChange={(event) =>
                      selectRuntime(event.currentTarget.value as AgentKind)
                    }
                  >
                    {agents.length === 0 ? (
                      <option value="">No runtimes detected</option>
                    ) : null}
                    {agents.map((agent) => (
                      <option value={agent.kind} key={agent.kind}>
                        {agent.label}
                        {agent.available ? "" : " — Not installed"}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedRuntime ? (
                  <React.Fragment>
                    <label className="agent-model-field">
                      <span>Model</span>
                      <select
                        aria-label="Model"
                        value={modelChoice}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          const kind = selectedRuntime.kind;
                          setModelChoices((current) => ({
                            ...current,
                            [kind]: value,
                          }));
                        }}
                      >
                        {!selectedRuntime.modelRequired ? (
                          <option value="">Provider default</option>
                        ) : null}
                        {selectedRuntime.models.map((model) => (
                          <option value={model.id} key={model.id}>
                            {model.label}
                          </option>
                        ))}
                        <option value={CUSTOM_MODEL}>Custom model…</option>
                      </select>
                    </label>
                    {effortOptions.length > 0 ? (
                      <label className="agent-effort-field">
                        <span>Effort</span>
                        <select
                          aria-label="Effort"
                          value={selectedEffort}
                          disabled={busy}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            const kind = selectedRuntime.kind;
                            setEffortChoices((current) => ({
                              ...current,
                              [kind]: value,
                            }));
                          }}
                        >
                          <option value="">Provider default</option>
                          {effortOptions.map((effort) => (
                            <option value={effort.id} key={effort.id}>
                              {effort.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {modelChoice === CUSTOM_MODEL ? (
                      <label className="agent-custom-model-field">
                        <span>Custom model</span>
                        <input
                          aria-label="Custom model"
                          value={customModel}
                          maxLength={200}
                          disabled={busy}
                          placeholder="provider-model-id"
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            const kind = selectedRuntime.kind;
                            setCustomModels((current) => ({
                              ...current,
                              [kind]: value,
                            }));
                          }}
                        />
                      </label>
                    ) : null}
                  </React.Fragment>
                ) : null}
              </div>

              {selectedRuntime ? (
                <React.Fragment>
                  {!selectedRuntime.available ? (
                    <div className="agent-install-hint">
                      <div>
                        <strong>Runtime setup is in Settings</strong>
                        <p>{selectedRuntime.installHint}</p>
                      </div>
                      <button
                        type="button"
                        onClick={onOpenAgentSettings}
                        disabled={busy}
                      >
                        Open Agent settings
                      </button>
                    </div>
                  ) : null}
                </React.Fragment>
              ) : (
                <p className="agent-runtime-empty">
                  No agent runtime detected.
                </p>
              )}

              {agents.length > 0 && !agents.some((agent) => agent.available) ? (
                <p className="agent-empty-state">
                  No supported agent CLI was found.
                </p>
              ) : null}
            </section>
          </div>

          {error || targetError ? (
            <p className="dialog-error">{error ?? targetError}</p>
          ) : null}

          <footer className="agent-dialog-actions">
            <button
              className="agent-cancel-button"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="agent-start-button"
              type="submit"
              disabled={!canStart}
            >
              {busy ? "Starting…" : "Start agent"}
            </button>
          </footer>
        </form>
      </ModalDialog>
      {selectedTarget.target.kind === "remote" ? (
        <RemoteWorkspaceDialog
          open={open && remoteWorkspaceOpen}
          target={selectedTarget.target}
          currentPath={workingDirectory}
          onClose={() => setRemoteWorkspaceOpen(false)}
          onSelect={(selection) => {
            setWorkingDirectories((current) => ({
              ...current,
              [selectedTargetKey]: selection.path,
            }));
            setRemoteWorkspaceOpen(false);
            setTargetError(undefined);
          }}
          workspaceRoots={workspaceRoots}
          workspaceList={workspaceList}
          workspaceValidate={workspaceValidate}
        />
      ) : null}
    </React.Fragment>
  );
}

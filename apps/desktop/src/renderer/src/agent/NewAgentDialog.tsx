import type {
  AgentKind,
  AgentLaunchRequest,
  AgentRuntime,
} from "@codra/protocol";
import React from "react";
import { ModalDialog } from "../components/ModalDialog";

export interface NewAgentDialogProps {
  open: boolean;
  agents: readonly AgentRuntime[];
  initialCwd: string;
  busy?: boolean;
  error?: string;
  onClose(): void;
  onStart(request: AgentLaunchRequest, cwd: string): void;
  onChooseCwd(currentCwd: string): Promise<string | null>;
  onOpenAgentSettings?(): void;
}

const CUSTOM_MODEL = "__custom__";
type RuntimeValues = Partial<Record<AgentKind, string>>;

function agentGlyph(kind: AgentKind): string {
  switch (kind) {
    case "codex":
      return ">_";
    case "claude":
      return "C";
    case "gemini":
      return "G";
    case "ollama":
      return "O";
  }
}

function initialModel(runtime: AgentRuntime): string {
  if (!runtime.modelRequired) return "";
  return runtime.models[0]?.id ?? CUSTOM_MODEL;
}

export function NewAgentDialog({
  open,
  agents,
  initialCwd,
  busy = false,
  error,
  onClose,
  onStart,
  onChooseCwd,
  onOpenAgentSettings = () => undefined,
}: NewAgentDialogProps) {
  const [selectedKind, setSelectedKind] = React.useState<AgentKind>();
  const [modelChoices, setModelChoices] = React.useState<RuntimeValues>({});
  const [customModels, setCustomModels] = React.useState<RuntimeValues>({});
  const [effortChoices, setEffortChoices] = React.useState<RuntimeValues>({});
  const [yolo, setYolo] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const [workingDirectory, setWorkingDirectory] = React.useState(initialCwd);
  const [choosingCwd, setChoosingCwd] = React.useState(false);
  const promptRef = React.useRef<HTMLTextAreaElement>(null);
  const workingDirectoryId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    setSelectedKind(undefined);
    setModelChoices({});
    setCustomModels({});
    setEffortChoices({});
    setYolo(false);
    setPrompt("");
    setWorkingDirectory(initialCwd);
    setChoosingCwd(false);
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
    firstPrompt &&
    cwd &&
    modelIsValid &&
    !busy &&
    !choosingCwd,
  );

  function selectRuntime(kind: AgentKind): void {
    setSelectedKind(kind);
    setYolo(false);
  }

  return (
    <ModalDialog
      open={open}
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

            <div className="agent-workdir-field">
              <label htmlFor={workingDirectoryId}>Working directory</label>
              <span className="agent-workdir-control">
                <span className="agent-workdir-prompt" aria-hidden="true">
                  ▸
                </span>
                <input
                  id={workingDirectoryId}
                  required
                  readOnly
                  aria-label="Working directory"
                  value={workingDirectory}
                  maxLength={4096}
                  disabled={busy || choosingCwd}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="/path/to/workspace"
                />
                <button
                  type="button"
                  aria-label="Choose working directory"
                  disabled={busy || choosingCwd}
                  onClick={() => {
                    setChoosingCwd(true);
                    void onChooseCwd(cwd)
                      .then((selectedCwd) => {
                        if (selectedCwd) setWorkingDirectory(selectedCwd);
                      })
                      .catch(() => undefined)
                      .finally(() => setChoosingCwd(false));
                  }}
                >
                  {choosingCwd ? "Choosing…" : "Browse…"}
                </button>
              </span>
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
                <div className="agent-runtime-summary">
                  <span className="agent-glyph" aria-hidden="true">
                    {agentGlyph(selectedRuntime.kind)}
                  </span>
                  <p>
                    <strong>{selectedRuntime.label}</strong>
                    <span>{selectedRuntime.description}</span>
                  </p>
                </div>

                <p className="agent-model-note">
                  {selectedRuntime.kind === "ollama"
                    ? "Models come from this machine's Ollama library."
                    : "Use the provider default or pin a model for this session."}
                </p>

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

                {selectedRuntime.supportsYolo ? (
                  <React.Fragment>
                    <section
                      className="agent-yolo-row"
                      aria-label="Agent permissions"
                    >
                      <div>
                        <strong>YOLO mode</strong>
                        <p>
                          Skip approval prompts and allow unrestricted agent
                          actions.
                        </p>
                      </div>
                      <button
                        className="switch-control agent-yolo-switch"
                        type="button"
                        role="switch"
                        aria-label="YOLO mode"
                        aria-checked={yolo}
                        data-enabled={yolo}
                        disabled={busy}
                        onClick={() => setYolo((current) => !current)}
                      >
                        <span className="switch-thumb" aria-hidden="true" />
                      </button>
                    </section>
                    {yolo ? (
                      <p className="agent-yolo-warning">
                        YOLO removes the selected CLI's sandbox and confirmation
                        gates.
                      </p>
                    ) : null}
                  </React.Fragment>
                ) : (
                  <p className="agent-permission-note">
                    This runtime does not expose agent approval controls.
                  </p>
                )}
              </React.Fragment>
            ) : (
              <p className="agent-runtime-empty">No agent runtime detected.</p>
            )}

            {agents.length > 0 && !agents.some((agent) => agent.available) ? (
              <p className="agent-empty-state">
                No supported agent CLI was found.
              </p>
            ) : null}
          </section>
        </div>

        {error ? <p className="dialog-error">{error}</p> : null}

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
  );
}

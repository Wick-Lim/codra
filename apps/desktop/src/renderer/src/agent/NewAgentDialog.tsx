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
  onOpenAgentSettings = () => undefined,
}: NewAgentDialogProps) {
  const [selectedKind, setSelectedKind] = React.useState<AgentKind>();
  const [query, setQuery] = React.useState("");
  const [modelChoices, setModelChoices] = React.useState<RuntimeValues>({});
  const [customModels, setCustomModels] = React.useState<RuntimeValues>({});
  const [effortChoices, setEffortChoices] = React.useState<RuntimeValues>({});
  const [yolo, setYolo] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const [workingDirectory, setWorkingDirectory] = React.useState(initialCwd);
  const promptRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setSelectedKind(undefined);
    setQuery("");
    setModelChoices({});
    setCustomModels({});
    setEffortChoices({});
    setYolo(false);
    setPrompt("");
    setWorkingDirectory(initialCwd);
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

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAgents = agents.filter((agent) => {
    if (!normalizedQuery) return true;
    return `${agent.label} ${agent.kind} ${agent.description}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  const selectedRuntime = agents.find(
    (runtime) => runtime.kind === selectedKind,
  );
  React.useEffect(() => {
    if (open && selectedRuntime) promptRef.current?.focus();
  }, [open, selectedRuntime]);
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
    selectedRuntime?.available && firstPrompt && cwd && modelIsValid && !busy,
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
        <div className="agent-catalog-layout">
          <aside className="agent-catalog-panel" aria-label="Agent catalog">
            <label className="agent-search-field">
              <span className="agent-search-label">Search agents</span>
              <span className="agent-search-icon" aria-hidden="true">
                /
              </span>
              <input
                type="search"
                aria-label="Search agents"
                value={query}
                placeholder="Filter runtimes"
                disabled={busy}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>

            <fieldset className="agent-picker">
              <legend>Agent runtime</legend>
              <div className="agent-runtime-list">
                {visibleAgents.map((agent) => (
                  <label
                    className="agent-option"
                    data-selected={selectedKind === agent.kind}
                    data-available={agent.available}
                    key={agent.kind}
                  >
                    <input
                      type="radio"
                      name="agent-kind"
                      value={agent.kind}
                      checked={selectedKind === agent.kind}
                      disabled={busy}
                      onChange={() => selectRuntime(agent.kind)}
                    />
                    <span className="agent-glyph" aria-hidden="true">
                      {agentGlyph(agent.kind)}
                    </span>
                    <span className="agent-option-copy">
                      <strong>{agent.label}</strong>
                      <small>
                        {agent.available ? "Ready" : "Not installed"}
                      </small>
                    </span>
                    <span className="agent-radio-mark" aria-hidden="true" />
                  </label>
                ))}
              </div>
            </fieldset>

            {visibleAgents.length === 0 ? (
              <p className="agent-catalog-empty">No matching runtimes.</p>
            ) : null}
            {!agents.some((agent) => agent.available) ? (
              <p className="agent-empty-state">
                No supported agent CLI was found.
              </p>
            ) : null}
          </aside>

          <section className="agent-config-panel" aria-label="Agent launch">
            {selectedRuntime ? (
              <React.Fragment>
                <header className="agent-config-header">
                  <div className="agent-config-identity">
                    <span
                      className="agent-glyph agent-config-glyph"
                      aria-hidden="true"
                    >
                      {agentGlyph(selectedRuntime.kind)}
                    </span>
                    <div>
                      <span className="agent-config-kicker">
                        {selectedRuntime.kind}
                      </span>
                      <h3>{selectedRuntime.label}</h3>
                    </div>
                  </div>
                  <span
                    className="agent-availability"
                    data-available={selectedRuntime.available}
                  >
                    {selectedRuntime.available ? "CLI READY" : "CLI MISSING"}
                  </span>
                </header>
                <p className="agent-description">
                  {selectedRuntime.description}
                </p>

                <label className="agent-prompt-field">
                  <span>First prompt</span>
                  <textarea
                    ref={promptRef}
                    autoFocus
                    required
                    aria-label="First prompt"
                    value={prompt}
                    maxLength={16_000}
                    rows={7}
                    disabled={busy}
                    placeholder="Describe the first task for this agent…"
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                  />
                  <small>{prompt.length.toLocaleString()} / 16,000</small>
                </label>

                <label className="agent-workdir-field">
                  <span>Working directory</span>
                  <span className="agent-workdir-control">
                    <span className="agent-workdir-prompt" aria-hidden="true">
                      ▸
                    </span>
                    <input
                      required
                      aria-label="Working directory"
                      value={workingDirectory}
                      maxLength={4096}
                      disabled={busy}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="/path/to/workspace"
                      onChange={(event) =>
                        setWorkingDirectory(event.currentTarget.value)
                      }
                    />
                  </span>
                </label>

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

                <p className="agent-run-configuration-label">
                  Run configuration
                </p>
                <div
                  className="agent-model-stack"
                  data-has-effort={effortOptions.length > 0}
                >
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
                  <p className="agent-model-note">
                    {selectedRuntime.kind === "ollama"
                      ? "Models discovered from this machine's Ollama library."
                      : "Use the provider default or pin a model for this session."}
                  </p>
                </div>

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
              <p className="agent-catalog-empty">No agent runtime detected.</p>
            )}
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

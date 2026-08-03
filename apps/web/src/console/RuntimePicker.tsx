import { useMemo, useState, type ReactElement } from "react";
import {
  AgentLaunchRequestSchema,
  type AgentKind,
  type AgentLaunchRequest,
  type AgentRuntime,
} from "@codra/protocol";
import { t } from "../i18n/messages";

const copy = t.console.runtime;

/** `AgentLaunchRequestSchema`'s own bound, mirrored onto the textarea. */
const PROMPT_MAX_LENGTH = 16_000;

export interface RuntimePickerProps {
  runtimes: readonly AgentRuntime[];
  busy?: boolean;
  onLaunch(request: AgentLaunchRequest): void;
}

/**
 * Step 5 of the console flow: `agent.runtimes` fills this picker, and what
 * leaves it is the `agent` half of `agent.launch`.
 *
 * The picker's job is to never assemble a request the host will refuse.
 * `host-control-gateway.ts:414-448` answers `RUNTIME_UNAVAILABLE` when the
 * runtime is unavailable, when `yolo` is requested where `supportsYolo` is
 * false, or when `modelRequired` is set and no model came with the request — so
 * each of those three is a control-level constraint here: an unavailable
 * runtime's `<option>` is disabled, the yolo checkbox is disabled unless the
 * selected runtime supports it, and launch stays disabled until a required
 * model is chosen.
 *
 * `AgentLaunchRequestSchema` is then the last gate before `onLaunch`, and it is
 * deliberately the *same* schema the host parses with. It carries two
 * cross-field refinements no per-field UI rule can express — Ollama must have a
 * model and must not have `yolo` (`packages/protocol/src/terminal.ts:169-193`) —
 * so a host that mis-reported `supportsYolo` for Ollama still cannot get a
 * request past this component.
 */
export function RuntimePicker({
  runtimes,
  busy = false,
  onLaunch,
}: RuntimePickerProps): ReactElement {
  const firstSelectable = useMemo(
    () => runtimes.find((entry) => entry.available) ?? runtimes[0],
    [runtimes],
  );
  const [kind, setKind] = useState<AgentKind | undefined>(
    firstSelectable?.kind,
  );
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [yolo, setYolo] = useState(false);
  const [prompt, setPrompt] = useState("");

  const selected =
    runtimes.find((entry) => entry.kind === kind) ?? firstSelectable;
  const modelOption = selected?.models.find((entry) => entry.id === model);
  const effortOptions = modelOption?.efforts?.length
    ? modelOption.efforts
    : (selected?.efforts ?? []);
  const effortChoice = effortOptions.some((entry) => entry.id === effort)
    ? effort
    : "";

  const candidate = selected
    ? {
        kind: selected.kind,
        // A disabled checkbox can still hold a stale `true` from the runtime
        // that was selected before this one, so the runtime's own capability —
        // not the checkbox — decides what is sent.
        yolo: selected.supportsYolo ? yolo : false,
        ...(model ? { model } : {}),
        ...(effortChoice ? { effort: effortChoice } : {}),
        prompt: prompt.trim(),
      }
    : undefined;
  const parsed = candidate
    ? AgentLaunchRequestSchema.safeParse(candidate)
    : undefined;
  const modelMissing = Boolean(selected?.modelRequired) && !model;
  const canLaunch = Boolean(
    !busy && selected?.available && parsed?.success && !modelMissing,
  );

  function selectRuntime(next: AgentKind): void {
    setKind(next);
    // Every choice below the runtime is scoped to that runtime: a model id is
    // meaningless across providers, and an effort id only exists inside one
    // runtime's catalogue. Carrying either across a switch is how a request
    // that the host refuses gets assembled.
    setModel("");
    setEffort("");
    setYolo(false);
  }

  if (runtimes.length === 0 || !selected) {
    return (
      <section className="picker-panel" aria-label={copy.title}>
        <div className="panel-heading">
          <div>
            <p className="card-kicker">{copy.kicker}</p>
            <h3>{copy.title}</h3>
          </div>
        </div>
        <p className="empty">{copy.empty}</p>
      </section>
    );
  }

  return (
    <section className="picker-panel" aria-label={copy.title}>
      <div className="panel-heading">
        <div>
          <p className="card-kicker">{copy.kicker}</p>
          <h3>{copy.title}</h3>
        </div>
      </div>
      <p className="muted picker-lead">{copy.lead}</p>

      <form
        className="runtime-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canLaunch || !parsed?.success) return;
          onLaunch(parsed.data);
        }}
      >
        <label className="field">
          <span>{copy.runtimeLabel}</span>
          <select
            value={selected.kind}
            disabled={busy}
            onChange={(event) =>
              selectRuntime(event.currentTarget.value as AgentKind)
            }
          >
            {runtimes.map((entry) => (
              <option
                key={entry.kind}
                value={entry.kind}
                disabled={!entry.available}
              >
                {entry.available
                  ? entry.label
                  : `${entry.label} — ${copy.unavailable}`}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{copy.modelLabel}</span>
          <select
            value={model}
            disabled={busy || selected.models.length === 0}
            onChange={(event) => {
              setModel(event.currentTarget.value);
              setEffort("");
            }}
          >
            <option value="">
              {selected.modelRequired
                ? copy.modelPlaceholder
                : copy.runtimeDefault}
            </option>
            {selected.models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{copy.effortLabel}</span>
          <select
            value={effortChoice}
            disabled={busy || effortOptions.length === 0}
            onChange={(event) => setEffort(event.currentTarget.value)}
          >
            <option value="">{copy.runtimeDefault}</option>
            {effortOptions.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field field-inline">
          <input
            type="checkbox"
            checked={selected.supportsYolo && yolo}
            disabled={busy || !selected.supportsYolo}
            onChange={(event) => setYolo(event.currentTarget.checked)}
          />
          <span>{copy.yoloLabel}</span>
        </label>
        {selected.supportsYolo ? null : (
          <p className="field-hint">{copy.yoloUnsupported}</p>
        )}

        <label className="field field-wide">
          <span>{copy.promptLabel}</span>
          <textarea
            value={prompt}
            rows={6}
            maxLength={PROMPT_MAX_LENGTH}
            placeholder={copy.promptPlaceholder}
            disabled={busy}
            onChange={(event) => setPrompt(event.currentTarget.value)}
          />
        </label>
        {/* Outside the `<label>`: text inside one becomes part of the
            accessible name, and a name that carries a live character count
            is a name that changes on every keystroke. */}
        <small className="field-hint">
          {copy.promptCounter(prompt.length, PROMPT_MAX_LENGTH)}
        </small>

        {modelMissing ? (
          <p className="field-hint">{copy.modelMissing}</p>
        ) : null}
        {!modelMissing && prompt.trim() && parsed && !parsed.success ? (
          <p className="message" role="alert">
            {copy.rejected}
          </p>
        ) : null}

        <footer className="picker-actions">
          <button
            className="primary-button"
            type="submit"
            disabled={!canLaunch}
          >
            {busy ? copy.launching : copy.launch}
          </button>
        </footer>
      </form>
    </section>
  );
}

export default RuntimePicker;

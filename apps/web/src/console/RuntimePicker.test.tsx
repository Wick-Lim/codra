// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLaunchRequestSchema, type AgentRuntime } from "@codra/protocol";
import { RuntimePicker } from "./RuntimePicker";
import { t } from "../i18n/messages";

afterEach(cleanup);

const copy = t.console.runtime;

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    kind: "claude",
    label: "Claude Code",
    description: "Anthropic's coding agent.",
    available: true,
    supportsYolo: true,
    modelRequired: false,
    efforts: [],
    models: [],
    installHint: "Install the Claude CLI.",
    setup: { installMethod: "managed_npm", authentication: "required" },
    ...overrides,
  };
}

const claude = runtime({
  efforts: [{ id: "high", label: "High" }],
});
const ollama = runtime({
  kind: "ollama",
  label: "Ollama",
  description: "Local models through Ollama.",
  // Exactly what `AgentLaunchRequestSchema`'s cross-field refinements demand of
  // this runtime, and what the host reports for it.
  supportsYolo: false,
  modelRequired: true,
  models: [{ id: "llama3.1", label: "Llama 3.1" }],
  setup: { installMethod: "external", authentication: "not_required" },
});
const gemini = runtime({
  kind: "gemini",
  label: "Gemini CLI",
  description: "Google's coding agent.",
  available: false,
  setup: { installMethod: "managed_npm", authentication: "required" },
});

function harness(runtimes: readonly AgentRuntime[]) {
  const onLaunch = vi.fn();
  render(<RuntimePicker runtimes={runtimes} onLaunch={onLaunch} />);
  return { onLaunch };
}

function launchButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: copy.launch }) as HTMLButtonElement;
}

describe("RuntimePicker", () => {
  it("lists a runtime the host cannot start but refuses to select it", async () => {
    harness([claude, gemini]);

    const unavailable = screen.getByRole("option", {
      name: `${gemini.label} — ${copy.unavailable}`,
    }) as HTMLOptionElement;
    expect(unavailable.disabled).toBe(true);
    // The first *available* runtime is what a fresh picker starts on.
    expect(
      (screen.getByLabelText(copy.runtimeLabel) as HTMLSelectElement).value,
    ).toBe(claude.kind);
  });

  it("starts on the first available runtime even when it is not the first", () => {
    harness([gemini, claude]);

    expect(
      (screen.getByLabelText(copy.runtimeLabel) as HTMLSelectElement).value,
    ).toBe(claude.kind);
  });

  it("will not launch without a prompt", async () => {
    harness([claude]);

    expect(launchButton().disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(copy.promptLabel), "ship it");
    expect(launchButton().disabled).toBe(false);
  });

  it("bounds the prompt at the schema's 16,000 characters", () => {
    harness([claude]);

    expect(
      (screen.getByLabelText(copy.promptLabel) as HTMLTextAreaElement)
        .maxLength,
    ).toBe(16_000);
  });

  it("holds a modelRequired runtime until a model is chosen", async () => {
    const { onLaunch } = harness([ollama]);

    await userEvent.type(screen.getByLabelText(copy.promptLabel), "ship it");
    expect(launchButton().disabled).toBe(true);
    expect(screen.getByText(copy.modelMissing)).toBeTruthy();

    await userEvent.selectOptions(
      screen.getByLabelText(copy.modelLabel),
      "llama3.1",
    );
    expect(launchButton().disabled).toBe(false);

    await userEvent.click(launchButton());
    expect(onLaunch).toHaveBeenCalledWith({
      kind: "ollama",
      yolo: false,
      model: "llama3.1",
      prompt: "ship it",
    });
  });

  it("never offers yolo on a runtime the host would refuse it for", async () => {
    const { onLaunch } = harness([ollama]);

    const skipApprovals = screen.getByLabelText(
      copy.yoloLabel,
    ) as HTMLInputElement;
    expect(skipApprovals.disabled).toBe(true);
    expect(skipApprovals.checked).toBe(false);

    await userEvent.type(screen.getByLabelText(copy.promptLabel), "ship it");
    await userEvent.selectOptions(
      screen.getByLabelText(copy.modelLabel),
      "llama3.1",
    );
    await userEvent.click(launchButton());

    expect(onLaunch.mock.calls[0]?.[0]).toMatchObject({ yolo: false });
  });

  it("carries yolo and effort where the runtime supports them", async () => {
    const { onLaunch } = harness([claude]);

    await userEvent.type(screen.getByLabelText(copy.promptLabel), "ship it");
    await userEvent.click(screen.getByLabelText(copy.yoloLabel));
    await userEvent.selectOptions(screen.getByLabelText(copy.effortLabel), [
      "high",
    ]);
    await userEvent.click(launchButton());

    expect(onLaunch).toHaveBeenCalledWith({
      kind: "claude",
      yolo: true,
      effort: "high",
      prompt: "ship it",
    });
  });

  it("clears a yolo choice that the next runtime cannot honour", async () => {
    const { onLaunch } = harness([claude, ollama]);

    await userEvent.type(screen.getByLabelText(copy.promptLabel), "ship it");
    await userEvent.click(screen.getByLabelText(copy.yoloLabel));
    await userEvent.selectOptions(
      screen.getByLabelText(copy.runtimeLabel),
      "ollama",
    );
    await userEvent.selectOptions(
      screen.getByLabelText(copy.modelLabel),
      "llama3.1",
    );
    await userEvent.click(launchButton());

    expect(onLaunch.mock.calls[0]?.[0]).toMatchObject({
      kind: "ollama",
      yolo: false,
    });
  });

  it("only ever emits a request the launch schema accepts", async () => {
    const { onLaunch } = harness([claude, ollama, gemini]);

    await userEvent.type(screen.getByLabelText(copy.promptLabel), "ship it");
    await userEvent.click(launchButton());

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(
      AgentLaunchRequestSchema.safeParse(onLaunch.mock.calls[0]?.[0]).success,
    ).toBe(true);
  });

  it("says so when the host reports no runtimes at all", () => {
    harness([]);

    expect(screen.getByText(copy.empty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.launch })).toBeNull();
  });
});

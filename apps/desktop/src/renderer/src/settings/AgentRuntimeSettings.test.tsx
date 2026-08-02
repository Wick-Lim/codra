import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentKind, AgentRuntime } from "@codra/protocol";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeSettings } from "./AgentRuntimeSettings";

void React;

function runtime(
  kind: AgentKind,
  available: boolean,
  setup: AgentRuntime["setup"],
): AgentRuntime {
  const labels: Record<AgentKind, string> = {
    codex: "Codex CLI",
    claude: "Claude Code",
    gemini: "Gemini CLI",
    ollama: "Ollama",
  };
  return {
    kind,
    label: labels[kind],
    description: `${labels[kind]} runtime`,
    available,
    supportsYolo: kind !== "ollama",
    modelRequired: kind === "ollama",
    efforts: [],
    models: [],
    installHint: `Install ${labels[kind]}`,
    setup,
  };
}

const managedSetup: AgentRuntime["setup"] = {
  installMethod: "managed_npm",
  authentication: "required",
};
const externalSetup: AgentRuntime["setup"] = {
  installMethod: "external",
  authentication: "not_required",
};

describe("AgentRuntimeSettings", () => {
  it("offers one status-aware action per runtime without exposing package inputs", async () => {
    const onSetup = vi.fn();
    render(
      <AgentRuntimeSettings
        runtimes={[
          runtime("codex", true, managedSetup),
          runtime("claude", true, managedSetup),
          runtime("gemini", false, managedSetup),
          runtime("ollama", false, externalSetup),
        ]}
        onSetup={onSetup}
      />,
    );

    expect(screen.getAllByText("CLI ready")).toHaveLength(2);
    expect(screen.getAllByText("Not installed")).toHaveLength(2);
    expect(
      screen.queryByRole("textbox", { name: /package|command|token/i }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Install and sign in to Gemini CLI",
      }),
    );
    expect(onSetup).toHaveBeenLastCalledWith({
      kind: "gemini",
      action: "install",
    });

    await userEvent.click(
      screen.getByRole("button", {
        name: "Sign in or switch Claude Code account",
      }),
    );
    expect(onSetup).toHaveBeenLastCalledWith({
      kind: "claude",
      action: "authenticate",
    });

    await userEvent.click(screen.getByRole("button", { name: "Get Ollama" }));
    expect(onSetup).toHaveBeenLastCalledWith({
      kind: "ollama",
      action: "install",
    });
  });

  it("marks setup as busy and explains ready local runtimes", () => {
    render(
      <AgentRuntimeSettings
        runtimes={[
          runtime("gemini", false, managedSetup),
          runtime("ollama", true, externalSetup),
        ]}
        setupKind="gemini"
        onSetup={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Setting up Gemini CLI" }),
    ).toBeDisabled();
    expect(screen.getByText("No sign-in required")).toBeVisible();
  });
});

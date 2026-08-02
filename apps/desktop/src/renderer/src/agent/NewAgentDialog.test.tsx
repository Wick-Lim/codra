import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@codra/protocol";
import { NewAgentDialog } from "./NewAgentDialog";

void React;

const agents: AgentRuntime[] = [
  {
    kind: "codex",
    label: "Codex CLI",
    description: "OpenAI's coding agent for repository work.",
    available: true,
    supportsYolo: true,
    modelRequired: false,
    efforts: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    models: [
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        efforts: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
    installHint: "Install Codex CLI to use this runtime.",
    setup: {
      installMethod: "managed_npm",
      authentication: "required",
    },
  },
  {
    kind: "claude",
    label: "Claude Code",
    description: "Anthropic's agentic coding CLI.",
    available: true,
    supportsYolo: true,
    modelRequired: false,
    efforts: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    models: [{ id: "sonnet", label: "Sonnet" }],
    installHint: "Install Claude Code to use this runtime.",
    setup: {
      installMethod: "managed_npm",
      authentication: "required",
    },
  },
  {
    kind: "gemini",
    label: "Gemini CLI",
    description: "Google's open-source terminal coding agent.",
    available: false,
    supportsYolo: true,
    modelRequired: false,
    efforts: [],
    models: [
      { id: "auto", label: "Auto" },
      { id: "pro", label: "Pro" },
    ],
    installHint: "Install @google/gemini-cli to use this runtime.",
    setup: {
      installMethod: "managed_npm",
      authentication: "required",
    },
  },
  {
    kind: "ollama",
    label: "Ollama",
    description: "Run a local model through Ollama.",
    available: true,
    supportsYolo: false,
    modelRequired: true,
    efforts: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    models: [
      { id: "gemma4:e4b", label: "gemma4:e4b" },
      { id: "qwen3-coder:latest", label: "qwen3-coder:latest" },
    ],
    installHint: "Install Ollama and pull a model to use this runtime.",
    setup: {
      installMethod: "external",
      authentication: "not_required",
    },
  },
];

const cancelCwdSelection = async (): Promise<null> => null;

describe("NewAgentDialog", () => {
  it("keeps the prompt dominant with compact target, workspace, and YOLO controls directly below", async () => {
    render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={vi.fn()}
        onChooseCwd={cancelCwdSelection}
        onOpenAgentSettings={vi.fn()}
      />,
    );

    const prompt = await screen.findByRole("textbox", {
      name: "First prompt",
    });
    const device = screen.getByRole("combobox", { name: "Device" });
    const workspace = screen.getByRole("button", {
      name: "Working directory on This Mac: /workspace/codra",
    });
    const yolo = screen.getByRole("switch", { name: "YOLO mode" });
    const yoloHelp = screen.getByRole("button", { name: "About YOLO mode" });
    const agent = screen.getByRole("combobox", { name: "Agent" });
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(device).toHaveValue("local");
    expect(workspace).toHaveTextContent("codra");
    expect(workspace).toHaveAttribute("title", "This Mac · /workspace/codra");
    expect(
      screen
        .getByRole("region", { name: "Task and workspace" })
        .contains(prompt),
    ).toBe(true);
    expect(
      screen
        .getByRole("region", { name: "Runtime configuration" })
        .contains(agent),
    ).toBe(true);
    await vi.waitFor(() => expect(prompt).toHaveFocus());
    expect(prompt).toBeRequired();
    expect(
      prompt.compareDocumentPosition(device) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      device.compareDocumentPosition(workspace) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      workspace.compareDocumentPosition(yolo) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      yolo.compareDocumentPosition(yoloHelp) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      yoloHelp.compareDocumentPosition(agent) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      agent.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(
      screen.queryByRole("textbox", { name: "Working directory" }),
    ).toBeNull();
    expect(
      screen.queryByText(/Skip approval prompts and allow unrestricted/u),
    ).toBeNull();
  });

  it("routes a missing runtime to settings without starting setup or an agent", async () => {
    const onStart = vi.fn();
    const onOpenAgentSettings = vi.fn();
    render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={onStart}
        onChooseCwd={cancelCwdSelection}
        onOpenAgentSettings={onOpenAgentSettings}
      />,
    );

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Agent" }),
      "gemini",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open Agent settings" }),
    );

    expect(onOpenAgentSettings).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("submits the selected agent, YOLO choice, and trimmed first prompt", async () => {
    const onStart = vi.fn();
    const onChooseCwd = vi.fn().mockResolvedValue("/workspace/auth");
    render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={onStart}
        onChooseCwd={onChooseCwd}
      />,
    );

    expect(screen.getByRole("dialog", { name: "New agent" })).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Working directory on This Mac: /workspace/codra",
      }),
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Agent" }),
      "claude",
    );
    expect(
      screen.getByRole("button", {
        name: "Working directory on This Mac: /workspace/auth",
      }),
    ).toHaveTextContent("auth");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "sonnet",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Effort" }),
      "high",
    );
    await userEvent.click(screen.getByRole("switch", { name: "YOLO mode" }));
    expect(onChooseCwd).toHaveBeenCalledWith("/workspace/codra");
    await userEvent.type(
      screen.getByRole("textbox", { name: "First prompt" }),
      "  Fix the auth callback  ",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(onStart).toHaveBeenCalledWith(
      {
        kind: "claude",
        yolo: true,
        model: "sonnet",
        effort: "high",
        prompt: "Fix the auth callback",
      },
      "/workspace/auth",
    );
  });

  it("keeps the current working directory when native selection is canceled", async () => {
    const onChooseCwd = vi.fn().mockResolvedValue(null);
    render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={vi.fn()}
        onChooseCwd={onChooseCwd}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Working directory on This Mac: /workspace/codra",
      }),
    );

    expect(onChooseCwd).toHaveBeenCalledWith("/workspace/codra");
    expect(
      screen.getByRole("button", {
        name: "Working directory on This Mac: /workspace/codra",
      }),
    ).toHaveTextContent("codra");
  });

  it("uses a compact scalable selector and exposes unavailable runtime guidance", async () => {
    const { rerender } = render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={vi.fn()}
        onChooseCwd={cancelCwdSelection}
      />,
    );

    const agent = screen.getByRole("combobox", { name: "Agent" });
    expect(agent).toBeVisible();
    expect(screen.getAllByRole("option")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "codex" }),
        expect.objectContaining({ value: "claude" }),
        expect.objectContaining({ value: "gemini" }),
        expect.objectContaining({ value: "ollama" }),
      ]),
    );
    await userEvent.selectOptions(agent, "gemini");
    expect(
      screen.getByText("Install @google/gemini-cli to use this runtime."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Start agent" })).toBeDisabled();

    rerender(
      <NewAgentDialog
        open
        agents={agents.map((agent) => ({ ...agent, available: false }))}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={vi.fn()}
        onChooseCwd={cancelCwdSelection}
      />,
    );
    expect(screen.getByText("No supported agent CLI was found.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start agent" })).toBeDisabled();
  });

  it("requires and submits an Ollama model with unsupported YOLO disabled", async () => {
    const onStart = vi.fn();
    render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={onStart}
        onChooseCwd={cancelCwdSelection}
      />,
    );

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Agent" }),
      "ollama",
    );
    expect(screen.getByRole("switch", { name: "YOLO mode" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "About YOLO mode" }),
    ).toHaveAttribute(
      "data-tooltip",
      expect.stringContaining("does not support"),
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "qwen3-coder:latest",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Effort" }),
      "high",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "First prompt" }),
      "Review this workspace",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(onStart).toHaveBeenCalledWith(
      {
        kind: "ollama",
        yolo: false,
        model: "qwen3-coder:latest",
        effort: "high",
        prompt: "Review this workspace",
      },
      "/workspace/codra",
    );
  });

  it("allows a custom model for providers whose catalog may change", async () => {
    const onStart = vi.fn();
    render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={onStart}
        onChooseCwd={cancelCwdSelection}
      />,
    );

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "__custom__",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Custom model" }),
      "future-codex-model",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "First prompt" }),
      "Inspect this repository",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(onStart).toHaveBeenCalledWith(
      {
        kind: "codex",
        yolo: false,
        model: "future-codex-model",
        prompt: "Inspect this repository",
      },
      "/workspace/codra",
    );
  });

  it("hides effort when the selected provider has no supported mapping", async () => {
    render(
      <NewAgentDialog
        open
        agents={agents.map((agent) =>
          agent.kind === "gemini" ? { ...agent, available: true } : agent,
        )}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={vi.fn()}
        onChooseCwd={cancelCwdSelection}
      />,
    );

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Agent" }),
      "gemini",
    );
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
  });

  it("keeps task and workspace available when no runtime is detected", async () => {
    render(
      <NewAgentDialog
        open
        agents={[]}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={vi.fn()}
        onChooseCwd={cancelCwdSelection}
      />,
    );

    expect(
      await screen.findByRole("textbox", { name: "First prompt" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Working directory on This Mac: /workspace/codra",
      }),
    ).toHaveTextContent("codra");
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeDisabled();
    expect(screen.getByText("No agent runtime detected.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start agent" })).toBeDisabled();
  });

  it("shows only the final folder name for Windows workspaces", async () => {
    render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="C:\\workspace\\codra\\"
        onClose={vi.fn()}
        onStart={vi.fn()}
        onChooseCwd={cancelCwdSelection}
      />,
    );

    const workspace = screen.getByRole("button", {
      name: /Working directory on This Mac/u,
    });
    expect(workspace).toHaveTextContent("codra");
    expect(workspace.getAttribute("title")).toContain("C:");
    expect(workspace.getAttribute("title")).toContain("codra");
  });

  it("requires a first prompt before starting", async () => {
    render(
      <NewAgentDialog
        open
        agents={agents}
        initialCwd="/workspace/codra"
        onClose={vi.fn()}
        onStart={vi.fn()}
        onChooseCwd={cancelCwdSelection}
      />,
    );

    expect(screen.getByRole("button", { name: "Start agent" })).toBeDisabled();
    await userEvent.type(
      screen.getByRole("textbox", { name: "First prompt" }),
      "Inspect this repository",
    );
    expect(screen.getByRole("button", { name: "Start agent" })).toBeEnabled();
  });
});

import { describe, expect, it } from "vitest";
import {
  AgentKindSchema,
  AgentLaunchRequestSchema,
  AgentRuntimeSchema,
  AgentSetupRequestSchema,
  CreateTerminalRequestSchema,
  ResizeTerminalRequestSchema,
  WriteTerminalRequestSchema,
} from "../src/terminal";

describe("terminal protocol", () => {
  it("accepts a bounded terminal creation request", () => {
    expect(CreateTerminalRequestSchema.parse({ cols: 120, rows: 32 })).toEqual({
      cols: 120,
      rows: 32,
    });
  });

  it("accepts a bounded interactive agent launch without shell text", () => {
    const launch = {
      kind: "codex",
      yolo: true,
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "Inspect the failing tests and fix the root cause.",
    } as const;

    expect(AgentKindSchema.options).toEqual([
      "codex",
      "claude",
      "gemini",
      "ollama",
    ]);
    expect(AgentLaunchRequestSchema.parse(launch)).toEqual(launch);
    expect(
      CreateTerminalRequestSchema.parse({
        cols: 120,
        rows: 32,
        agent: launch,
      }),
    ).toEqual({ cols: 120, rows: 32, agent: launch });
    expect(
      AgentRuntimeSchema.parse({
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
        models: [
          {
            id: "sonnet",
            label: "Sonnet",
            efforts: [{ id: "high", label: "High" }],
          },
        ],
        installHint: "Install Claude Code to use this runtime.",
        setup: {
          installMethod: "managed_npm",
          authentication: "required",
        },
      }),
    ).toEqual({
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
      models: [
        {
          id: "sonnet",
          label: "Sonnet",
          efforts: [{ id: "high", label: "High" }],
        },
      ],
      installHint: "Install Claude Code to use this runtime.",
      setup: {
        installMethod: "managed_npm",
        authentication: "required",
      },
    });
  });

  it("accepts only fixed runtime setup actions and exclusive terminal modes", () => {
    const install = { kind: "codex", action: "install" } as const;
    const authenticate = {
      kind: "gemini",
      action: "authenticate",
    } as const;

    expect(AgentSetupRequestSchema.parse(install)).toEqual(install);
    expect(AgentSetupRequestSchema.parse(authenticate)).toEqual(authenticate);
    expect(
      CreateTerminalRequestSchema.parse({
        cols: 100,
        rows: 30,
        agentSetup: install,
      }),
    ).toEqual({ cols: 100, rows: 30, agentSetup: install });
    expect(() =>
      AgentSetupRequestSchema.parse({
        kind: "codex",
        action: "install",
        package: "attacker-controlled-package",
      }),
    ).toThrow();
    expect(() =>
      AgentSetupRequestSchema.parse({
        kind: "ollama",
        action: "authenticate",
      }),
    ).toThrow();
    expect(() =>
      CreateTerminalRequestSchema.parse({
        cols: 100,
        rows: 30,
        agent: {
          kind: "codex",
          yolo: false,
          prompt: "Review this workspace",
        },
        agentSetup: install,
      }),
    ).toThrow();
  });

  it("rejects unknown agents, blank prompts, and oversized initial prompts", () => {
    expect(() =>
      AgentLaunchRequestSchema.parse({
        kind: "unknown",
        yolo: false,
        prompt: "Fix it",
      }),
    ).toThrow();
    expect(() =>
      AgentLaunchRequestSchema.parse({
        kind: "codex",
        yolo: false,
        prompt: "   ",
      }),
    ).toThrow();
    expect(() =>
      AgentLaunchRequestSchema.parse({
        kind: "claude",
        yolo: false,
        prompt: "x".repeat(16_001),
      }),
    ).toThrow();
    expect(() =>
      AgentLaunchRequestSchema.parse({
        kind: "ollama",
        yolo: false,
        prompt: "Fix it",
      }),
    ).toThrow();
    expect(() =>
      AgentLaunchRequestSchema.parse({
        kind: "ollama",
        yolo: true,
        model: "gemma4:e4b",
        prompt: "Fix it",
      }),
    ).toThrow();
    expect(() =>
      AgentLaunchRequestSchema.parse({
        kind: "gemini",
        yolo: false,
        model: "--help",
        prompt: "Fix it",
      }),
    ).toThrow();
    expect(() =>
      AgentLaunchRequestSchema.parse({
        kind: "codex",
        yolo: false,
        effort: "--high",
        prompt: "Fix it",
      }),
    ).toThrow();
  });

  it("rejects unsafe resize and oversized input", () => {
    expect(() =>
      ResizeTerminalRequestSchema.parse({
        terminalId: crypto.randomUUID(),
        cols: 2,
        rows: 2,
      }),
    ).toThrow();
    expect(() =>
      WriteTerminalRequestSchema.parse({
        terminalId: crypto.randomUUID(),
        data: "x".repeat(65_537),
      }),
    ).toThrow();
  });
});

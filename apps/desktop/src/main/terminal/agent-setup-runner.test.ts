import { describe, expect, it, vi } from "vitest";
import {
  runAgentSetup,
  type AgentSetupRunnerCommand,
  type AgentSetupRunnerDependencies,
} from "./agent-setup-runner";

function dependencies(options?: {
  exitCodes?: readonly number[];
  nodeScript?: boolean;
}): AgentSetupRunnerDependencies & {
  commands: AgentSetupRunnerCommand[];
} {
  const commands: AgentSetupRunnerCommand[] = [];
  const exitCodes = [...(options?.exitCodes ?? [0, 0])];
  return {
    electronExecutable: "/Applications/CODRA.app/Contents/MacOS/CODRA",
    commands,
    isNodeScript: vi.fn(() => options?.nodeScript ?? true),
    run: vi.fn(async (command) => {
      commands.push(command);
      return exitCodes.shift() ?? 0;
    }),
  };
}

describe("runAgentSetup", () => {
  it("installs a fixed package before starting its fixed authentication flow", async () => {
    const deps = dependencies();

    await expect(
      runAgentSetup(["codex", "/data/agent-tools", "/app/npm-cli.js"], deps),
    ).resolves.toBe(0);

    expect(deps.commands).toEqual([
      {
        executable: "/Applications/CODRA.app/Contents/MacOS/CODRA",
        args: [
          "/app/npm-cli.js",
          "install",
          "--prefix",
          "/data/agent-tools",
          "--save-exact",
          "--no-audit",
          "--no-fund",
          "@openai/codex@latest",
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
      {
        executable: "/Applications/CODRA.app/Contents/MacOS/CODRA",
        args: ["/data/agent-tools/node_modules/.bin/codex", "login"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    ]);
  });

  it("returns an npm failure without starting authentication", async () => {
    const deps = dependencies({ exitCodes: [7] });

    await expect(
      runAgentSetup(["claude", "/data/agent-tools", "/app/npm-cli.js"], deps),
    ).resolves.toBe(7);

    expect(deps.commands).toHaveLength(1);
    expect(deps.commands[0]?.args.at(-1)).toBe(
      "@anthropic-ai/claude-code@latest",
    );
  });

  it("uses Electron's Node mode for a managed JavaScript CLI", async () => {
    const deps = dependencies({ nodeScript: true });

    await runAgentSetup(
      ["gemini", "/data/agent-tools", "/app/npm-cli.js"],
      deps,
    );

    expect(deps.commands[1]).toEqual({
      executable: "/Applications/CODRA.app/Contents/MacOS/CODRA",
      args: ["/data/agent-tools/node_modules/.bin/gemini"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("executes a managed native CLI directly", async () => {
    const deps = dependencies({ nodeScript: false });

    await runAgentSetup(
      ["codex", "/data/agent-tools", "/app/npm-cli.js"],
      deps,
    );

    expect(deps.commands[1]).toEqual({
      executable: "/data/agent-tools/node_modules/.bin/codex",
      args: ["login"],
    });
  });

  it("rejects extra inputs and unsupported runtimes before running a command", async () => {
    const deps = dependencies();

    await expect(
      runAgentSetup(["ollama", "/data/agent-tools", "/app/npm-cli.js"], deps),
    ).rejects.toThrow("AGENT_SETUP_ARGUMENTS_INVALID");
    await expect(
      runAgentSetup(
        ["codex", "/data/agent-tools", "/app/npm-cli.js", "attacker"],
        deps,
      ),
    ).rejects.toThrow("AGENT_SETUP_ARGUMENTS_INVALID");
    expect(deps.commands).toEqual([]);
  });
});

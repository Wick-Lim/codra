import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentKind } from "@codra/protocol";
import {
  agentAuthenticationArgs,
  managedAgentExecutablePath,
  managedAgentPackage,
} from "./agent-runtime";

type ManagedAgentKind = Exclude<AgentKind, "ollama">;

export interface AgentSetupRunnerCommand {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface AgentSetupRunnerDependencies {
  electronExecutable: string;
  isNodeScript(path: string): boolean;
  run(command: AgentSetupRunnerCommand): Promise<number>;
}

function isManagedAgentKind(value: string): value is ManagedAgentKind {
  return value === "codex" || value === "claude" || value === "gemini";
}

function parseArguments(args: readonly string[]): {
  kind: ManagedAgentKind;
  installDirectory: string;
  npmCliPath: string;
} {
  if (args.length !== 3) throw new Error("AGENT_SETUP_ARGUMENTS_INVALID");
  const [kind, installDirectory, npmCliPath] = args;
  if (
    !kind ||
    !isManagedAgentKind(kind) ||
    !installDirectory ||
    !isAbsolute(installDirectory) ||
    !npmCliPath ||
    !isAbsolute(npmCliPath)
  ) {
    throw new Error("AGENT_SETUP_ARGUMENTS_INVALID");
  }
  return { kind, installDirectory, npmCliPath };
}

function nodeCommand(
  electronExecutable: string,
  scriptPath: string,
  args: readonly string[],
): AgentSetupRunnerCommand {
  return {
    executable: electronExecutable,
    args: [scriptPath, ...args],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function childEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    CODRA_AGENT_SETUP_RUNNER: _setupRunner,
    ELECTRON_RUN_AS_NODE: _electronNodeMode,
    ...baseEnvironment
  } = process.env;
  return { ...baseEnvironment, ...overrides };
}

const defaultDependencies: AgentSetupRunnerDependencies = {
  electronExecutable: process.execPath,
  isNodeScript: (path) => {
    try {
      const firstLine = readFileSync(path, { encoding: "utf8" })
        .slice(0, 200)
        .split(/\r?\n/u, 1)[0];
      return /^#!.*\bnode(?:\s|$)/u.test(firstLine ?? "");
    } catch {
      return false;
    }
  },
  run: (command) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        env: childEnvironment(command.env),
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    }),
};

export async function runAgentSetup(
  args: readonly string[],
  dependencies: AgentSetupRunnerDependencies = defaultDependencies,
): Promise<number> {
  const { kind, installDirectory, npmCliPath } = parseArguments(args);
  const installExitCode = await dependencies.run(
    nodeCommand(dependencies.electronExecutable, npmCliPath, [
      "install",
      "--prefix",
      installDirectory,
      "--save-exact",
      "--no-audit",
      "--no-fund",
      `${managedAgentPackage(kind)}@latest`,
    ]),
  );
  if (installExitCode !== 0) return installExitCode;

  const executable = managedAgentExecutablePath(kind, installDirectory);
  const authenticationArgs = agentAuthenticationArgs(kind);
  const authenticationCommand = dependencies.isNodeScript(executable)
    ? nodeCommand(
        dependencies.electronExecutable,
        executable,
        authenticationArgs,
      )
    : { executable, args: authenticationArgs };
  return dependencies.run(authenticationCommand);
}

if (process.env.CODRA_AGENT_SETUP_RUNNER === "1") {
  void runAgentSetup(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "AGENT_SETUP_FAILED",
      );
      process.exitCode = 1;
    },
  );
}

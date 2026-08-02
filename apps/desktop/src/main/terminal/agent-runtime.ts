import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentEffortOption,
  AgentKind,
  AgentLaunchRequest,
  AgentModelOption,
  AgentRuntime,
  AgentSetupRequest,
} from "@codra/protocol";

export interface AgentRuntimeDependencies {
  envPath: string;
  homeDirectory: string;
  managedInstallDirectory: string;
  electronExecutable: string;
  npmCliPath: string;
  setupRunnerPath: string;
  isExecutable(path: string): boolean;
  isNodeScript(path: string): boolean;
  runCommand(
    executable: string,
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<string>;
}

export interface AgentCommand {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  title: string;
}

interface AgentProfile {
  executable: string;
  label: string;
  title: string;
  description: string;
  supportsYolo: boolean;
  modelRequired: boolean;
  efforts: AgentEffortOption[];
  installHint: string;
  installMethod: "managed_npm" | "external";
  authentication: "required" | "not_required";
  models: AgentModelOption[];
}

const AGENT_KINDS = ["codex", "claude", "gemini", "ollama"] as const;
const CODEX_EFFORTS: AgentEffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Maximum" },
  { id: "ultra", label: "Ultra" },
];
const CLAUDE_EFFORTS: AgentEffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Maximum" },
];
const OLLAMA_EFFORTS: AgentEffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];
const AGENT_PROFILES: Record<AgentKind, AgentProfile> = {
  codex: {
    executable: "codex",
    label: "Codex CLI",
    title: "Codex",
    description: "OpenAI's coding agent for repository work.",
    supportsYolo: true,
    modelRequired: false,
    efforts: CODEX_EFFORTS,
    installHint: "Install Codex CLI to use this runtime.",
    installMethod: "managed_npm",
    authentication: "required",
    models: [],
  },
  claude: {
    executable: "claude",
    label: "Claude Code",
    title: "Claude",
    description: "Anthropic's agentic coding CLI.",
    supportsYolo: true,
    modelRequired: false,
    efforts: CLAUDE_EFFORTS,
    installHint: "Install Claude Code to use this runtime.",
    installMethod: "managed_npm",
    authentication: "required",
    models: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "fable", label: "Fable" },
    ],
  },
  gemini: {
    executable: "gemini",
    label: "Gemini CLI",
    title: "Gemini",
    description: "Google's open-source terminal coding agent.",
    supportsYolo: true,
    modelRequired: false,
    efforts: [],
    installHint: "Install @google/gemini-cli to use this runtime.",
    installMethod: "managed_npm",
    authentication: "required",
    models: [
      { id: "auto", label: "Auto" },
      { id: "pro", label: "Pro" },
      { id: "flash", label: "Flash" },
      { id: "flash-lite", label: "Flash Lite" },
    ],
  },
  ollama: {
    executable: "ollama",
    label: "Ollama",
    title: "Ollama",
    description: "Run a local model through Ollama.",
    supportsYolo: false,
    modelRequired: true,
    efforts: OLLAMA_EFFORTS,
    installHint: "Install Ollama and pull a model to use this runtime.",
    installMethod: "external",
    authentication: "not_required",
    models: [],
  },
};

const execFileAsync = promisify(execFile);

const defaultDependencies: AgentRuntimeDependencies = {
  envPath: process.env.PATH ?? "",
  homeDirectory: homedir(),
  managedInstallDirectory: join(homedir(), ".codra", "agent-tools"),
  electronExecutable: process.execPath,
  npmCliPath: process.env.CODRA_NPM_CLI_PATH ?? "",
  setupRunnerPath: join(__dirname, "agent-setup-runner.js"),
  isExecutable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isNodeScript: (path) => {
    try {
      return readFileSync(path, { encoding: "utf8" })
        .slice(0, 160)
        .startsWith("#!/usr/bin/env node");
    } catch {
      return false;
    }
  },
  runCommand: async (executable, args, env) => {
    const result = await execFileAsync(executable, [...args], {
      encoding: "utf8",
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 4_000,
      windowsHide: true,
    });
    return result.stdout;
  },
};

export function createAgentRuntimeDependencies(
  paths: Pick<
    AgentRuntimeDependencies,
    | "managedInstallDirectory"
    | "electronExecutable"
    | "npmCliPath"
    | "setupRunnerPath"
  >,
): AgentRuntimeDependencies {
  return { ...defaultDependencies, ...paths };
}

function candidateExecutables(
  kind: AgentKind,
  dependencies: AgentRuntimeDependencies,
): string[] {
  const executable = AGENT_PROFILES[kind].executable;
  const pathCandidates = dependencies.envPath
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, executable));
  const commonCandidates = [
    join(dependencies.homeDirectory, ".local", "bin", executable),
    join(dependencies.homeDirectory, ".npm-global", "bin", executable),
    join("/opt/homebrew/bin", executable),
    join("/usr/local/bin", executable),
    join("/usr/bin", executable),
  ];
  const managedCandidate = managedAgentExecutablePath(
    kind,
    dependencies.managedInstallDirectory,
  );
  return [
    ...new Set([...pathCandidates, managedCandidate, ...commonCandidates]),
  ];
}

export function managedAgentExecutablePath(
  kind: AgentKind,
  installDirectory: string,
): string {
  return join(
    installDirectory,
    "node_modules",
    ".bin",
    AGENT_PROFILES[kind].executable,
  );
}

export function managedAgentPackage(kind: AgentKind): string {
  switch (kind) {
    case "codex":
      return "@openai/codex";
    case "claude":
      return "@anthropic-ai/claude-code";
    case "gemini":
      return "@google/gemini-cli";
    case "ollama":
      throw new Error("AGENT_SETUP_EXTERNAL_REQUIRED");
  }
}

export function agentAuthenticationArgs(kind: AgentKind): string[] {
  switch (kind) {
    case "codex":
      return ["login"];
    case "claude":
      return ["auth", "login"];
    case "gemini":
      return [];
    case "ollama":
      throw new Error("AGENT_SETUP_UNSUPPORTED");
  }
}

function findAgentExecutable(
  kind: AgentKind,
  dependencies: AgentRuntimeDependencies,
): string | undefined {
  return candidateExecutables(kind, dependencies).find(
    dependencies.isExecutable,
  );
}

function commandForExecutable(
  kind: AgentKind,
  executable: string,
  args: string[],
  title: string,
  dependencies: AgentRuntimeDependencies,
): AgentCommand {
  const managedExecutable = managedAgentExecutablePath(
    kind,
    dependencies.managedInstallDirectory,
  );
  if (
    executable === managedExecutable &&
    dependencies.isNodeScript(executable)
  ) {
    return {
      executable: dependencies.electronExecutable,
      args: [executable, ...args],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      title,
    };
  }
  return { executable, args, title };
}

export function agentTerminalTitle(kind: AgentKind, model?: string): string {
  const title = AGENT_PROFILES[kind].title;
  return model ? `${title} · ${model}` : title;
}

function uniqueModels(models: readonly AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  return models.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function effortLabel(effort: string): string {
  const labels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum",
    ultra: "Ultra",
  };
  return (
    labels[effort] ?? `${effort[0]?.toLocaleUpperCase()}${effort.slice(1)}`
  );
}

function uniqueEfforts(
  efforts: readonly AgentEffortOption[],
): AgentEffortOption[] {
  const seen = new Set<string>();
  return efforts.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function parseCodexModels(output: string): AgentModelOption[] {
  const parsed: unknown = JSON.parse(output);
  if (!parsed || typeof parsed !== "object" || !("models" in parsed)) return [];
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  return uniqueModels(
    models.flatMap((model): AgentModelOption[] => {
      if (!model || typeof model !== "object") return [];
      const candidate = model as Record<string, unknown>;
      if (
        typeof candidate.slug !== "string" ||
        (candidate.visibility !== undefined && candidate.visibility !== "list")
      ) {
        return [];
      }
      const effortLevels = Array.isArray(candidate.supported_reasoning_levels)
        ? candidate.supported_reasoning_levels
        : [];
      const efforts = uniqueEfforts(
        effortLevels.flatMap((level): AgentEffortOption[] => {
          if (!level || typeof level !== "object") return [];
          const effort = (level as Record<string, unknown>).effort;
          return typeof effort === "string"
            ? [{ id: effort, label: effortLabel(effort) }]
            : [];
        }),
      );
      return [
        {
          id: candidate.slug,
          label:
            typeof candidate.display_name === "string"
              ? candidate.display_name
              : candidate.slug,
          ...(efforts.length > 0 ? { efforts } : {}),
        },
      ];
    }),
  );
}

function parseOllamaModels(output: string): AgentModelOption[] {
  return uniqueModels(
    output
      .split(/\r?\n/u)
      .slice(1)
      .map((line) => line.trim().split(/\s+/u)[0])
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, label: id })),
  );
}

async function discoverModels(
  kind: AgentKind,
  executable: string | undefined,
  dependencies: AgentRuntimeDependencies,
): Promise<AgentModelOption[]> {
  if (!executable) return AGENT_PROFILES[kind].models;
  try {
    if (kind === "codex") {
      const command = commandForExecutable(
        kind,
        executable,
        ["debug", "models"],
        AGENT_PROFILES[kind].title,
        dependencies,
      );
      return parseCodexModels(
        await dependencies.runCommand(
          command.executable,
          command.args,
          command.env,
        ),
      );
    }
    if (kind === "ollama") {
      const command = commandForExecutable(
        kind,
        executable,
        ["list"],
        AGENT_PROFILES[kind].title,
        dependencies,
      );
      return parseOllamaModels(
        await dependencies.runCommand(
          command.executable,
          command.args,
          command.env,
        ),
      );
    }
  } catch {
    return AGENT_PROFILES[kind].models;
  }
  return AGENT_PROFILES[kind].models;
}

export async function listAgentRuntimes(
  dependencies: AgentRuntimeDependencies = defaultDependencies,
): Promise<AgentRuntime[]> {
  return Promise.all(
    AGENT_KINDS.map(async (kind) => {
      const profile = AGENT_PROFILES[kind];
      const executable = findAgentExecutable(kind, dependencies);
      const models = await discoverModels(kind, executable, dependencies);
      const discoveredEfforts = uniqueEfforts(
        models.flatMap((model) => model.efforts ?? []),
      );
      const efforts =
        kind === "codex"
          ? discoveredEfforts.length > 0
            ? discoveredEfforts
            : profile.efforts
          : profile.efforts;
      return {
        kind,
        label: profile.label,
        description: profile.description,
        available: executable !== undefined,
        supportsYolo: profile.supportsYolo,
        modelRequired: profile.modelRequired,
        efforts,
        models,
        installHint: profile.installHint,
        setup: {
          installMethod: profile.installMethod,
          authentication: profile.authentication,
        },
      };
    }),
  );
}

export function resolveAgentCommand(
  launch: AgentLaunchRequest,
  dependencies: AgentRuntimeDependencies = defaultDependencies,
): AgentCommand {
  const executable = findAgentExecutable(launch.kind, dependencies);
  if (!executable) throw new Error("AGENT_CLI_NOT_FOUND");
  const profile = AGENT_PROFILES[launch.kind];
  if (
    launch.effort &&
    !profile.efforts.some((effort) => effort.id === launch.effort)
  ) {
    throw new Error("AGENT_EFFORT_UNSUPPORTED");
  }
  const modelArgs = launch.model ? ["--model", launch.model] : [];
  let args: string[];
  switch (launch.kind) {
    case "codex":
      args = [
        ...(launch.yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
        ...modelArgs,
        ...(launch.effort
          ? ["-c", `model_reasoning_effort="${launch.effort}"`]
          : []),
        "--",
        launch.prompt,
      ];
      break;
    case "claude":
      args = [
        ...(launch.yolo ? ["--dangerously-skip-permissions"] : []),
        ...modelArgs,
        ...(launch.effort ? ["--effort", launch.effort] : []),
        "--",
        launch.prompt,
      ];
      break;
    case "gemini":
      if (launch.effort) throw new Error("AGENT_EFFORT_UNSUPPORTED");
      args = [
        ...(launch.yolo ? ["--approval-mode=yolo"] : []),
        ...modelArgs,
        "--prompt-interactive",
        launch.prompt,
      ];
      break;
    case "ollama":
      if (!launch.model) throw new Error("AGENT_MODEL_REQUIRED");
      if (launch.yolo) throw new Error("AGENT_YOLO_UNSUPPORTED");
      args = [
        "run",
        launch.model,
        ...(launch.effort ? ["--think", launch.effort] : []),
        "--",
        launch.prompt,
      ];
      break;
  }
  return commandForExecutable(
    launch.kind,
    executable,
    args,
    agentTerminalTitle(launch.kind, launch.model),
    dependencies,
  );
}

export function resolveAgentSetupCommand(
  request: AgentSetupRequest,
  dependencies: AgentRuntimeDependencies = defaultDependencies,
): AgentCommand {
  const profile = AGENT_PROFILES[request.kind];
  const title = `Setup ${profile.title}`;
  if (request.kind === "ollama") {
    if (request.action === "authenticate")
      throw new Error("AGENT_SETUP_UNSUPPORTED");
    throw new Error("AGENT_SETUP_EXTERNAL_REQUIRED");
  }
  if (request.action === "install") {
    if (
      !dependencies.electronExecutable ||
      !dependencies.npmCliPath ||
      !dependencies.setupRunnerPath
    ) {
      throw new Error("AGENT_INSTALLER_UNAVAILABLE");
    }
    return {
      executable: dependencies.electronExecutable,
      args: [
        dependencies.setupRunnerPath,
        request.kind,
        dependencies.managedInstallDirectory,
        dependencies.npmCliPath,
      ],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        CODRA_AGENT_SETUP_RUNNER: "1",
      },
      title,
    };
  }
  const executable = findAgentExecutable(request.kind, dependencies);
  if (!executable) throw new Error("AGENT_CLI_NOT_FOUND");
  return commandForExecutable(
    request.kind,
    executable,
    agentAuthenticationArgs(request.kind),
    title,
    dependencies,
  );
}

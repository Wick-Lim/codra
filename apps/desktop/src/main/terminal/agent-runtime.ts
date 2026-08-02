import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentEffortOption,
  AgentKind,
  AgentLaunchRequest,
  AgentModelOption,
  AgentRuntime,
} from "@codra/protocol";

export interface AgentRuntimeDependencies {
  envPath: string;
  homeDirectory: string;
  isExecutable(path: string): boolean;
  runCommand(executable: string, args: readonly string[]): Promise<string>;
}

export interface AgentCommand {
  executable: string;
  args: string[];
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
    models: [],
  },
};

const execFileAsync = promisify(execFile);

const defaultDependencies: AgentRuntimeDependencies = {
  envPath: process.env.PATH ?? "",
  homeDirectory: homedir(),
  isExecutable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  runCommand: async (executable, args) => {
    const result = await execFileAsync(executable, [...args], {
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: 4_000,
      windowsHide: true,
    });
    return result.stdout;
  },
};

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
  return [...new Set([...pathCandidates, ...commonCandidates])];
}

function findAgentExecutable(
  kind: AgentKind,
  dependencies: AgentRuntimeDependencies,
): string | undefined {
  return candidateExecutables(kind, dependencies).find(
    dependencies.isExecutable,
  );
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
      return parseCodexModels(
        await dependencies.runCommand(executable, ["debug", "models"]),
      );
    }
    if (kind === "ollama") {
      return parseOllamaModels(
        await dependencies.runCommand(executable, ["list"]),
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
  return {
    executable,
    args,
    title: agentTerminalTitle(launch.kind, launch.model),
  };
}

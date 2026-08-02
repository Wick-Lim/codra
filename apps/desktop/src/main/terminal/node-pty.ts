import { homedir } from "node:os";
import * as nodePty from "node-pty";
import type { CreateTerminalRequest } from "@codra/protocol";
import type { PtyFactory, PtyHandle } from "./contracts";
import {
  resolveAgentCommand,
  resolveAgentSetupCommand,
  type AgentCommand,
} from "./agent-runtime";

const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

function bound(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

export class NodePtyFactory implements PtyFactory {
  constructor(
    private readonly resolveAgent: (
      launch: NonNullable<CreateTerminalRequest["agent"]>,
    ) => AgentCommand = resolveAgentCommand,
    private readonly resolveAgentSetup: (
      request: NonNullable<CreateTerminalRequest["agentSetup"]>,
    ) => AgentCommand = resolveAgentSetupCommand,
  ) {}

  spawn(request: CreateTerminalRequest): PtyHandle {
    const command: Pick<AgentCommand, "executable" | "args" | "env"> =
      request.agent
        ? this.resolveAgent(request.agent)
        : request.agentSetup
          ? this.resolveAgentSetup(request.agentSetup)
          : {
              executable: process.env.SHELL || "/bin/zsh",
              args: ["-l"],
            };
    const pty = nodePty.spawn(command.executable, command.args, {
      cwd: request.cwd ?? homedir(),
      cols: bound(request.cols, MIN_COLS, MAX_COLS),
      rows: bound(request.rows, MIN_ROWS, MAX_ROWS),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        ...command.env,
      },
    });

    return {
      pid: pty.pid,
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      kill: (signal) => {
        if (signal === undefined) pty.kill();
        else pty.kill(signal);
      },
      onData: (listener) => {
        const disposable = pty.onData(listener);
        return () => disposable.dispose();
      },
      onExit: (listener) => {
        const disposable = pty.onExit(({ exitCode }) => listener(exitCode));
        return () => disposable.dispose();
      },
    };
  }
}

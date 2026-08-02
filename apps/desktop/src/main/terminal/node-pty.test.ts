import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as nodePty from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodePtyFactory } from "./node-pty";

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timeout: number | NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("NodePtyFactory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("forwards explicit kill signals and preserves zero-argument kills", () => {
    const kill = vi.fn();
    vi.spyOn(nodePty, "spawn").mockReturnValue({
      pid: 42,
      write: vi.fn(),
      resize: vi.fn(),
      kill,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as nodePty.IPty);
    const pty = new NodePtyFactory().spawn({
      cwd: homedir(),
      cols: 80,
      rows: 24,
    });

    pty.kill("SIGKILL");

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    kill.mockClear();

    pty.kill();

    expect(kill).toHaveBeenCalledWith();
  });

  it("spawns an agent executable directly with its structured argv", () => {
    vi.spyOn(nodePty, "spawn").mockReturnValue({
      pid: 42,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as nodePty.IPty);
    const resolveAgent = vi.fn(() => ({
      executable: "/opt/homebrew/bin/codex",
      args: ["--dangerously-bypass-approvals-and-sandbox", "--", "Fix it"],
      title: "Codex",
    }));

    new NodePtyFactory(resolveAgent).spawn({
      cwd: "/workspace",
      cols: 100,
      rows: 30,
      agent: { kind: "codex", yolo: true, prompt: "Fix it" },
    });

    expect(resolveAgent).toHaveBeenCalledWith({
      kind: "codex",
      yolo: true,
      prompt: "Fix it",
    });
    expect(nodePty.spawn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/codex",
      ["--dangerously-bypass-approvals-and-sandbox", "--", "Fix it"],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("runs zsh and reaps its child after observing real command output", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const pty = new NodePtyFactory().spawn({
      cwd: homedir(),
      cols: 80,
      rows: 24,
    });
    const markerSuffix = `PTY_${randomUUID()}__`;
    const marker = `__CODRA_${markerSuffix}`;
    const command = `printf '%s%s\\n' '__CODRA_' '${markerSuffix}'\r`;
    let output = "";
    let resolveOutput!: (value: string) => void;
    const outputReceived = new Promise<string>((resolve) => {
      resolveOutput = resolve;
    });
    let resolveExit!: (exitCode: number) => void;
    const exitReceived = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const unsubscribeExit = pty.onExit(resolveExit);
    const unsubscribeData = pty.onData((data) => {
      output += data;
      if (output.includes(marker)) resolveOutput(output);
    });
    let exitCode: number;

    expect(command).not.toContain(marker);
    try {
      pty.write(command);
      const received = await withTimeout(
        outputReceived,
        "Timed out waiting for zsh PTY output",
      );
      expect(received).toContain(marker);
    } finally {
      unsubscribeData();
      pty.kill();
      exitCode = await withTimeout(
        exitReceived,
        "Timed out waiting for zsh PTY exit",
      );
      unsubscribeExit();
    }

    expect(exitCode).toBeTypeOf("number");
    await vi.waitFor(() => expect(isProcessAlive(pty.pid)).toBe(false), {
      timeout: 5_000,
    });
  });
});

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
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
    vi.unstubAllEnvs();
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

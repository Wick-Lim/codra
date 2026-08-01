import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodePtyFactory } from "./node-pty";

describe("NodePtyFactory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs zsh and yields its output without leaking the child", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const pty = new NodePtyFactory().spawn({
      cwd: homedir(),
      cols: 80,
      rows: 24,
    });
    let unsubscribe = () => {};

    try {
      const marker = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for zsh PTY output")),
          5_000,
        );
        unsubscribe = pty.onData((data) => {
          if (data.includes("__CODRA_PTY__")) {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        pty.write("printf '__CODRA_PTY__\\n'\r");
      });

      expect(marker).toContain("__CODRA_PTY__");
    } finally {
      unsubscribe();
      pty.kill();
    }
  });
});

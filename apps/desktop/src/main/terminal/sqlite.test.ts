import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalDescriptor } from "@codra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteTerminalRepository } from "./sqlite";

const descriptor: TerminalDescriptor = {
  id: "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5",
  title: "shell",
  cwd: "/workspace",
  cols: 120,
  rows: 32,
  state: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
};

describe("SqliteTerminalRepository", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function databasePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "codra-sqlite-"));
    directories.push(directory);
    return join(directory, "nested", "terminals.db");
  }

  it("persists descriptors in WAL mode", async () => {
    const repository = new SqliteTerminalRepository(await databasePath());
    await repository.save(descriptor);

    expect(await repository.list()).toEqual([descriptor]);
    expect(repository.journalMode()).toBe("wal");
    repository.close();
  });

  it("updates a persisted descriptor", async () => {
    const repository = new SqliteTerminalRepository(await databasePath());
    await repository.save(descriptor);
    await repository.update({
      ...descriptor,
      cols: 80,
      rows: 24,
      title: "smaller shell",
    });

    expect(await repository.list()).toEqual([
      { ...descriptor, cols: 80, rows: 24, title: "smaller shell" },
    ]);
    repository.close();
  });

  it("marks stale running descriptors exited after an abnormal restart", async () => {
    const repository = new SqliteTerminalRepository(await databasePath());
    await repository.save(descriptor);
    await repository.markRunningExited(-1);

    expect(await repository.list()).toEqual([
      { ...descriptor, state: "exited", exitCode: -1 },
    ]);
    repository.close();
  });
});

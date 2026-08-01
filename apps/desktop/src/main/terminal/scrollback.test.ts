import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTerminalOutputStore } from "./scrollback";

const terminalId = "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5";

describe("FileTerminalOutputStore", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function rootDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "codra-scrollback-"));
    directories.push(directory);
    return directory;
  }

  it("replays monotonically sequenced chunks", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 1024);
    await store.append(terminalId, "one");
    await store.append(terminalId, "two");

    expect(await store.readAfter(terminalId, 1, 10)).toEqual([
      { terminalId, sequence: 2, data: "two" },
    ]);
  });

  it("applies after-sequence and limit boundaries", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 1024);
    await Promise.all([
      store.append(terminalId, "one"),
      store.append(terminalId, "two"),
      store.append(terminalId, "three"),
    ]);

    expect(await store.readAfter(terminalId, 0, 2)).toEqual([
      { terminalId, sequence: 1, data: "one" },
      { terminalId, sequence: 2, data: "two" },
    ]);
    expect(await store.readAfter(terminalId, 2, 2)).toEqual([
      { terminalId, sequence: 3, data: "three" },
    ]);
  });

  it("continues sequence numbers after constructing a new store", async () => {
    const root = await rootDirectory();
    const first = new FileTerminalOutputStore(root, 1024);
    await first.append(terminalId, "one");
    const restarted = new FileTerminalOutputStore(root, 1024);

    await expect(restarted.append(terminalId, "two")).resolves.toEqual({
      terminalId,
      sequence: 2,
      data: "two",
    });
  });

  it("compacts to the configured byte limit without splitting UTF-8 records", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 96);
    for (let index = 0; index < 20; index += 1) {
      await store.append(terminalId, `한글-${index}\n`);
    }

    const path = store.pathFor(terminalId);
    expect((await stat(path)).size).toBeLessThanOrEqual(96);
    expect((await store.readAfter(terminalId, 0, 100)).at(-1)?.data).toBe(
      "한글-19\n",
    );
    expect(
      (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .every((line) => JSON.parse(line).data.startsWith("한글-")),
    ).toBe(true);
  });

  it("continues serving writes after a queued write fails", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 1024);
    const path = store.pathFor(terminalId);
    await mkdir(path);

    await expect(store.append(terminalId, "blocked")).rejects.toThrow();
    await rm(path, { force: true, recursive: true });

    await expect(store.append(terminalId, "recovered")).resolves.toEqual({
      terminalId,
      sequence: 1,
      data: "recovered",
    });
  });

  it("rejects terminal identifiers that cannot safely form a path", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 1024);

    expect(() => store.pathFor("../outside")).toThrow();
    await expect(store.append("../outside", "data")).rejects.toThrow();
  });
});

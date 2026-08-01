import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTerminalOutputStore } from "./scrollback";

const terminalId = "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5";

function operationQueues(
  store: FileTerminalOutputStore,
): Map<string, Promise<void>> {
  return (store as unknown as { queues: Map<string, Promise<void>> }).queues;
}

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

  it("truncates an unterminated crash tail before appending", async () => {
    const root = await rootDirectory();
    const path = new FileTerminalOutputStore(root, 1024).pathFor(terminalId);
    await writeFile(
      path,
      '{"sequence":1,"data":"one"}\n{"sequence":2,"data":"partial',
      "utf8",
    );
    const recovered = new FileTerminalOutputStore(root, 1024);

    await expect(recovered.append(terminalId, "two")).resolves.toEqual({
      terminalId,
      sequence: 2,
      data: "two",
    });
    await expect(recovered.readAfter(terminalId, 0, 10)).resolves.toEqual([
      { terminalId, sequence: 1, data: "one" },
      { terminalId, sequence: 2, data: "two" },
    ]);
  });

  it("rejects a malformed complete record without appending to it", async () => {
    const root = await rootDirectory();
    const path = new FileTerminalOutputStore(root, 1024).pathFor(terminalId);
    const corrupted = '{"sequence":1,"data":"one"}\n{"sequence":2,"data":}\n';
    await writeFile(path, corrupted, "utf8");
    const recovered = new FileTerminalOutputStore(root, 1024);

    await expect(recovered.append(terminalId, "two")).rejects.toThrow(
      "Malformed scrollback record at line 2",
    );
    await expect(readFile(path, "utf8")).resolves.toBe(corrupted);
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

  it("leaves headroom after compaction so following appends do not rewrite the file", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 256);
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      await store.append(
        terminalId,
        `chunk-${sequence.toString().padStart(2, "0")}`,
      );
    }

    const path = store.pathFor(terminalId);
    const inodeAfterCompaction = (await stat(path)).ino;
    await store.append(terminalId, "chunk-09");
    expect((await stat(path)).ino).toBe(inodeAfterCompaction);
    await store.append(terminalId, "chunk-10");
    expect((await stat(path)).ino).toBe(inodeAfterCompaction);

    const records = await store.readAfter(terminalId, 0, 100);
    expect((await stat(path)).size).toBeLessThanOrEqual(256);
    expect(records.at(-1)).toEqual({
      terminalId,
      sequence: 10,
      data: "chunk-10",
    });
  });

  it("retains the newest capped record when it is larger than the low watermark", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 128);
    await store.append(terminalId, "old");
    await store.append(terminalId, "old");
    const latest = "x".repeat(75);

    await store.append(terminalId, latest);

    const path = store.pathFor(terminalId);
    expect((await stat(path)).size).toBeGreaterThan(96);
    expect((await stat(path)).size).toBeLessThanOrEqual(128);
    await expect(store.readAfter(terminalId, 0, 100)).resolves.toEqual([
      { terminalId, sequence: 3, data: latest },
    ]);
  });

  it("rejects an oversized multibyte record without consuming its sequence", async () => {
    const root = await rootDirectory();
    const store = new FileTerminalOutputStore(root, 64);
    await store.append(terminalId, "one");
    const before = await readFile(store.pathFor(terminalId), "utf8");

    await expect(store.append(terminalId, "한".repeat(20))).rejects.toThrow(
      "exceeds the 64-byte scrollback limit",
    );
    await expect(readFile(store.pathFor(terminalId), "utf8")).resolves.toBe(
      before,
    );

    const restarted = new FileTerminalOutputStore(root, 64);
    await expect(restarted.append(terminalId, "two")).resolves.toEqual({
      terminalId,
      sequence: 2,
      data: "two",
    });
    await expect(restarted.readAfter(terminalId, 0, 10)).resolves.toEqual([
      { terminalId, sequence: 1, data: "one" },
      { terminalId, sequence: 2, data: "two" },
    ]);
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

  it("releases settled queues after append, read, and remove", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 1024);

    await store.append(terminalId, "one");
    expect(operationQueues(store).size).toBe(0);
    await store.readAfter(terminalId, 0, 10);
    expect(operationQueues(store).size).toBe(0);
    await store.remove(terminalId);
    expect(operationQueues(store).size).toBe(0);
  });

  it("does not clear a newer queue tail when an older operation settles", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 1024);
    const operation = store.append(terminalId, "one");
    const queues = operationQueues(store);
    const newerTail = Promise.resolve();
    queues.set(terminalId, newerTail);

    await operation;

    expect(queues.get(terminalId)).toBe(newerTail);
  });

  it("rejects terminal identifiers that cannot safely form a path", async () => {
    const store = new FileTerminalOutputStore(await rootDirectory(), 1024);

    expect(() => store.pathFor("../outside")).toThrow();
    await expect(store.append("../outside", "data")).rejects.toThrow();
  });
});

import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { TerminalIdSchema, type TerminalOutputChunk } from "@codra/protocol";
import type { TerminalOutputStore } from "./contracts";

interface StoredChunk {
  sequence: number;
  data: string;
}

const defaultByteLimit = 10 * 1024 * 1024;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseRecord(line: string): StoredChunk | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "sequence" in parsed &&
      "data" in parsed &&
      typeof parsed.sequence === "number" &&
      Number.isSafeInteger(parsed.sequence) &&
      parsed.sequence > 0 &&
      typeof parsed.data === "string"
    ) {
      return { sequence: parsed.sequence, data: parsed.data };
    }
  } catch {
    // A partial final record can result from an interrupted append.
  }
  return undefined;
}

function parseCompleteRecords(contents: string): StoredChunk[] {
  const lines = contents.split("\n");
  if (lines.at(-1) !== "") {
    lines.pop();
  }
  return lines.flatMap((line) => {
    const record = parseRecord(line);
    return record === undefined ? [] : [record];
  });
}

function encodeRecord(record: StoredChunk): string {
  return `${JSON.stringify(record)}\n`;
}

export class FileTerminalOutputStore implements TerminalOutputStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly nextSequences = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly byteLimit = defaultByteLimit,
  ) {}

  pathFor(terminalId: string): string {
    const id = TerminalIdSchema.parse(terminalId);
    return join(this.root, `${id}.jsonl`);
  }

  async append(terminalId: string, data: string): Promise<TerminalOutputChunk> {
    this.pathFor(terminalId);
    return this.enqueue(terminalId, async () => {
      const sequence = await this.nextSequence(terminalId);
      const record = { sequence, data };
      await mkdir(this.root, { recursive: true });
      await appendFile(this.pathFor(terminalId), encodeRecord(record), "utf8");
      this.nextSequences.set(terminalId, sequence + 1);
      await this.compact(terminalId);
      return { terminalId, ...record };
    });
  }

  async readAfter(
    terminalId: string,
    afterSequence: number,
    limit: number,
  ): Promise<TerminalOutputChunk[]> {
    this.pathFor(terminalId);
    return this.enqueue(terminalId, async () =>
      (await this.readRecords(terminalId))
        .filter((record) => record.sequence > afterSequence)
        .slice(0, limit)
        .map((record) => ({ terminalId, ...record })),
    );
  }

  async remove(terminalId: string): Promise<void> {
    this.pathFor(terminalId);
    await this.enqueue(terminalId, async () => {
      await Promise.all([
        rm(this.pathFor(terminalId), { force: true }),
        rm(this.compactPathFor(terminalId), { force: true }),
      ]);
      this.nextSequences.delete(terminalId);
    });
  }

  private compactPathFor(terminalId: string): string {
    const id = TerminalIdSchema.parse(terminalId);
    return join(this.root, `${id}.compact`);
  }

  private enqueue<T>(terminalId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(terminalId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    this.queues.set(
      terminalId,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operation;
  }

  private async nextSequence(terminalId: string): Promise<number> {
    const cached = this.nextSequences.get(terminalId);
    if (cached !== undefined) {
      return cached;
    }
    const records = await this.readRecords(terminalId);
    const next =
      records.reduce(
        (highest, record) => Math.max(highest, record.sequence),
        0,
      ) + 1;
    this.nextSequences.set(terminalId, next);
    return next;
  }

  private async readRecords(terminalId: string): Promise<StoredChunk[]> {
    try {
      return parseCompleteRecords(
        await readFile(this.pathFor(terminalId), "utf8"),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async compact(terminalId: string): Promise<void> {
    const path = this.pathFor(terminalId);
    if ((await stat(path)).size <= this.byteLimit) {
      return;
    }

    const newest = await this.readRecords(terminalId);
    const retained: string[] = [];
    let size = 0;
    for (let index = newest.length - 1; index >= 0; index -= 1) {
      const encoded = encodeRecord(newest[index]);
      const encodedSize = Buffer.byteLength(encoded, "utf8");
      if (size + encodedSize > this.byteLimit) {
        break;
      }
      retained.unshift(encoded);
      size += encodedSize;
    }

    const compactPath = this.compactPathFor(terminalId);
    const file = await open(compactPath, "w");
    try {
      await file.writeFile(retained.join(""), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(compactPath, path);
  }
}

import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import {
  TerminalIdSchema,
  type TerminalOutputChunk,
  type TerminalOutputCursorReadResult,
} from "@codra/protocol";
import type { TerminalOutputStore } from "./contracts";

interface StoredChunk {
  sequence: number;
  data: string;
  startCursor?: bigint;
  endCursor?: bigint;
}

interface PersistedCursorRecord {
  sequence: number;
  startCursor: string;
  endCursor: string;
}

const defaultByteLimit = 10 * 1024 * 1024;
const compactionLowWatermarkRatio = 0.75;

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
      const recordObject = parsed as Record<string, unknown>;
      const parseCursor = (key: "b" | "e"): bigint | undefined => {
        if (!(key in recordObject)) return undefined;
        const value = recordObject[key];
        if (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0
        )
          return BigInt(value);
        if (typeof value === "string" && /^\d+$/u.test(value))
          return BigInt(value);
        return undefined;
      };
      const start = parseCursor("b");
      const end = parseCursor("e");
      const hasStart = "b" in recordObject;
      const hasEnd = "e" in recordObject;
      if (
        hasStart !== hasEnd ||
        (hasStart && (start === undefined || end === undefined))
      )
        return undefined;
      return {
        sequence: parsed.sequence,
        data: parsed.data,
        startCursor: start,
        endCursor: end,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseCompleteRecords(contents: string): StoredChunk[] {
  const lines = contents.split("\n");
  lines.pop();
  return lines.map((line, index) => {
    const record = parseRecord(line);
    if (record === undefined) {
      throw new Error(`Malformed scrollback record at line ${index + 1}`);
    }
    return record;
  });
}

function encodeRecord(record: StoredChunk, includeCursor = true): string {
  const encoded =
    !includeCursor ||
    record.startCursor === undefined ||
    record.endCursor === undefined
      ? { sequence: record.sequence, data: record.data }
      : {
          sequence: record.sequence,
          data: record.data,
          b: record.startCursor.toString(),
          e: record.endCursor.toString(),
        };
  return `${JSON.stringify(encoded)}\n`;
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
      const records = this.normalizeCursors(
        await this.readRecordsWithPersistedCursors(terminalId),
      );
      const latestCursor = records.at(-1)?.endCursor ?? 0n;
      const record = {
        sequence,
        data,
        startCursor: latestCursor,
        endCursor: latestCursor + BigInt(Buffer.byteLength(data, "utf8")),
      };
      const encoded = encodeRecord(record, this.byteLimit >= 1024);
      const encodedSize = Buffer.byteLength(encoded, "utf8");
      if (encodedSize > this.byteLimit) {
        throw new RangeError(
          `Encoded scrollback record (${encodedSize} bytes) exceeds the ${this.byteLimit}-byte scrollback limit`,
        );
      }
      await mkdir(this.root, { recursive: true });
      await appendFile(this.pathFor(terminalId), encoded, "utf8");
      await this.persistCursors(terminalId, [...records, record]);
      this.nextSequences.set(terminalId, sequence + 1);
      await this.compact(terminalId);
      return { terminalId, sequence: record.sequence, data: record.data };
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
        .map((record) => ({
          terminalId,
          sequence: record.sequence,
          data: record.data,
        })),
    );
  }

  async readFromCursor(
    terminalId: string,
    afterCursor: bigint,
    maxBytes: number,
  ): Promise<TerminalOutputCursorReadResult> {
    this.pathFor(terminalId);
    if (afterCursor < 0n || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("Invalid cursor read bounds");
    }
    return this.enqueue(terminalId, async () => {
      const records = await this.readRecordsWithPersistedCursors(terminalId);
      const normalized = this.normalizeCursors(records);
      const earliestCursor = normalized[0]?.startCursor ?? 0n;
      const latestCursor = normalized.at(-1)?.endCursor ?? earliestCursor;
      const truncated = afterCursor < earliestCursor;
      const startingCursor = truncated ? earliestCursor : afterCursor;
      const chunks: TerminalOutputCursorReadResult["chunks"] = [];
      let used = 0;
      for (const record of normalized) {
        const recordStart = record.startCursor ?? startingCursor;
        const recordEnd = record.endCursor ?? recordStart;
        if (recordEnd <= startingCursor) continue;
        const bytes = new TextEncoder().encode(record.data);
        const skip = Number(
          startingCursor > recordStart ? startingCursor - recordStart : 0n,
        );
        const available = bytes.subarray(Math.min(skip, bytes.byteLength));
        const remaining = maxBytes - used;
        if (remaining <= 0) break;
        const payload = available.subarray(0, remaining);
        const startCursor = recordStart + BigInt(skip);
        const endCursor = startCursor + BigInt(payload.byteLength);
        chunks.push({
          sequence: BigInt(record.sequence),
          startCursor,
          endCursor,
          data: payload,
        });
        used += payload.byteLength;
        if (payload.byteLength < available.byteLength) break;
      }
      return { chunks, earliestCursor, latestCursor, truncated };
    });
  }

  async remove(terminalId: string): Promise<void> {
    this.pathFor(terminalId);
    await this.enqueue(terminalId, async () => {
      await Promise.all([
        rm(this.pathFor(terminalId), { force: true }),
        rm(this.compactPathFor(terminalId), { force: true }),
        rm(this.cursorPathFor(terminalId), { force: true }),
      ]);
      this.nextSequences.delete(terminalId);
    });
  }

  private compactPathFor(terminalId: string): string {
    const id = TerminalIdSchema.parse(terminalId);
    return join(this.root, `${id}.compact`);
  }

  private cursorPathFor(terminalId: string): string {
    const id = TerminalIdSchema.parse(terminalId);
    return join(this.root, `${id}.cursor.json`);
  }

  private enqueue<T>(terminalId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(terminalId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(terminalId, tail);
    return operation.finally(() => {
      if (this.queues.get(terminalId) === tail) {
        this.queues.delete(terminalId);
      }
    });
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
      const path = this.pathFor(terminalId);
      const contents = await readFile(path);
      const completeLength =
        contents.at(-1) === 0x0a
          ? contents.length
          : contents.lastIndexOf(0x0a) + 1;
      if (completeLength !== contents.length) {
        await truncate(path, completeLength);
      }
      return parseCompleteRecords(
        contents.subarray(0, completeLength).toString("utf8"),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readRecordsWithPersistedCursors(
    terminalId: string,
  ): Promise<StoredChunk[]> {
    const records = await this.readRecords(terminalId);
    const metadata = await this.readPersistedCursors(terminalId);
    return records.map((record) => {
      const cursor = metadata.get(record.sequence);
      return cursor === undefined
        ? record
        : {
            ...record,
            startCursor: BigInt(cursor.startCursor),
            endCursor: BigInt(cursor.endCursor),
          };
    });
  }

  private async readPersistedCursors(
    terminalId: string,
  ): Promise<Map<number, PersistedCursorRecord>> {
    try {
      const parsed: unknown = JSON.parse(
        (await readFile(this.cursorPathFor(terminalId))).toString("utf8"),
      );
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("version" in parsed) ||
        parsed.version !== 1 ||
        !("chunks" in parsed) ||
        !Array.isArray(parsed.chunks)
      )
        throw new Error("Malformed scrollback cursor metadata");
      const result = new Map<number, PersistedCursorRecord>();
      for (const entry of parsed.chunks) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("sequence" in entry) ||
          !("startCursor" in entry) ||
          !("endCursor" in entry) ||
          typeof entry.sequence !== "number" ||
          !Number.isSafeInteger(entry.sequence) ||
          typeof entry.startCursor !== "string" ||
          typeof entry.endCursor !== "string" ||
          !/^\d+$/u.test(entry.startCursor) ||
          !/^\d+$/u.test(entry.endCursor)
        )
          throw new Error("Malformed scrollback cursor metadata");
        result.set(entry.sequence, {
          sequence: entry.sequence,
          startCursor: entry.startCursor,
          endCursor: entry.endCursor,
        });
      }
      return result;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return new Map();
      throw error;
    }
  }

  private async persistCursors(
    terminalId: string,
    records: StoredChunk[],
  ): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const normalized = this.normalizeCursors(records);
    const chunks: PersistedCursorRecord[] = normalized.map((record) => ({
      sequence: record.sequence,
      startCursor: (record.startCursor ?? 0n).toString(),
      endCursor: (record.endCursor ?? 0n).toString(),
    }));
    const path = this.cursorPathFor(terminalId);
    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    const file = await open(temporaryPath, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, chunks }), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private normalizeCursors(records: StoredChunk[]): StoredChunk[] {
    let cursor = 0n;
    return records.map((record) => {
      const startCursor = record.startCursor ?? cursor;
      const endCursor =
        record.endCursor ??
        startCursor + BigInt(Buffer.byteLength(record.data, "utf8"));
      cursor = endCursor;
      return { ...record, startCursor, endCursor };
    });
  }

  private async compact(terminalId: string): Promise<void> {
    const path = this.pathFor(terminalId);
    const beforeSize = (await stat(path)).size;
    if (beforeSize <= this.byteLimit) {
      return;
    }

    const newest = await this.readRecordsWithPersistedCursors(terminalId);
    const retained: string[] = [];
    const retainedRecords: StoredChunk[] = [];
    let size = 0;
    const lowWatermark = Math.floor(
      this.byteLimit * compactionLowWatermarkRatio,
    );
    for (let index = newest.length - 1; index >= 0; index -= 1) {
      const encoded = encodeRecord(newest[index], this.byteLimit >= 1024);
      const encodedSize = Buffer.byteLength(encoded, "utf8");
      if (retained.length > 0 && size + encodedSize > lowWatermark) {
        break;
      }
      retained.unshift(encoded);
      retainedRecords.unshift(newest[index]);
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
    await this.persistCursors(terminalId, retainedRecords);
  }
}

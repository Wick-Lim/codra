import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { TerminalDescriptor } from "@codra/protocol";
import type { TerminalRepository } from "./contracts";

interface TerminalRow {
  id: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  state: TerminalDescriptor["state"];
  created_at: string;
  exit_code: number | null;
}

const terminalColumns = `
  id, title, cwd, cols, rows, state, created_at, exit_code
`;

function toDescriptor(row: TerminalRow): TerminalDescriptor {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    cols: row.cols,
    rows: row.rows,
    state: row.state,
    createdAt: row.created_at,
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
  };
}

export class SqliteTerminalRepository implements TerminalRepository {
  private readonly database: Database.Database;
  private readonly insert: Database.Statement;
  private readonly updateStatement: Database.Statement;
  private readonly listStatement: Database.Statement;
  private readonly markRunningExitedStatement: Database.Statement;
  private closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS terminals (
        id TEXT PRIMARY KEY,
        title TEXT,
        cwd TEXT,
        cols INTEGER,
        rows INTEGER,
        state TEXT,
        created_at TEXT,
        exit_code INTEGER
      )
    `);
    this.insert = this.database.prepare(`
      INSERT INTO terminals (${terminalColumns})
      VALUES (@id, @title, @cwd, @cols, @rows, @state, @createdAt, @exitCode)
    `);
    this.updateStatement = this.database.prepare(`
      UPDATE terminals
      SET title = @title,
          cwd = @cwd,
          cols = @cols,
          rows = @rows,
          state = @state,
          created_at = @createdAt,
          exit_code = @exitCode
      WHERE id = @id
    `);
    this.listStatement = this.database.prepare(`
      SELECT ${terminalColumns}
      FROM terminals
      ORDER BY created_at ASC, id ASC
    `);
    this.markRunningExitedStatement = this.database.prepare(`
      UPDATE terminals
      SET state = 'exited', exit_code = ?
      WHERE state = 'running'
    `);
  }

  async save(descriptor: TerminalDescriptor): Promise<void> {
    this.insert.run(this.toParameters(descriptor));
  }

  async update(descriptor: TerminalDescriptor): Promise<void> {
    this.updateStatement.run(this.toParameters(descriptor));
  }

  async list(): Promise<TerminalDescriptor[]> {
    return (this.listStatement.all() as TerminalRow[]).map(toDescriptor);
  }

  async markRunningExited(exitCode: number): Promise<void> {
    this.markRunningExitedStatement.run(exitCode);
  }

  journalMode(): string {
    return this.database.pragma("journal_mode", { simple: true }) as string;
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private toParameters(descriptor: TerminalDescriptor): Omit<
    TerminalDescriptor,
    "exitCode"
  > & {
    exitCode: number | null;
  } {
    return { ...descriptor, exitCode: descriptor.exitCode ?? null };
  }
}

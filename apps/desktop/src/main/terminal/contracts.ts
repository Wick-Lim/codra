import type {
  CreateTerminalRequest,
  TerminalDescriptor,
  TerminalOutputChunk,
} from "@codra/protocol";

export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exitCode: number) => void): () => void;
}

export interface PtyFactory {
  spawn(request: CreateTerminalRequest): PtyHandle;
}

export interface TerminalRepository {
  save(descriptor: TerminalDescriptor): Promise<void>;
  update(descriptor: TerminalDescriptor): Promise<void>;
  list(): Promise<TerminalDescriptor[]>;
  markRunningExited(exitCode: number): Promise<void>;
}

export interface TerminalOutputStore {
  append(terminalId: string, data: string): Promise<TerminalOutputChunk>;
  readAfter(
    terminalId: string,
    afterSequence: number,
    limit: number,
  ): Promise<TerminalOutputChunk[]>;
  remove(terminalId: string): Promise<void>;
}

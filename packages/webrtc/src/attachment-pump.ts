import {
  TERMINAL_FRAME_MAX_BYTES,
  encodeOutputFrameBinary,
  type TerminalOutputCursorReadResult,
} from "@codra/protocol";

export const DATA_CHANNEL_HIGH_WATERMARK = 1 * 1024 * 1024;
export const DATA_CHANNEL_LOW_WATERMARK = 256 * 1024;

export interface CursorOutputStore {
  readFromCursor(
    terminalId: string,
    afterCursor: bigint,
    maxBytes: number,
  ): Promise<TerminalOutputCursorReadResult>;
}

export interface BinaryOutputChannel {
  readonly bufferedAmount: number;
  send(value: ArrayBuffer): void;
}

export class AttachmentPump {
  private paused = false;
  private closed = false;
  private pumping = false;
  private acknowledgedCursor = 0n;
  private sentCursor = 0n;

  constructor(
    private readonly options: {
      terminalId: string;
      store: CursorOutputStore;
      channel: BinaryOutputChannel;
    },
  ) {}

  get lastAcknowledgedCursor(): bigint {
    return this.acknowledgedCursor;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  async pump(): Promise<void> {
    if (this.closed || this.pumping) return;
    if (this.options.channel.bufferedAmount >= DATA_CHANNEL_HIGH_WATERMARK) {
      this.paused = true;
      return;
    }
    this.pumping = true;
    try {
      const result = await this.options.store.readFromCursor(
        this.options.terminalId,
        this.acknowledgedCursor,
        TERMINAL_FRAME_MAX_BYTES,
      );
      for (const chunk of result.chunks) {
        if (
          this.closed ||
          this.options.channel.bufferedAmount >= DATA_CHANNEL_HIGH_WATERMARK
        ) {
          this.paused = true;
          break;
        }
        if (chunk.data.byteLength > TERMINAL_FRAME_MAX_BYTES)
          throw new Error("OUTPUT_FRAME_TOO_LARGE");
        this.options.channel.send(
          encodeOutputFrameBinary({
            terminalId: this.options.terminalId,
            cursor: chunk.startCursor,
            data: Uint8Array.from(chunk.data),
          }),
        );
        this.sentCursor =
          chunk.endCursor > this.sentCursor ? chunk.endCursor : this.sentCursor;
      }
      if (this.options.channel.bufferedAmount >= DATA_CHANNEL_HIGH_WATERMARK)
        this.paused = true;
    } finally {
      this.pumping = false;
    }
  }

  acknowledge(cursor: bigint): void {
    if (cursor < this.acknowledgedCursor || cursor > this.sentCursor)
      throw new Error("OUTPUT_CURSOR_INVALID");
    this.acknowledgedCursor = cursor;
  }

  async onBufferedAmountLow(): Promise<void> {
    if (this.options.channel.bufferedAmount > DATA_CHANNEL_LOW_WATERMARK)
      return;
    this.paused = false;
    await this.pump();
  }

  close(): void {
    this.closed = true;
    this.paused = true;
  }
}

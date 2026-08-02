import { SignalSchema, type Signal } from "@codra/protocol";

export interface SignalSequenceCollectorOptions {
  sessionId: string;
  negotiationId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  afterSequence?: number;
  verify?(signal: Signal): boolean | Promise<boolean>;
  onSignals(signals: Signal[]): void;
}

export class SignalSequenceCollector {
  private cursor: number;

  constructor(private readonly options: SignalSequenceCollectorOptions) {
    this.cursor = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(this.cursor) || this.cursor < 0) {
      throw new RangeError("Signal cursor must be a non-negative safe integer");
    }
  }

  get afterSequence(): number {
    return this.cursor;
  }

  async accept(rawSignals: readonly unknown[]): Promise<void> {
    const candidates = rawSignals
      .map((signal) => SignalSchema.parse(signal))
      .sort((left, right) => left.sequence - right.sequence);
    for (const signal of candidates) {
      if (
        signal.sessionId !== this.options.sessionId ||
        signal.negotiationId !== this.options.negotiationId ||
        signal.senderDeviceId !== this.options.senderDeviceId ||
        signal.recipientDeviceId !== this.options.recipientDeviceId
      ) {
        throw new Error("SIGNAL_BINDING_MISMATCH");
      }
    }

    const unseen = candidates.filter((signal) => signal.sequence > this.cursor);
    if (unseen.length === 0) return;
    let expected = this.cursor + 1;
    for (const signal of unseen) {
      if (signal.sequence !== expected) {
        throw new Error("SIGNAL_SEQUENCE_GAP");
      }
      if (this.options.verify && !(await this.options.verify(signal))) {
        throw new Error("SIGNAL_SIGNATURE_INVALID");
      }
      expected += 1;
    }

    this.cursor = unseen.at(-1)?.sequence ?? this.cursor;
    this.options.onSignals(unseen);
  }
}

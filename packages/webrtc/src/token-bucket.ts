import { TERMINAL_INPUT_MAX_UTF8_BYTES } from "@codra/protocol";

export interface TokenBucketOptions {
  now: () => number;
  capacity?: number;
  refillPerSecond?: number;
}

export class ByteTokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private available: number;
  private lastAt: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    this.now = options.now;
    this.capacity = options.capacity ?? 128 * 1024;
    this.refillPerSecond = options.refillPerSecond ?? 64 * 1024;
    this.available = this.capacity;
    this.lastAt = this.now();
  }

  get tokens(): number {
    this.refill();
    return this.available;
  }

  tryConsumeUtf8(value: string): boolean {
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > TERMINAL_INPUT_MAX_UTF8_BYTES) return false;
    return this.tryConsume(bytes);
  }

  tryConsume(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    this.refill();
    if (bytes > this.available) return false;
    this.available -= bytes;
    return true;
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastAt) / 1000;
    this.available = Math.min(
      this.capacity,
      this.available + elapsed * this.refillPerSecond,
    );
    this.lastAt = current;
  }
}

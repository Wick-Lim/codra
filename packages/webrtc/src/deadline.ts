export interface TimerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimerClock: TimerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class NegotiationDeadline {
  private handle: unknown;

  constructor(
    private readonly clock: TimerClock = systemTimerClock,
    private readonly timeoutMs = 20_000,
  ) {}

  arm(onTimeout: () => void): void {
    this.cancel();
    this.handle = this.clock.setTimeout(onTimeout, this.timeoutMs);
  }

  cancel(): void {
    if (this.handle !== undefined) {
      this.clock.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}

export class PingWatchdog {
  private lastPongAt: number;
  private handle: unknown;

  constructor(
    private readonly clock: TimerClock = systemTimerClock,
    private readonly intervalMs = 5_000,
    private readonly missedLimit = 3,
  ) {
    this.lastPongAt = clock.now();
  }

  pong(): void {
    this.lastPongAt = this.clock.now();
  }

  start(onTimeout: () => void): void {
    this.stop();
    const check = (): void => {
      if (
        this.clock.now() - this.lastPongAt >=
        this.intervalMs * this.missedLimit
      ) {
        onTimeout();
        return;
      }
      this.handle = this.clock.setTimeout(check, this.intervalMs);
    };
    this.handle = this.clock.setTimeout(check, this.intervalMs);
  }

  stop(): void {
    if (this.handle !== undefined) {
      this.clock.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}

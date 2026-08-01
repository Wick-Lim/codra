export class TerminalShutdownError extends Error {
  constructor() {
    super("Terminal operations are unavailable while Codra is shutting down.");
    this.name = "TerminalShutdownError";
  }
}

export interface TerminalRequestAdmission {
  run<T>(operation: () => Promise<T> | T): Promise<T>;
  close(): void;
  reopen(): void;
  drain(): Promise<void>;
  isClosed(): boolean;
}

export class TerminalAdmissionGate implements TerminalRequestAdmission {
  private closed = false;
  private readonly inFlight = new Set<Promise<void>>();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new TerminalShutdownError());

    let request: Promise<T>;
    try {
      request = Promise.resolve(operation());
    } catch (error) {
      request = Promise.reject(error);
    }
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(settled);
    void settled.then(() => this.inFlight.delete(settled));
    return request;
  }

  close(): void {
    this.closed = true;
  }

  reopen(): void {
    this.closed = false;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

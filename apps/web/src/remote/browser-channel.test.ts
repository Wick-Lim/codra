import { describe, expect, it } from "vitest";
import { DATA_CHANNEL_LOW_WATERMARK } from "@codra/webrtc";
import { adoptBrowserChannel } from "./browser-channel";

// `apps/web` has no vitest config, so Vitest inherits `vite.config.ts` and runs
// in the node environment, where `RTCDataChannel` does not exist. jsdom would
// not help — it implements no WebRTC either — so the channel is hand-rolled.
// The fake reproduces the browser behaviours the adapter has to defend against:
// `binaryType` really starts at `"blob"` and really decides whether a binary
// frame arrives as an `ArrayBuffer` or a `Blob`, `bufferedAmountLowThreshold`
// really starts at `0`, `readyState` is drivable, and `close()` only moves to
// `"closing"` without synchronously dispatching `close`.
class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  readonly sent: (ArrayBuffer | ArrayBufferView | Blob | string)[] = [];
  readonly binaryTypeAssignments: string[] = [];
  readonly thresholdAssignments: number[] = [];
  closeCalls = 0;
  private binaryTypeValue: "arraybuffer" | "blob" = "blob";
  private thresholdValue = 0;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly label: string) {}

  get binaryType(): "arraybuffer" | "blob" {
    return this.binaryTypeValue;
  }

  set binaryType(value: "arraybuffer" | "blob") {
    this.binaryTypeValue = value;
    this.binaryTypeAssignments.push(value);
  }

  get bufferedAmountLowThreshold(): number {
    return this.thresholdValue;
  }

  set bufferedAmountLowThreshold(value: number) {
    this.thresholdValue = value;
    this.thresholdAssignments.push(value);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing =
      this.listeners.get(type) ?? new Set<(event: Event) => void>();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: ArrayBuffer | ArrayBufferView | Blob | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    // A real RTCDataChannel.close() moves to "closing" and dispatches "close"
    // later, off the caller's stack. Never synchronously.
    if (this.readyState !== "closed") this.readyState = "closing";
  }

  markOpen(): void {
    this.readyState = "open";
    this.dispatch("open", new Event("open"));
  }

  markClosed(): void {
    this.readyState = "closed";
    this.dispatch("close", new Event("close"));
  }

  deliverText(text: string): void {
    this.dispatch("message", new MessageEvent("message", { data: text }));
  }

  // Honours `binaryType` exactly as a browser does: an unpatched channel hands
  // the application a Blob, which is precisely the defect the adapter prevents.
  deliverBinary(bytes: Uint8Array<ArrayBuffer>): void {
    const data: unknown =
      this.binaryTypeValue === "arraybuffer"
        ? bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          )
        : new Blob([bytes]);
    this.dispatch("message", new MessageEvent("message", { data }));
  }

  deliverError(message: string): void {
    const event = new Event("error");
    // RTCErrorEvent carries a readonly `error: RTCError`, and RTCError extends
    // DOMException. There is no RTCErrorEvent constructor outside a browser.
    Object.defineProperty(event, "error", {
      value: Object.assign(new DOMException(message, "OperationError"), {
        errorDetail: "sctp-failure",
      }),
    });
    this.dispatch("error", event);
  }

  deliverBufferedAmountLow(): void {
    this.dispatch("bufferedamountlow", new Event("bufferedamountlow"));
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(event);
  }
}

function adopt(channel: FakeDataChannel) {
  return adoptBrowserChannel(channel as unknown as RTCDataChannel);
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe("browser data channel adapter", () => {
  it("switches binaryType off the browser default so binary frames arrive as ArrayBuffer", () => {
    const channel = new FakeDataChannel("codra-terminal");
    expect(channel.binaryType).toBe("blob");

    const port = adopt(channel);
    const received: unknown[] = [];
    port.onMessage((message) => received.push(message));
    channel.deliverBinary(new Uint8Array([1, 2, 3]));

    expect(channel.binaryType).toBe("arraybuffer");
    expect(channel.binaryTypeAssignments).toEqual(["arraybuffer"]);
    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(received[0] as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("raises bufferedAmountLowThreshold to the pump watermark so bufferedamountlow can fire", () => {
    const channel = new FakeDataChannel("codra-terminal");
    expect(channel.bufferedAmountLowThreshold).toBe(0);

    adopt(channel);

    expect(channel.bufferedAmountLowThreshold).toBe(DATA_CHANNEL_LOW_WATERMARK);
    expect(channel.thresholdAssignments).toEqual([DATA_CHANNEL_LOW_WATERMARK]);
    expect(channel.bufferedAmountLowThreshold).toBeGreaterThan(0);
  });

  it("delivers onOpen on a microtask when the channel opened before the listener registered", async () => {
    const channel = new FakeDataChannel("codra-control");
    channel.markOpen();
    const port = adopt(channel);
    let opens = 0;

    port.onOpen(() => {
      opens += 1;
    });

    expect(opens).toBe(0);
    await flushMicrotasks();
    expect(opens).toBe(1);
  });

  it("keeps the both-channels-ready gate reachable when the second channel opened early", async () => {
    const control = new FakeDataChannel("codra-control");
    const terminal = new FakeDataChannel("codra-terminal");
    const controlPort = adopt(control);
    // The terminal channel opens while PeerNegotiationSession is still busy
    // registering the control channel, so nothing is listening to it yet.
    terminal.markOpen();
    const terminalPort = adopt(terminal);
    const open = { control: false, terminal: false };
    controlPort.onOpen(() => {
      open.control = true;
    });
    terminalPort.onOpen(() => {
      open.terminal = true;
    });

    control.markOpen();
    await flushMicrotasks();

    expect(open).toEqual({ control: true, terminal: true });
  });

  it("does not replay onOpen for a channel that has not opened yet", async () => {
    const channel = new FakeDataChannel("codra-control");
    const port = adopt(channel);
    const events: string[] = [];
    port.onOpen(() => events.push("open"));

    await flushMicrotasks();
    expect(events).toEqual([]);

    channel.markOpen();
    await flushMicrotasks();
    expect(events).toEqual(["open"]);
  });

  it("forwards the reliability shape and label untouched", () => {
    const channel = new FakeDataChannel("codra-control");
    channel.bufferedAmount = 4096;

    const port = adopt(channel);

    expect(port.label).toBe("codra-control");
    expect(port.ordered).toBe(true);
    expect(port.maxRetransmits).toBeNull();
    expect(port.maxPacketLifeTime).toBeNull();
    expect(port.bufferedAmount).toBe(4096);
    channel.bufferedAmount = 0;
    expect(port.bufferedAmount).toBe(0);
  });

  it("relays open, close, message and bufferedamountlow events", () => {
    const channel = new FakeDataChannel("codra-control");
    const port = adopt(channel);
    const events: string[] = [];
    port.onOpen(() => events.push("open"));
    port.onClosed(() => events.push("closed"));
    port.onMessage((message) => events.push(`message:${String(message)}`));
    port.onBufferedAmountLow(() => events.push("low"));

    channel.markOpen();
    channel.deliverText("payload");
    channel.deliverBufferedAmountLow();
    channel.markClosed();

    expect(events).toEqual(["open", "message:payload", "low", "closed"]);
  });

  it("wraps RTCErrorEvent into an Error carrying the original as cause", () => {
    const channel = new FakeDataChannel("codra-control");
    const port = adopt(channel);
    const errors: Error[] = [];
    port.onError((error) => errors.push(error));

    channel.deliverError("sctp transport failed");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe("sctp transport failed");
    expect(errors[0].cause).toBeInstanceOf(DOMException);
  });

  it("reports an unsupported payload as an error instead of handing a Blob to the decoders", () => {
    const channel = new FakeDataChannel("codra-terminal");
    const port = adopt(channel);
    const messages: unknown[] = [];
    const errors: Error[] = [];
    port.onMessage((message) => messages.push(message));
    port.onError((error) => errors.push(error));

    // Simulates any path that puts binaryType back to the browser default.
    channel.binaryType = "blob";
    channel.deliverBinary(new Uint8Array([9]));

    expect(messages).toEqual([]);
    expect(errors.map((error) => error.message)).toEqual([
      "REMOTE_DATA_CHANNEL_MESSAGE_UNSUPPORTED",
    ]);
  });

  it("forwards strings, ArrayBuffers and views to the underlying channel", () => {
    const channel = new FakeDataChannel("codra-terminal");
    const port = adopt(channel);
    const buffer = new Uint8Array([7, 8]).buffer;

    port.send("text");
    port.send(buffer);
    port.send(new Uint8Array([1]));

    expect(channel.sent).toEqual(["text", buffer, new Uint8Array([1])]);
  });

  it("returns a working unsubscribe from every listener registration", () => {
    const channel = new FakeDataChannel("codra-control");
    const port = adopt(channel);
    const events: string[] = [];
    const stops = [
      port.onOpen(() => events.push("open")),
      port.onClosed(() => events.push("closed")),
      port.onError((error) => events.push(error.message)),
      port.onMessage((message) => events.push(`message:${String(message)}`)),
      port.onBufferedAmountLow(() => events.push("low")),
    ];
    // A second subscriber per event proves unsubscribing removes exactly one.
    port.onOpen(() => events.push("open-2"));
    port.onClosed(() => events.push("closed-2"));
    port.onError(() => events.push("error-2"));
    port.onMessage(() => events.push("message-2"));
    port.onBufferedAmountLow(() => events.push("low-2"));

    for (const stop of stops) stop();
    channel.markOpen();
    channel.deliverText("payload");
    channel.deliverError("broken");
    channel.deliverBufferedAmountLow();
    channel.markClosed();

    expect(events).toEqual([
      "open-2",
      "message-2",
      "error-2",
      "low-2",
      "closed-2",
    ]);
  });

  it("closes the underlying channel once, drops listeners and refuses further sends", () => {
    const channel = new FakeDataChannel("codra-control");
    const port = adopt(channel);
    const events: string[] = [];
    port.onClosed(() => events.push("closed"));
    port.onMessage(() => events.push("message"));

    port.close();
    port.close();

    expect(channel.closeCalls).toBe(1);
    expect(channel.readyState).toBe("closing");
    expect(() => port.send("late")).toThrow("REMOTE_DATA_CHANNEL_CLOSED");
    expect(channel.sent).toEqual([]);

    channel.markClosed();
    channel.deliverText("late");
    expect(events).toEqual([]);
  });
});

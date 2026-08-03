import { DATA_CHANNEL_LOW_WATERMARK } from "@codra/webrtc";
import type { PeerChannelPort } from "@codra/remote-client";

class ListenerSet<T extends (...arguments_: never[]) => void> {
  private readonly listeners = new Set<T>();

  add(listener: T): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(...arguments_: Parameters<T>): void {
    for (const listener of [...this.listeners]) listener(...arguments_);
  }

  clear(): void {
    this.listeners.clear();
  }
}

function toChannelError(event: RTCErrorEvent): Error {
  const detail: RTCError | undefined = event.error;
  const message =
    typeof detail?.message === "string" ? detail.message.trim() : "";
  return new Error(message.length > 0 ? message : "REMOTE_DATA_CHANNEL_ERROR", {
    cause: detail,
  });
}

class BrowserChannelAdapter implements PeerChannelPort {
  private readonly openListeners = new ListenerSet<() => void>();
  private readonly closedListeners = new ListenerSet<() => void>();
  private readonly errorListeners = new ListenerSet<(error: Error) => void>();
  private readonly messageListeners = new ListenerSet<
    (message: ArrayBuffer | Uint8Array | string) => void
  >();
  private readonly bufferedAmountLowListeners = new ListenerSet<() => void>();
  private closed = false;

  constructor(private readonly channel: RTCDataChannel) {
    // Browsers default to "blob", which would hand decodeRemoteControlMessage
    // and decodeOutputFrameBinary a Blob they cannot read synchronously.
    channel.binaryType = "arraybuffer";
    // The default threshold is 0, so "bufferedamountlow" fires only once the
    // send buffer fully drains — effectively never under a live output pump.
    // AttachmentPump paces against the same watermark it resumes on.
    channel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATERMARK;
    channel.addEventListener("open", () => this.openListeners.emit());
    channel.addEventListener("close", () => this.closedListeners.emit());
    channel.addEventListener("error", (event) =>
      this.errorListeners.emit(toChannelError(event)),
    );
    channel.addEventListener("message", (event) =>
      this.deliverMessage(event.data),
    );
    channel.addEventListener("bufferedamountlow", () =>
      this.bufferedAmountLowListeners.emit(),
    );
  }

  get label(): string {
    return this.channel.label;
  }

  get ordered(): boolean {
    return this.channel.ordered;
  }

  get maxRetransmits(): number | null {
    return this.channel.maxRetransmits;
  }

  get maxPacketLifeTime(): number | null {
    return this.channel.maxPacketLifeTime;
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (this.closed) throw new Error("REMOTE_DATA_CHANNEL_CLOSED");
    // Split rather than unioned: `RTCDataChannel.send` is overloaded, and a
    // `string | ArrayBuffer` argument matches no single overload.
    if (typeof data === "string") {
      this.channel.send(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.channel.send(data);
      return;
    }
    // TypeScript types a bare `Uint8Array` as `Uint8Array<ArrayBufferLike>`,
    // which admits SharedArrayBuffer, while `RTCDataChannel.send` only accepts
    // a view over a plain ArrayBuffer. Re-viewing the same bytes keeps the
    // common path zero-copy; a shared buffer is copied out instead.
    const { buffer, byteOffset, byteLength } = data;
    this.channel.send(
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer, byteOffset, byteLength)
        : new Uint8Array(data),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    this.openListeners.clear();
    this.closedListeners.clear();
    this.errorListeners.clear();
    this.messageListeners.clear();
    this.bufferedAmountLowListeners.clear();
  }

  onOpen(listener: () => void): () => void {
    const stop = this.openListeners.add(listener);
    // The "open" event has already been and gone for a channel adopted after
    // it opened. Without this replay, PeerNegotiationSession's both-channels
    // gate never sees the second channel and the negotiation deadline fires.
    if (this.channel.readyState === "open") queueMicrotask(listener);
    return stop;
  }

  onClosed(listener: () => void): () => void {
    return this.closedListeners.add(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    return this.errorListeners.add(listener);
  }

  onMessage(
    listener: (message: ArrayBuffer | Uint8Array | string) => void,
  ): () => void {
    return this.messageListeners.add(listener);
  }

  onBufferedAmountLow(listener: () => void): () => void {
    return this.bufferedAmountLowListeners.add(listener);
  }

  private deliverMessage(data: unknown): void {
    if (typeof data === "string" || data instanceof ArrayBuffer) {
      this.messageListeners.emit(data);
      return;
    }
    if (data instanceof Uint8Array) {
      this.messageListeners.emit(data);
      return;
    }
    this.errorListeners.emit(
      new Error("REMOTE_DATA_CHANNEL_MESSAGE_UNSUPPORTED"),
    );
  }
}

export function adoptBrowserChannel(channel: RTCDataChannel): PeerChannelPort {
  return new BrowserChannelAdapter(channel);
}

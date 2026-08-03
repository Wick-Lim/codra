import { SignalSchema, type Signal } from "@codra/protocol";
import { describe, expect, it } from "vitest";
import {
  CONTROL_CHANNEL_LABEL,
  TERMINAL_CHANNEL_LABEL,
  PeerNegotiationSession,
  type PeerChannelPort,
  type PeerConnectionPort,
  type PeerNegotiationDeadline,
  type PeerSignalPort,
} from "./peer-session";

const sessionId = "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f";
const clientDeviceId = "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d";
const hostDeviceId = "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1";

class ChannelFake implements PeerChannelPort {
  readonly ordered = true;
  readonly maxRetransmits = null;
  readonly maxPacketLifeTime = null;
  bufferedAmount = 0;
  closed = false;
  readonly sent: Array<ArrayBuffer | Uint8Array | string> = [];
  private readonly openListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly messageListeners = new Set<
    (message: ArrayBuffer | Uint8Array | string) => void
  >();
  private readonly lowListeners = new Set<() => void>();

  constructor(readonly label: string) {}

  send(data: ArrayBuffer | Uint8Array | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onMessage(
    listener: (message: ArrayBuffer | Uint8Array | string) => void,
  ): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onBufferedAmountLow(listener: () => void): () => void {
    this.lowListeners.add(listener);
    return () => this.lowListeners.delete(listener);
  }

  emitOpen(): void {
    for (const listener of this.openListeners) listener();
  }
}

class PeerFake implements PeerConnectionPort {
  readonly createdChannels: ChannelFake[] = [];
  readonly localDescriptions: Array<"offer" | "answer"> = [];
  readonly remoteDescriptions: Array<{
    sdp: string;
    type: "offer" | "answer";
  }> = [];
  readonly remoteCandidates: Array<{ candidate: string; mid: string }> = [];
  closed = false;
  private localDescriptionListener?: (
    sdp: string,
    type: "offer" | "answer",
  ) => void;
  private localCandidateListener?: (candidate: string, mid: string) => void;
  private stateListener?: (state: string) => void;
  private gatheringListener?: (state: string) => void;
  private dataChannelListener?: (channel: PeerChannelPort) => void;

  createDataChannel(label: string): PeerChannelPort {
    const channel = new ChannelFake(label);
    this.createdChannels.push(channel);
    return channel;
  }

  setLocalDescription(type: "offer" | "answer"): void {
    this.localDescriptions.push(type);
  }

  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    this.remoteDescriptions.push({ sdp, type });
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    this.remoteCandidates.push({ candidate, mid });
  }

  onLocalDescription(
    listener: (sdp: string, type: "offer" | "answer") => void,
  ): void {
    this.localDescriptionListener = listener;
  }

  onLocalCandidate(listener: (candidate: string, mid: string) => void): void {
    this.localCandidateListener = listener;
  }

  onStateChange(listener: (state: string) => void): void {
    this.stateListener = listener;
  }

  onGatheringStateChange(listener: (state: string) => void): void {
    this.gatheringListener = listener;
  }

  onDataChannel(listener: (channel: PeerChannelPort) => void): void {
    this.dataChannelListener = listener;
  }

  close(): void {
    this.closed = true;
  }

  emitLocalDescription(sdp: string, type: "offer" | "answer"): void {
    this.localDescriptionListener?.(sdp, type);
  }

  emitLocalCandidate(candidate: string, mid: string): void {
    this.localCandidateListener?.(candidate, mid);
  }

  emitState(state: string): void {
    this.stateListener?.(state);
  }

  emitGathering(state: string): void {
    this.gatheringListener?.(state);
  }

  emitDataChannel(channel: PeerChannelPort): void {
    this.dataChannelListener?.(channel);
  }
}

class SignalFake implements PeerSignalPort {
  readonly published: Signal["payload"][] = [];
  closed = false;
  private onSignals?: (signals: Signal[]) => void;
  private onError?: (error: Error) => void;

  async publish(payload: Signal["payload"]): Promise<Signal> {
    this.published.push(payload);
    return incomingSignal(payload);
  }

  start(
    onSignals: (signals: Signal[]) => void,
    onError: (error: Error) => void,
  ): void {
    this.onSignals = onSignals;
    this.onError = onError;
  }

  close(): void {
    this.closed = true;
  }

  emit(signals: Signal[]): void {
    this.onSignals?.(signals);
  }

  emitError(error: Error): void {
    this.onError?.(error);
  }
}

class DeadlineFake implements PeerNegotiationDeadline {
  armed?: () => void;
  cancelled = false;

  arm(onTimeout: () => void): void {
    this.armed = onTimeout;
  }

  cancel(): void {
    this.cancelled = true;
    this.armed = undefined;
  }

  expire(): void {
    const callback = this.armed;
    this.armed = undefined;
    callback?.();
  }
}

function incomingSignal(payload: Signal["payload"]): Signal {
  return SignalSchema.parse({
    sessionId,
    negotiationId: "negotiation-1",
    senderDeviceId: hostDeviceId,
    recipientDeviceId: clientDeviceId,
    signerThumbprint: "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M",
    signerDeviceGeneration: 1,
    sequence: 1,
    kind: payload.type,
    payload,
    createdAt: 1,
    expiresAt: 2,
    signature: "A".repeat(86),
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("PeerNegotiationSession", () => {
  it("creates a client offer and publishes local SDP, ICE, and completion", async () => {
    const peer = new PeerFake();
    const signals = new SignalFake();
    const deadline = new DeadlineFake();
    const channels: Array<{
      control: PeerChannelPort;
      terminal: PeerChannelPort;
    }> = [];
    const errors: Error[] = [];
    const session = new PeerNegotiationSession({
      role: "client",
      peer,
      signals,
      deadline,
      onChannels: (value) => channels.push(value),
      onError: (error) => errors.push(error),
    });

    session.start();

    expect(peer.createdChannels.map((channel) => channel.label)).toEqual([
      CONTROL_CHANNEL_LABEL,
      TERMINAL_CHANNEL_LABEL,
    ]);
    expect(peer.localDescriptions).toEqual(["offer"]);
    peer.emitLocalDescription("v=0 client-offer", "offer");
    peer.emitLocalCandidate("candidate:client", "0");
    peer.emitGathering("complete");
    await flush();
    expect(signals.published).toEqual([
      { type: "offer", sdp: "v=0 client-offer" },
      {
        type: "candidate",
        candidate: "candidate:client",
        sdpMid: "0",
      },
      { type: "end-of-candidates" },
    ]);

    for (const channel of peer.createdChannels) channel.emitOpen();
    expect(channels).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("applies a verified answer and candidate only on the client", async () => {
    const peer = new PeerFake();
    const signals = new SignalFake();
    const errors: Error[] = [];
    const session = new PeerNegotiationSession({
      role: "client",
      peer,
      signals,
      deadline: new DeadlineFake(),
      onChannels: () => undefined,
      onError: (error) => errors.push(error),
    });
    session.start();

    signals.emit([
      incomingSignal({ type: "answer", sdp: "v=0 host-answer" }),
      incomingSignal({
        type: "candidate",
        candidate: "candidate:host",
        sdpMid: "0",
      }),
      incomingSignal({ type: "end-of-candidates" }),
    ]);
    await flush();

    expect(peer.remoteDescriptions).toEqual([
      { sdp: "v=0 host-answer", type: "answer" },
    ]);
    expect(peer.remoteCandidates).toEqual([
      { candidate: "candidate:host", mid: "0" },
    ]);
    expect(errors).toEqual([]);
  });

  it("accepts a host offer, creates an answer, and waits for both incoming channels", async () => {
    const peer = new PeerFake();
    const signals = new SignalFake();
    const channels: Array<{
      control: PeerChannelPort;
      terminal: PeerChannelPort;
    }> = [];
    const session = new PeerNegotiationSession({
      role: "host",
      peer,
      signals,
      deadline: new DeadlineFake(),
      onChannels: (value) => channels.push(value),
      onError: () => undefined,
    });
    session.start();

    signals.emit([incomingSignal({ type: "offer", sdp: "v=0 client-offer" })]);
    await flush();
    expect(peer.remoteDescriptions).toEqual([
      { sdp: "v=0 client-offer", type: "offer" },
    ]);
    expect(peer.localDescriptions).toEqual(["answer"]);

    const terminal = new ChannelFake(TERMINAL_CHANNEL_LABEL);
    const control = new ChannelFake(CONTROL_CHANNEL_LABEL);
    peer.emitDataChannel(terminal);
    peer.emitDataChannel(control);
    terminal.emitOpen();
    expect(channels).toEqual([]);
    control.emitOpen();
    expect(channels).toEqual([{ control, terminal }]);
  });

  it("closes all resources on invalid direction, failure, or negotiation timeout", async () => {
    const peer = new PeerFake();
    const signals = new SignalFake();
    const deadline = new DeadlineFake();
    const errors: Error[] = [];
    const session = new PeerNegotiationSession({
      role: "client",
      peer,
      signals,
      deadline,
      onChannels: () => undefined,
      onError: (error) => errors.push(error),
    });
    session.start();

    signals.emit([incomingSignal({ type: "offer", sdp: "wrong-direction" })]);
    await flush();
    expect(errors[0]?.message).toBe("UNEXPECTED_REMOTE_OFFER");
    expect(peer.closed).toBe(true);
    expect(signals.closed).toBe(true);

    const timedPeer = new PeerFake();
    const timedSignals = new SignalFake();
    const timedDeadline = new DeadlineFake();
    const timedErrors: Error[] = [];
    const timed = new PeerNegotiationSession({
      role: "host",
      peer: timedPeer,
      signals: timedSignals,
      deadline: timedDeadline,
      onChannels: () => undefined,
      onError: (error) => timedErrors.push(error),
    });
    timed.start();
    timedDeadline.expire();
    expect(timedErrors[0]?.message).toBe("REMOTE_NEGOTIATION_TIMEOUT");
    expect(timedPeer.closed).toBe(true);
    expect(timedSignals.closed).toBe(true);
  });

  it("cancels the negotiation deadline only after the peer connects", () => {
    const peer = new PeerFake();
    const deadline = new DeadlineFake();
    const session = new PeerNegotiationSession({
      role: "host",
      peer,
      signals: new SignalFake(),
      deadline,
      onChannels: () => undefined,
      onError: () => undefined,
    });
    session.start();

    expect(deadline.cancelled).toBe(false);
    peer.emitState("connected");
    expect(deadline.cancelled).toBe(true);
  });
});

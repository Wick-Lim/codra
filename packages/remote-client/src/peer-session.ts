import { SignalSchema, type Signal } from "@codra/protocol";
import {
  CONTROL_CHANNEL_LABEL,
  NegotiationDeadline,
  TERMINAL_CHANNEL_LABEL,
} from "@codra/webrtc";

export { CONTROL_CHANNEL_LABEL, TERMINAL_CHANNEL_LABEL };

export interface PeerChannelPort {
  readonly label: string;
  readonly ordered?: boolean;
  readonly maxRetransmits?: number | null;
  readonly maxPacketLifeTime?: number | null;
  readonly bufferedAmount: number;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(): void;
  onOpen(listener: () => void): () => void;
  onClosed(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onMessage(
    listener: (message: ArrayBuffer | Uint8Array | string) => void,
  ): () => void;
  onBufferedAmountLow(listener: () => void): () => void;
}

export interface PeerConnectionPort {
  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): PeerChannelPort;
  setLocalDescription(type: "offer" | "answer"): void;
  setRemoteDescription(sdp: string, type: "offer" | "answer"): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  onLocalDescription(
    listener: (sdp: string, type: "offer" | "answer") => void,
  ): void;
  onLocalCandidate(listener: (candidate: string, mid: string) => void): void;
  onStateChange(listener: (state: string) => void): void;
  onGatheringStateChange(listener: (state: string) => void): void;
  onDataChannel(listener: (channel: PeerChannelPort) => void): void;
  close(): void;
}

export interface PeerSignalPort {
  publish(payload: Signal["payload"]): Promise<Signal>;
  start(
    onSignals: (signals: Signal[]) => void,
    onError: (error: Error) => void,
  ): void;
  close(): void;
}

export interface PeerNegotiationDeadline {
  arm(onTimeout: () => void): void;
  cancel(): void;
}

export interface PeerChannels {
  control: PeerChannelPort;
  terminal: PeerChannelPort;
}

export interface PeerNegotiationSessionOptions {
  role: "client" | "host";
  peer: PeerConnectionPort;
  signals: PeerSignalPort;
  deadline?: PeerNegotiationDeadline;
  onChannels(channels: PeerChannels): void;
  onError(error: Error): void;
}

interface RegisteredChannel {
  channel: PeerChannelPort;
  open: boolean;
}

export class PeerNegotiationSession {
  private readonly deadline: PeerNegotiationDeadline;
  private control: RegisteredChannel | undefined;
  private terminal: RegisteredChannel | undefined;
  private started = false;
  private closed = false;
  private channelsDelivered = false;

  constructor(private readonly options: PeerNegotiationSessionOptions) {
    this.deadline = options.deadline ?? new NegotiationDeadline();
    options.peer.onLocalDescription((sdp, type) => {
      this.publishLocalDescription(sdp, type);
    });
    options.peer.onLocalCandidate((candidate, mid) => {
      this.publish({
        type: "candidate",
        candidate,
        sdpMid: mid,
      });
    });
    options.peer.onGatheringStateChange((state) => {
      if (state === "complete") this.publish({ type: "end-of-candidates" });
    });
    options.peer.onStateChange((state) => {
      if (state === "connected") {
        this.deadline.cancel();
      } else if (
        state === "failed" ||
        state === "disconnected" ||
        state === "closed"
      ) {
        this.fail(new Error(`REMOTE_PEER_${state.toUpperCase()}`));
      }
    });
    options.peer.onDataChannel((channel) => {
      if (this.options.role !== "host") {
        this.fail(new Error("UNEXPECTED_REMOTE_DATA_CHANNEL"));
        return;
      }
      this.registerChannel(channel);
    });
  }

  start(): void {
    if (this.closed) throw new Error("REMOTE_PEER_SESSION_CLOSED");
    if (this.started) throw new Error("REMOTE_PEER_SESSION_ALREADY_STARTED");
    this.started = true;
    this.options.signals.start(
      (signals) => {
        void this.acceptSignals(signals).catch((error: unknown) =>
          this.fail(
            error instanceof Error
              ? error
              : new Error("REMOTE_SIGNAL_PROCESSING_FAILED"),
          ),
        );
      },
      (error) => this.fail(error),
    );
    this.deadline.arm(() => {
      this.fail(new Error("REMOTE_NEGOTIATION_TIMEOUT"));
    });
    if (this.options.role === "client") {
      this.registerChannel(
        this.options.peer.createDataChannel(CONTROL_CHANNEL_LABEL, {
          ordered: true,
        }),
      );
      this.registerChannel(
        this.options.peer.createDataChannel(TERMINAL_CHANNEL_LABEL, {
          ordered: true,
        }),
      );
      this.options.peer.setLocalDescription("offer");
    }
  }

  async acceptSignals(rawSignals: readonly unknown[]): Promise<void> {
    if (this.closed) return;
    for (const rawSignal of rawSignals) {
      const signal = SignalSchema.parse(rawSignal);
      switch (signal.payload.type) {
        case "offer":
          if (this.options.role !== "host") {
            throw new Error("UNEXPECTED_REMOTE_OFFER");
          }
          this.options.peer.setRemoteDescription(signal.payload.sdp, "offer");
          this.options.peer.setLocalDescription("answer");
          break;
        case "answer":
          if (this.options.role !== "client") {
            throw new Error("UNEXPECTED_REMOTE_ANSWER");
          }
          this.options.peer.setRemoteDescription(signal.payload.sdp, "answer");
          break;
        case "candidate":
          this.options.peer.addRemoteCandidate(
            signal.payload.candidate,
            signal.payload.sdpMid ?? "0",
          );
          break;
        case "end-of-candidates":
          break;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deadline.cancel();
    this.control?.channel.close();
    this.terminal?.channel.close();
    this.options.signals.close();
    this.options.peer.close();
  }

  private publishLocalDescription(sdp: string, type: "offer" | "answer"): void {
    const expected = this.options.role === "client" ? "offer" : "answer";
    if (type !== expected) {
      this.fail(new Error("LOCAL_DESCRIPTION_ROLE_MISMATCH"));
      return;
    }
    this.publish({ type, sdp });
  }

  private publish(payload: Signal["payload"]): void {
    if (this.closed) return;
    void this.options.signals
      .publish(payload)
      .catch((error: unknown) =>
        this.fail(
          error instanceof Error
            ? error
            : new Error("REMOTE_SIGNAL_PUBLISH_FAILED"),
        ),
      );
  }

  private registerChannel(channel: PeerChannelPort): void {
    if (
      channel.ordered === false ||
      channel.maxRetransmits != null ||
      channel.maxPacketLifeTime != null
    ) {
      this.fail(new Error("REMOTE_DATA_CHANNEL_MUST_BE_RELIABLE_ORDERED"));
      return;
    }
    const registered: RegisteredChannel = { channel, open: false };
    if (channel.label === CONTROL_CHANNEL_LABEL) {
      if (this.control) {
        this.fail(new Error("DUPLICATE_REMOTE_CONTROL_CHANNEL"));
        return;
      }
      this.control = registered;
    } else if (channel.label === TERMINAL_CHANNEL_LABEL) {
      if (this.terminal) {
        this.fail(new Error("DUPLICATE_REMOTE_TERMINAL_CHANNEL"));
        return;
      }
      this.terminal = registered;
    } else {
      this.fail(new Error("REMOTE_DATA_CHANNEL_LABEL_MISMATCH"));
      return;
    }
    channel.onOpen(() => {
      registered.open = true;
      this.deliverChannelsWhenReady();
    });
    channel.onClosed(() => {
      this.fail(new Error("REMOTE_DATA_CHANNEL_CLOSED"));
    });
    channel.onError((error) => this.fail(error));
  }

  private deliverChannelsWhenReady(): void {
    if (
      this.closed ||
      this.channelsDelivered ||
      !this.control?.open ||
      !this.terminal?.open
    ) {
      return;
    }
    this.channelsDelivered = true;
    try {
      this.options.onChannels({
        control: this.control.channel,
        terminal: this.terminal.channel,
      });
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("REMOTE_CHANNEL_CONSUMER_FAILED"),
      );
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.options.onError(error);
  }
}

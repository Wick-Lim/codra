import {
  normalizeBrowserIceServers,
  normalizeHostIceServers,
  type IceServerInput,
} from "@codra/webrtc";
import type { DataChannel, PeerConnection, RtcConfig } from "node-datachannel";
import type { PeerChannelPort, PeerConnectionPort } from "@codra/remote-client";

export interface NativeDataChannelModule {
  readonly PeerConnection: new (
    peerName: string,
    configuration: RtcConfig,
  ) => PeerConnection;
}

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

class NativeChannelAdapter implements PeerChannelPort {
  readonly ordered = true;
  readonly maxRetransmits = null;
  readonly maxPacketLifeTime = null;
  private readonly openListeners = new ListenerSet<() => void>();
  private readonly closedListeners = new ListenerSet<() => void>();
  private readonly errorListeners = new ListenerSet<(error: Error) => void>();
  private readonly messageListeners = new ListenerSet<
    (message: ArrayBuffer | Uint8Array | string) => void
  >();
  private readonly bufferedAmountLowListeners = new ListenerSet<() => void>();
  private closed = false;

  constructor(private readonly native: DataChannel) {
    native.onOpen(() => this.openListeners.emit());
    native.onClosed(() => this.closedListeners.emit());
    native.onError((message) => this.errorListeners.emit(new Error(message)));
    native.onMessage((message) => this.messageListeners.emit(message));
    native.onBufferedAmountLow(() => this.bufferedAmountLowListeners.emit());
  }

  get label(): string {
    return this.native.getLabel();
  }

  get bufferedAmount(): number {
    return this.native.bufferedAmount();
  }

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (this.closed) throw new Error("REMOTE_DATA_CHANNEL_CLOSED");
    if (typeof data === "string") {
      this.native.sendMessage(data);
      return;
    }
    this.native.sendMessageBinary(
      data instanceof ArrayBuffer ? new Uint8Array(data) : data,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.native.close();
    this.openListeners.clear();
    this.closedListeners.clear();
    this.errorListeners.clear();
    this.messageListeners.clear();
    this.bufferedAmountLowListeners.clear();
  }

  onOpen(listener: () => void): () => void {
    const stop = this.openListeners.add(listener);
    if (this.native.isOpen()) queueMicrotask(listener);
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
}

class NativePeerAdapter implements PeerConnectionPort {
  private readonly channels = new WeakMap<DataChannel, NativeChannelAdapter>();
  private closed = false;

  constructor(private readonly native: PeerConnection) {}

  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): PeerChannelPort {
    return this.wrap(
      this.native.createDataChannel(label, {
        unordered: options?.ordered === false,
      }),
    );
  }

  setLocalDescription(type: "offer" | "answer"): void {
    this.native.setLocalDescription(type);
  }

  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    this.native.setRemoteDescription(sdp, type);
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    this.native.addRemoteCandidate(candidate, mid);
  }

  onLocalDescription(
    listener: (sdp: string, type: "offer" | "answer") => void,
  ): void {
    this.native.onLocalDescription((sdp, type) => {
      if (type === "offer" || type === "answer") listener(sdp, type);
    });
  }

  onLocalCandidate(listener: (candidate: string, mid: string) => void): void {
    this.native.onLocalCandidate(listener);
  }

  onStateChange(listener: (state: string) => void): void {
    this.native.onStateChange(listener);
  }

  onGatheringStateChange(listener: (state: string) => void): void {
    this.native.onGatheringStateChange(listener);
  }

  onDataChannel(listener: (channel: PeerChannelPort) => void): void {
    this.native.onDataChannel((channel) => listener(this.wrap(channel)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.native.close();
  }

  private wrap(channel: DataChannel): NativeChannelAdapter {
    const existing = this.channels.get(channel);
    if (existing) return existing;
    const adapter = new NativeChannelAdapter(channel);
    this.channels.set(channel, adapter);
    return adapter;
  }
}

export function createNativePeerConnection(
  module: NativeDataChannelModule,
  peerName: string,
  iceServerInputs: readonly IceServerInput[],
  options: { relayOnly: boolean } = { relayOnly: true },
): PeerConnectionPort {
  // The emulator path (DesktopPeerConnector.acquireIceServers) hands in no
  // ICE server inputs at all, since it never calls the TURN callable there.
  // normalizeBrowserIceServers rejects an empty list, so it is only invoked
  // when there is something to normalize; normalizeHostIceServers is then
  // called without `relayOnly` on that path, per the design, so an empty
  // UDP relay set does not throw HOST_TURN_UDP_UNAVAILABLE.
  const browserServers =
    iceServerInputs.length > 0
      ? normalizeBrowserIceServers(iceServerInputs)
      : [];
  const hostServers = options.relayOnly
    ? normalizeHostIceServers(browserServers, { relayOnly: true })
    : normalizeHostIceServers(browserServers);
  const configuration: RtcConfig = {
    iceServers: hostServers.map(
      ({ hostname, port, username, password, relayType }) => ({
        hostname,
        port,
        username,
        password,
        relayType,
      }),
    ),
    disableAutoNegotiation: true,
    enableIceTcp: false,
    iceTransportPolicy: options.relayOnly ? "relay" : "all",
  };
  return new NativePeerAdapter(
    new module.PeerConnection(peerName, configuration),
  );
}

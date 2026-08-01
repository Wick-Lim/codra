import {
  RemoteControlMessageSchema,
  encodeRemoteControlMessageBinary,
  type RemoteControlMessage,
} from "@codra/protocol";
import type {
  DataChannel as NativeNodeDataChannel,
  PeerConnection as NativeNodeDataChannelPeerConnection,
  RtcConfig as NativeNodeDataChannelConfig,
} from "node-datachannel";
import type { HostIceServer } from "./ice";

export const CONTROL_CHANNEL_LABEL = "codra.control.v1" as const;
export const TERMINAL_CHANNEL_LABEL = "codra.terminal.v1" as const;

export interface DataChannelLike {
  readonly label: string;
  readonly ordered?: boolean;
  readonly maxRetransmits?: number | null;
  readonly maxPacketLifeTime?: number | null;
  readonly bufferedAmount: number;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(): void;
}

export class ReliableOrderedChannel {
  private closed = false;

  constructor(
    readonly channel: DataChannelLike,
    readonly expectedLabel:
      typeof CONTROL_CHANNEL_LABEL | typeof TERMINAL_CHANNEL_LABEL,
  ) {
    if (channel.label !== expectedLabel)
      throw new Error("DATA_CHANNEL_LABEL_MISMATCH");
    if (channel.ordered === false)
      throw new Error("DATA_CHANNEL_MUST_BE_ORDERED");
    if (channel.maxRetransmits != null || channel.maxPacketLifeTime != null)
      throw new Error("DATA_CHANNEL_MUST_BE_RELIABLE");
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  sendControl(message: RemoteControlMessage): void {
    if (this.expectedLabel !== CONTROL_CHANNEL_LABEL)
      throw new Error("CONTROL_CHANNEL_REQUIRED");
    this.ensureOpen();
    this.channel.send(
      encodeRemoteControlMessageBinary(
        RemoteControlMessageSchema.parse(message),
      ),
    );
  }

  sendBinary(value: ArrayBuffer | Uint8Array): void {
    this.ensureOpen();
    this.channel.send(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("DATA_CHANNEL_CLOSED");
  }
}

export interface NodeDataChannelPeerPort {
  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): DataChannelLike;
  close(): void;
}

type NativeDataChannelPort = Pick<
  NativeNodeDataChannel,
  "getLabel" | "sendMessage" | "sendMessageBinary" | "bufferedAmount" | "close"
>;

class NativeDataChannelAdapter implements DataChannelLike {
  readonly ordered = true;
  readonly maxRetransmits = null;
  readonly maxPacketLifeTime = null;

  constructor(private readonly native: NativeDataChannelPort) {}

  get label(): string {
    return this.native.getLabel();
  }

  get bufferedAmount(): number {
    return this.native.bufferedAmount();
  }

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === "string") {
      this.native.sendMessage(data);
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.native.sendMessageBinary(bytes);
  }

  close(): void {
    this.native.close();
  }
}

interface NativeNodeDataChannelPeerPort extends Pick<
  NativeNodeDataChannelPeerConnection,
  "close"
> {
  createDataChannel(
    label: string,
    config?: { unordered?: boolean },
  ): NativeDataChannelPort;
}

class NativePeerAdapter implements NodeDataChannelPeerPort {
  constructor(private readonly native: NativeNodeDataChannelPeerPort) {}

  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): DataChannelLike {
    return new NativeDataChannelAdapter(
      this.native.createDataChannel(label, {
        // node-datachannel expresses ordering as the inverse of browser RTC.
        unordered: options?.ordered === false,
      }),
    );
  }

  close(): void {
    this.native.close();
  }
}

export interface NodeDataChannelModulePort {
  readonly PeerConnection: new (
    peerName: string,
    config: NativeNodeDataChannelConfig,
  ) => NativeNodeDataChannelPeerPort;
  cleanup(): void;
}

export function createNodeDataChannelHostPeer(
  module: NodeDataChannelModulePort,
  peerName: string,
  iceServers: readonly HostIceServer[],
): NodeDataChannelHostPeer {
  if (iceServers.length === 0) throw new Error("HOST_TURN_UDP_REQUIRED");
  if (
    iceServers.some(
      (server) =>
        server.relayType !== "TurnUdp" || server.transport !== "TurnUdp",
    )
  )
    throw new Error("HOST_TURN_UDP_REQUIRED");
  const config: NativeNodeDataChannelConfig = {
    iceServers: iceServers.map(({ hostname, port, username, password }) => ({
      hostname,
      port,
      username,
      password,
      relayType: "TurnUdp",
    })),
    iceTransportPolicy: "relay",
  };
  const peer = new module.PeerConnection(peerName, config);
  return new NodeDataChannelHostPeer(new NativePeerAdapter(peer), () =>
    module.cleanup(),
  );
}

export class NodeDataChannelHostPeer {
  private closed = false;
  private readonly channels = new Set<ReliableOrderedChannel>();

  constructor(
    readonly peer: NodeDataChannelPeerPort,
    private readonly cleanup?: () => void,
  ) {}

  createReliableChannels(): {
    control: ReliableOrderedChannel;
    terminal: ReliableOrderedChannel;
  } {
    if (this.closed) throw new Error("PEER_CLOSED");
    const control = new ReliableOrderedChannel(
      this.peer.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true }),
      CONTROL_CHANNEL_LABEL,
    );
    const terminal = new ReliableOrderedChannel(
      this.peer.createDataChannel(TERMINAL_CHANNEL_LABEL, { ordered: true }),
      TERMINAL_CHANNEL_LABEL,
    );
    this.channels.add(control);
    this.channels.add(terminal);
    return { control, terminal };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const channel of this.channels) channel.close();
    this.channels.clear();
    this.peer.close();
    this.cleanup?.();
  }
}

export interface BrowserPeerConnectionPort {
  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): DataChannelLike;
  close(): void;
}

export function createBrowserReliableChannels(
  peer: BrowserPeerConnectionPort,
): {
  control: ReliableOrderedChannel;
  terminal: ReliableOrderedChannel;
} {
  return {
    control: new ReliableOrderedChannel(
      peer.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true }),
      CONTROL_CHANNEL_LABEL,
    ),
    terminal: new ReliableOrderedChannel(
      peer.createDataChannel(TERMINAL_CHANNEL_LABEL, { ordered: true }),
      TERMINAL_CHANNEL_LABEL,
    ),
  };
}

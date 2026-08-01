import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_CHANNEL_LABEL,
  TERMINAL_CHANNEL_LABEL,
  createNodeDataChannelHostPeer,
  type NodeDataChannelModulePort,
} from "../src/channel";

describe("node-datachannel host adapter", () => {
  it("configures relay-only UDP and cleans up native channels/library", () => {
    const channel = (label: string) => ({
      getLabel: () => label,
      sendMessage: vi.fn(() => true),
      sendMessageBinary: vi.fn(() => true),
      bufferedAmount: vi.fn(() => 0),
      close: vi.fn(),
    });
    const nativePeer = {
      createDataChannel: vi.fn((label: string) => channel(label)),
      close: vi.fn(),
    };
    let peerConfig: unknown;
    const PeerConnection = class {
      constructor(_name: string, config: unknown) {
        peerConfig = config;
        return nativePeer;
      }
    } as unknown as NodeDataChannelModulePort["PeerConnection"];
    const module = {
      PeerConnection,
      cleanup: vi.fn(),
    } satisfies NodeDataChannelModulePort;
    const host = createNodeDataChannelHostPeer(module, "peer-1", [
      {
        url: "turn:turn.cloudflare.com:3478?transport=udp",
        hostname: "turn.cloudflare.com",
        port: 3478,
        username: "u",
        credential: "p",
        password: "p",
        relayType: "TurnUdp",
        transport: "TurnUdp",
      },
    ]);

    const channels = host.createReliableChannels();
    expect(nativePeer.createDataChannel).toHaveBeenNthCalledWith(
      1,
      CONTROL_CHANNEL_LABEL,
      { unordered: false },
    );
    expect(nativePeer.createDataChannel).toHaveBeenNthCalledWith(
      2,
      TERMINAL_CHANNEL_LABEL,
      { unordered: false },
    );
    expect(peerConfig).toMatchObject({ iceTransportPolicy: "relay" });
    expect(peerConfig).toMatchObject({
      iceServers: [
        {
          hostname: "turn.cloudflare.com",
          port: 3478,
          username: "u",
          password: "p",
          relayType: "TurnUdp",
        },
      ],
    });

    channels.control.close();
    host.close();
    expect(nativePeer.close).toHaveBeenCalledOnce();
    expect(module.cleanup).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createNativePeerConnection,
  type NativeDataChannelModule,
} from "./native-peer";

describe("native peer adapter", () => {
  it("uses only Cloudflare UDP relay and disables automatic negotiation", () => {
    let configuration: Record<string, unknown> | undefined;
    const nativePeer = createNativePeerFake();
    const module = {
      PeerConnection: class {
        constructor(_name: string, value: Record<string, unknown>) {
          configuration = value;
          return nativePeer;
        }
      },
    } as unknown as NativeDataChannelModule;

    createNativePeerConnection(module, "session-1", [
      {
        urls: "turn:turn.cloudflare.com:3478?transport=udp",
        username: "user",
        credential: "secret",
      },
      {
        urls: "turns:turn.cloudflare.com:5349?transport=tcp",
        username: "user",
        credential: "secret",
      },
    ]);

    expect(configuration).toMatchObject({
      disableAutoNegotiation: true,
      enableIceTcp: false,
      iceTransportPolicy: "relay",
      iceServers: [
        {
          hostname: "turn.cloudflare.com",
          port: 3478,
          username: "user",
          password: "secret",
          relayType: "TurnUdp",
        },
      ],
    });
  });

  it("adapts native peer and reliable channel callbacks", () => {
    const nativePeer = createNativePeerFake();
    const module = {
      PeerConnection: class {
        constructor() {
          return nativePeer;
        }
      },
    } as unknown as NativeDataChannelModule;
    const peer = createNativePeerConnection(module, "session-1", [
      {
        urls: "turn:turn.cloudflare.com:3478?transport=udp",
        username: "user",
        credential: "secret",
      },
    ]);
    const descriptions: unknown[] = [];
    const candidates: unknown[] = [];
    const states: string[] = [];
    const incoming: string[] = [];
    peer.onLocalDescription((sdp, type) => descriptions.push([sdp, type]));
    peer.onLocalCandidate((candidate, mid) =>
      candidates.push([candidate, mid]),
    );
    peer.onStateChange((state) => states.push(state));
    peer.onDataChannel((channel) => incoming.push(channel.label));

    nativePeer.emitLocalDescription("offer-sdp", "offer");
    nativePeer.emitLocalCandidate("candidate", "0");
    nativePeer.emitState("connected");
    nativePeer.emitDataChannel(createNativeChannelFake("incoming"));

    expect(descriptions).toEqual([["offer-sdp", "offer"]]);
    expect(candidates).toEqual([["candidate", "0"]]);
    expect(states).toEqual(["connected"]);
    expect(incoming).toEqual(["incoming"]);

    const channel = peer.createDataChannel("control", { ordered: true });
    const events: string[] = [];
    const stopMessages = channel.onMessage((message) =>
      events.push(String(message)),
    );
    channel.onOpen(() => events.push("open"));
    channel.onClosed(() => events.push("closed"));
    channel.onError((error) => events.push(error.message));
    channel.onBufferedAmountLow(() => events.push("low"));
    nativePeer.channel.emitOpen();
    nativePeer.channel.emitMessage("payload");
    stopMessages();
    nativePeer.channel.emitMessage("ignored");
    nativePeer.channel.emitError("broken");
    nativePeer.channel.emitBufferedAmountLow();
    nativePeer.channel.emitClosed();

    channel.send("text");
    channel.send(new Uint8Array([1, 2]));
    expect(events).toEqual(["open", "payload", "broken", "low", "closed"]);
    expect(nativePeer.channel.sendMessage).toHaveBeenCalledWith("text");
    expect(nativePeer.channel.sendMessageBinary).toHaveBeenCalledWith(
      new Uint8Array([1, 2]),
    );
    expect(channel.bufferedAmount).toBe(12);
  });

  it("negotiates the live Cloudflare TURN shape down to the single UDP relay it can use", () => {
    // This is the exact credentialed entry a live call to Cloudflare's
    // generate-ice-servers endpoint returns (values synthetic): six url
    // variants, one of which (`:53`) this client does not support. The
    // full pipeline — DesktopPeerConnector's iceInputs mapping, then
    // normalizeBrowserIceServers/normalizeHostIceServers — must still land
    // on exactly the one usable UDP relay entry, not throw.
    let configuration: Record<string, unknown> | undefined;
    const nativePeer = createNativePeerFake();
    const module = {
      PeerConnection: class {
        constructor(_name: string, value: Record<string, unknown>) {
          configuration = value;
          return nativePeer;
        }
      },
    } as unknown as NativeDataChannelModule;

    createNativePeerConnection(module, "session-1", [
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turn:turn.cloudflare.com:53?transport=udp",
          "turn:turn.cloudflare.com:80?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "synthetic-short-lived-user",
        credential: "synthetic-short-lived-password",
      },
    ]);

    expect(configuration).toMatchObject({
      iceTransportPolicy: "relay",
      iceServers: [
        {
          hostname: "turn.cloudflare.com",
          port: 3478,
          username: "synthetic-short-lived-user",
          password: "synthetic-short-lived-password",
          relayType: "TurnUdp",
        },
      ],
    });
  });

  it("rejects TURN sets without UDP relay", () => {
    const module = {
      PeerConnection: vi.fn(),
    } as unknown as NativeDataChannelModule;
    expect(() =>
      createNativePeerConnection(module, "session-1", [
        {
          urls: "turns:turn.cloudflare.com:5349?transport=tcp",
          username: "user",
          credential: "secret",
        },
      ]),
    ).toThrow("HOST_TURN_UDP_UNAVAILABLE");
  });

  it("gathers host candidates without any ICE server when relayOnly is false", () => {
    let configuration: Record<string, unknown> | undefined;
    const nativePeer = createNativePeerFake();
    const module = {
      PeerConnection: class {
        constructor(_name: string, value: Record<string, unknown>) {
          configuration = value;
          return nativePeer;
        }
      },
    } as unknown as NativeDataChannelModule;

    createNativePeerConnection(module, "session-1", [], {
      relayOnly: false,
    });

    expect(configuration).toMatchObject({
      disableAutoNegotiation: true,
      enableIceTcp: false,
      iceTransportPolicy: "all",
      iceServers: [],
    });
  });
});

function createNativeChannelFake(label: string) {
  let onOpen: (() => void) | undefined;
  let onClosed: (() => void) | undefined;
  let onError: ((error: string) => void) | undefined;
  let onMessage: ((message: string | ArrayBuffer) => void) | undefined;
  let onBufferedAmountLow: (() => void) | undefined;
  return {
    getLabel: () => label,
    isOpen: () => false,
    bufferedAmount: () => 12,
    close: vi.fn(),
    sendMessage: vi.fn(() => true),
    sendMessageBinary: vi.fn(() => true),
    onOpen: (listener: () => void) => {
      onOpen = listener;
    },
    onClosed: (listener: () => void) => {
      onClosed = listener;
    },
    onError: (listener: (error: string) => void) => {
      onError = listener;
    },
    onMessage: (listener: (message: string | ArrayBuffer) => void) => {
      onMessage = listener;
    },
    onBufferedAmountLow: (listener: () => void) => {
      onBufferedAmountLow = listener;
    },
    emitOpen: () => onOpen?.(),
    emitClosed: () => onClosed?.(),
    emitError: (error: string) => onError?.(error),
    emitMessage: (message: string | ArrayBuffer) => onMessage?.(message),
    emitBufferedAmountLow: () => onBufferedAmountLow?.(),
  };
}

function createNativePeerFake() {
  let onLocalDescription: ((sdp: string, type: string) => void) | undefined;
  let onLocalCandidate: ((candidate: string, mid: string) => void) | undefined;
  let onStateChange: ((state: string) => void) | undefined;
  let onGatheringStateChange: ((state: string) => void) | undefined;
  let onDataChannel:
    ((channel: ReturnType<typeof createNativeChannelFake>) => void) | undefined;
  const channel = createNativeChannelFake("control");
  return {
    channel,
    close: vi.fn(),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
    addRemoteCandidate: vi.fn(),
    createDataChannel: vi.fn(() => channel),
    onLocalDescription: (listener: (sdp: string, type: string) => void) => {
      onLocalDescription = listener;
    },
    onLocalCandidate: (listener: (candidate: string, mid: string) => void) => {
      onLocalCandidate = listener;
    },
    onStateChange: (listener: (state: string) => void) => {
      onStateChange = listener;
    },
    onGatheringStateChange: (listener: (state: string) => void) => {
      onGatheringStateChange = listener;
    },
    onDataChannel: (
      listener: (value: ReturnType<typeof createNativeChannelFake>) => void,
    ) => {
      onDataChannel = listener;
    },
    emitLocalDescription: (sdp: string, type: string) =>
      onLocalDescription?.(sdp, type),
    emitLocalCandidate: (candidate: string, mid: string) =>
      onLocalCandidate?.(candidate, mid),
    emitState: (state: string) => onStateChange?.(state),
    emitGathering: (state: string) => onGatheringStateChange?.(state),
    emitDataChannel: (value: ReturnType<typeof createNativeChannelFake>) =>
      onDataChannel?.(value),
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeerChannelPort } from "@codra/remote-client";
import { createBrowserPeerConnection } from "./browser-peer";

// `apps/web` has no vitest config, so Vitest inherits `vite.config.ts` and runs
// in the node environment, where `RTCPeerConnection` does not exist. jsdom would
// not help — it implements no WebRTC either — so the peer connection is
// hand-rolled, the same way `browser-channel.test.ts` hand-rolls the channel.
//
// The fake is faithful where faithfulness is load-bearing: every browser method
// is a real Promise that can be held open, `remoteDescription` only appears once
// `setRemoteDescription` resolves, `localDescription` is the *munged* SDP the
// connection adopted rather than the `createOffer()` result, `connectionState`
// and `iceConnectionState` move independently, and a closed connection throws
// `InvalidStateError` on any further use.

const OFFER_SDP =
  "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n";
// Browsers rewrite the description while applying it (ufrag, pwd, fingerprint),
// so the SDP that must be signalled is `pc.localDescription.sdp`, never the SDP
// `createOffer()` handed back.
const APPLIED_SUFFIX = "a=ice-ufrag:applied\r\n";
const REMOTE_SDP =
  "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n";
const REMOTE_SDP_OTHER_MID =
  "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\n";

// Vitest runs this file in node, where unhandled rejections are a process-level
// event. `@types/node` is not in this project's type graph, so the one member
// this file needs is declared locally rather than pulled in wholesale.
declare const process: {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
};

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;
  readonly promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  binaryType: "arraybuffer" | "blob" = "blob";
  bufferedAmountLowThreshold = 0;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly label: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing =
      this.listeners.get(type) ?? new Set<(event: Event) => void>();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {}

  close(): void {
    if (this.readyState !== "closed") this.readyState = "closing";
  }

  markOpen(): void {
    this.readyState = "open";
    for (const listener of [...(this.listeners.get("open") ?? [])])
      listener(new Event("open"));
  }
}

interface FakeIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  // Deliberately drivable on its own: a session that reads this instead of
  // `connectionState` sees "disconnected" during ordinary ICE churn.
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState: RTCSignalingState = "stable";
  readonly calls: string[] = [];
  readonly appliedCandidates: RTCIceCandidateInit[] = [];
  readonly createdChannels: {
    label: string;
    options: RTCDataChannelInit | undefined;
    channel: FakeDataChannel;
  }[] = [];
  closeCalls = 0;
  createOfferError: Error | undefined;
  createAnswerError: Error | undefined;
  setLocalDescriptionError: Error | undefined;
  setRemoteDescriptionError: Error | undefined;
  addIceCandidateError: Error | undefined;
  // When held, `addIceCandidate` / `setRemoteDescription` stay pending, which is
  // what makes ordering observable rather than merely non-lossy.
  manualIceCandidates = false;
  manualRemoteDescription = false;
  manualCreateOffer = false;
  readonly pendingIceCandidates: Deferred<void>[] = [];
  readonly pendingRemoteDescriptions: Deferred<void>[] = [];
  readonly pendingOffers: Deferred<void>[] = [];
  private closed = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly configuration: RTCConfiguration | undefined) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing =
      this.listeners.get(type) ?? new Set<(event: Event) => void>();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    // Recorded before the closed check so a call leaked past `close()` is
    // visible in `calls` rather than only in the rejection it produces.
    this.calls.push("createOffer");
    this.assertUsable("createOffer");
    if (this.createOfferError) throw this.createOfferError;
    if (this.manualCreateOffer) {
      const gate = new Deferred<void>();
      this.pendingOffers.push(gate);
      await gate.promise;
    }
    return { type: "offer", sdp: OFFER_SDP };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.calls.push("createAnswer");
    this.assertUsable("createAnswer");
    if (this.createAnswerError) throw this.createAnswerError;
    return { type: "answer", sdp: OFFER_SDP };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.calls.push("setLocalDescription");
    this.assertUsable("setLocalDescription");
    if (this.setLocalDescriptionError) throw this.setLocalDescriptionError;
    this.localDescription = {
      type: description.type,
      sdp: `${description.sdp ?? ""}${APPLIED_SUFFIX}`,
    };
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.calls.push("setRemoteDescription");
    this.assertUsable("setRemoteDescription");
    if (this.setRemoteDescriptionError) throw this.setRemoteDescriptionError;
    if (this.manualRemoteDescription) {
      const gate = new Deferred<void>();
      this.pendingRemoteDescriptions.push(gate);
      await gate.promise;
    }
    // A browser exposes `remoteDescription` only once the promise settles, so
    // anything racing it genuinely sees `null`.
    this.remoteDescription = { type: description.type, sdp: description.sdp };
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.calls.push("addIceCandidate");
    this.assertUsable("addIceCandidate");
    if (this.addIceCandidateError) throw this.addIceCandidateError;
    // Real browsers reject rather than buffer; the adapter must never get here
    // before a remote description exists.
    if (!this.remoteDescription)
      throw new DOMException(
        "addIceCandidate without a remote description",
        "InvalidStateError",
      );
    this.appliedCandidates.push(candidate);
    if (!this.manualIceCandidates) return;
    const gate = new Deferred<void>();
    this.pendingIceCandidates.push(gate);
    await gate.promise;
  }

  createDataChannel(
    label: string,
    options?: RTCDataChannelInit,
  ): FakeDataChannel {
    this.assertUsable("createDataChannel");
    this.calls.push("createDataChannel");
    const channel = new FakeDataChannel(label);
    this.createdChannels.push({ label, options, channel });
    return channel;
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    // A browser moves straight to "closed" without firing connectionstatechange.
    this.connectionState = "closed";
    this.signalingState = "closed";
  }

  releaseIceCandidate(): void {
    this.pendingIceCandidates.shift()?.resolve();
  }

  releaseRemoteDescription(): void {
    this.pendingRemoteDescriptions.shift()?.resolve();
  }

  releaseOffer(): void {
    this.pendingOffers.shift()?.resolve();
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatch("connectionstatechange", new Event("connectionstatechange"));
  }

  setIceConnectionState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.dispatch(
      "iceconnectionstatechange",
      new Event("iceconnectionstatechange"),
    );
  }

  setGatheringState(state: RTCIceGatheringState): void {
    this.iceGatheringState = state;
    this.dispatch(
      "icegatheringstatechange",
      new Event("icegatheringstatechange"),
    );
  }

  emitIceCandidate(candidate: FakeIceCandidate | null): void {
    const event = new Event("icecandidate");
    // RTCPeerConnectionIceEvent has no constructor outside a browser.
    Object.defineProperty(event, "candidate", {
      value:
        candidate === null
          ? null
          : { sdpMid: null, sdpMLineIndex: null, ...candidate },
    });
    this.dispatch("icecandidate", event);
  }

  emitDataChannel(channel: FakeDataChannel): void {
    const event = new Event("datachannel");
    Object.defineProperty(event, "channel", { value: channel });
    this.dispatch("datachannel", event);
  }

  private assertUsable(method: string): void {
    if (this.closed)
      throw new DOMException(
        `${method} on a closed RTCPeerConnection`,
        "InvalidStateError",
      );
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(event);
  }
}

function setup(
  iceServers: RTCIceServer[] = [],
  options: { relayOnly: boolean } = { relayOnly: true },
) {
  const created: FakePeerConnection[] = [];
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      constructor(configuration?: RTCConfiguration) {
        const peer = new FakePeerConnection(configuration);
        created.push(peer);
        return peer;
      }
    },
  );
  const port = createBrowserPeerConnection(iceServers, options);
  const pc = created[0];
  if (!pc) throw new Error("no peer connection was constructed");
  return { port, pc };
}

// Drains the whole microtask queue, however deep the adapter's promise chain is.
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function watchUnhandledRejections(): { stop: () => Promise<unknown[]> } {
  const reasons: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    stop: async () => {
      // Node reports an unhandled rejection a turn after the microtask queue
      // drains, so give it one.
      await settle();
      await settle();
      process.off("unhandledRejection", onUnhandled);
      return reasons;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser peer connection adapter", () => {
  it("queues remote candidates until the remote description lands, then applies them in order", async () => {
    const { port, pc } = setup();
    pc.manualIceCandidates = true;

    port.addRemoteCandidate("candidate:aaa 1 udp 1 10.0.0.1 1 typ relay", "0");
    port.addRemoteCandidate("candidate:bbb 1 udp 1 10.0.0.2 2 typ relay", "0");
    await settle();

    // Nothing applied and — crucially — nothing thrown away.
    expect(pc.appliedCandidates).toEqual([]);
    expect(pc.remoteDescription).toBeNull();
    expect(pc.calls).toEqual([]);

    port.setRemoteDescription(REMOTE_SDP, "answer");
    await settle();

    // Only the first is in flight: the second is serialised behind it, which is
    // what makes this an ordering assertion rather than a "both arrived" one.
    expect(pc.appliedCandidates.map((entry) => entry.candidate)).toEqual([
      "candidate:aaa 1 udp 1 10.0.0.1 1 typ relay",
    ]);

    pc.releaseIceCandidate();
    await settle();
    expect(pc.appliedCandidates.map((entry) => entry.candidate)).toEqual([
      "candidate:aaa 1 udp 1 10.0.0.1 1 typ relay",
      "candidate:bbb 1 udp 1 10.0.0.2 2 typ relay",
    ]);
    pc.releaseIceCandidate();
    await settle();

    expect(pc.appliedCandidates).toEqual([
      {
        candidate: "candidate:aaa 1 udp 1 10.0.0.1 1 typ relay",
        sdpMid: "0",
      },
      {
        candidate: "candidate:bbb 1 udp 1 10.0.0.2 2 typ relay",
        sdpMid: "0",
      },
    ]);
    expect(pc.calls).toEqual([
      "setRemoteDescription",
      "addIceCandidate",
      "addIceCandidate",
    ]);
  });

  it("keeps applying candidates in arrival order once the remote description is already set", async () => {
    const { port, pc } = setup();
    port.setRemoteDescription(REMOTE_SDP, "answer");
    await settle();

    port.addRemoteCandidate("candidate:first", "0");
    port.addRemoteCandidate("candidate:second", "0");
    port.addRemoteCandidate("candidate:third", "0");
    await settle();

    expect(pc.appliedCandidates.map((entry) => entry.candidate)).toEqual([
      "candidate:first",
      "candidate:second",
      "candidate:third",
    ]);
  });

  it("indexes the data section positionally when the host's SDP does not declare the signalled mid", async () => {
    const { port, pc } = setup();
    // PeerNegotiationSession substitutes "0" for a signal with no sdpMid, but
    // this host named its only m-section "data".
    port.setRemoteDescription(REMOTE_SDP_OTHER_MID, "answer");
    port.addRemoteCandidate("candidate:relay", "0");
    port.addRemoteCandidate("candidate:matching", "data");
    await settle();

    expect(pc.appliedCandidates).toEqual([
      { candidate: "candidate:relay", sdpMLineIndex: 0 },
      { candidate: "candidate:matching", sdpMid: "data" },
    ]);
  });

  it("synthesises onLocalDescription from the description the connection adopted", async () => {
    const { port, pc } = setup();
    const descriptions: [string, string][] = [];
    port.onLocalDescription((sdp, type) => descriptions.push([sdp, type]));

    port.setLocalDescription("offer");
    // The browser API is asynchronous; the port method is not.
    expect(descriptions).toEqual([]);
    await settle();

    expect(pc.calls).toEqual(["createOffer", "setLocalDescription"]);
    // `pc.localDescription`, not the `createOffer()` result: the browser
    // rewrites the SDP while applying it, and the rewritten one is what the
    // peer must receive.
    expect(descriptions).toEqual([[`${OFFER_SDP}${APPLIED_SUFFIX}`, "offer"]]);
  });

  it("answers with createAnswer and reports the answer type", async () => {
    const { port, pc } = setup();
    const descriptions: [string, string][] = [];
    port.onLocalDescription((sdp, type) => descriptions.push([sdp, type]));

    port.setLocalDescription("answer");
    await settle();

    expect(pc.calls).toEqual(["createAnswer", "setLocalDescription"]);
    expect(descriptions).toEqual([[`${OFFER_SDP}${APPLIED_SUFFIX}`, "answer"]]);
  });

  it("serialises a local answer behind the remote description it answers", async () => {
    const { port, pc } = setup();
    pc.manualRemoteDescription = true;
    const descriptions: [string, string][] = [];
    port.onLocalDescription((sdp, type) => descriptions.push([sdp, type]));

    // The host path: PeerNegotiationSession issues both calls back to back
    // (peer-session.ts:164-165) and cannot await either.
    port.setRemoteDescription(REMOTE_SDP, "offer");
    port.setLocalDescription("answer");
    await settle();

    expect(pc.calls).toEqual(["setRemoteDescription"]);
    expect(descriptions).toEqual([]);

    pc.releaseRemoteDescription();
    await settle();

    expect(pc.calls).toEqual([
      "setRemoteDescription",
      "createAnswer",
      "setLocalDescription",
    ]);
    expect(descriptions).toHaveLength(1);
  });

  it("routes a rejected setLocalDescription into onStateChange rather than leaving it unhandled", async () => {
    const { port, pc } = setup();
    pc.createOfferError = new Error("NotSupportedError");
    const states: string[] = [];
    port.onStateChange((state) => states.push(state));
    const watcher = watchUnhandledRejections();

    port.setLocalDescription("offer");
    await settle();

    expect(states).toEqual(["failed"]);
    expect(await watcher.stop()).toEqual([]);
  });

  it("routes a rejected setRemoteDescription into onStateChange and stops the queued candidates", async () => {
    const { port, pc } = setup();
    pc.setRemoteDescriptionError = new Error("InvalidAccessError");
    const states: string[] = [];
    port.onStateChange((state) => states.push(state));
    const watcher = watchUnhandledRejections();

    port.addRemoteCandidate("candidate:early", "0");
    port.setRemoteDescription(REMOTE_SDP, "answer");
    port.addRemoteCandidate("candidate:late", "0");
    await settle();

    // One failure, not one per queued operation: the rest of the negotiation
    // is dead and further browser calls would only cascade.
    expect(states).toEqual(["failed"]);
    expect(pc.appliedCandidates).toEqual([]);
    expect(await watcher.stop()).toEqual([]);
  });

  it("routes a rejected addIceCandidate into onStateChange and abandons the rest of the queue", async () => {
    const { port, pc } = setup();
    pc.addIceCandidateError = new Error("OperationError");
    const states: string[] = [];
    port.onStateChange((state) => states.push(state));
    const watcher = watchUnhandledRejections();

    port.setRemoteDescription(REMOTE_SDP, "answer");
    port.addRemoteCandidate("candidate:broken", "0");
    port.addRemoteCandidate("candidate:never-tried", "0");
    await settle();

    // The first failure ends the negotiation; retrying the remaining
    // candidates against a peer that already refused one only cascades.
    expect(states).toEqual(["failed"]);
    expect(pc.calls).toEqual(["setRemoteDescription", "addIceCandidate"]);
    expect(await watcher.stop()).toEqual([]);
  });

  it("drives onStateChange from connectionState and ignores iceConnectionState", () => {
    const { port, pc } = setup();
    const states: string[] = [];
    port.onStateChange((state) => states.push(state));

    // ICE reports a transient "disconnected" during ordinary churn, which
    // PeerNegotiationSession would turn into REMOTE_PEER_DISCONNECTED and use
    // to tear down a healthy session.
    pc.setIceConnectionState("disconnected");
    pc.setIceConnectionState("failed");
    expect(states).toEqual([]);

    pc.setConnectionState("connecting");
    pc.setConnectionState("connected");
    pc.setConnectionState("failed");

    expect(states).toEqual(["connecting", "connected", "failed"]);
  });

  it("reports the gathering state PeerNegotiationSession tests for", () => {
    const { port, pc } = setup();
    const states: string[] = [];
    port.onGatheringStateChange((state) => states.push(state));

    pc.setGatheringState("gathering");
    pc.setGatheringState("complete");

    expect(states).toEqual(["gathering", "complete"]);
  });

  it("forwards local candidates with their mid and swallows the end-of-gathering markers", () => {
    const { port, pc } = setup();
    const candidates: [string, string][] = [];
    port.onLocalCandidate((candidate, mid) =>
      candidates.push([candidate, mid]),
    );

    pc.emitIceCandidate({ candidate: "candidate:relay", sdpMid: "0" });
    // Null and empty-string candidates both mean "gathering finished". Either
    // would fail SignalPayloadSchema, whose `candidate` is `.min(1)`.
    pc.emitIceCandidate(null);
    pc.emitIceCandidate({ candidate: "", sdpMid: "0" });
    // No mid: fall back to the m-line index rather than inventing one.
    pc.emitIceCandidate({ candidate: "candidate:indexed", sdpMLineIndex: 1 });

    expect(candidates).toEqual([
      ["candidate:relay", "0"],
      ["candidate:indexed", "1"],
    ]);
  });

  it("creates ordered channels without the node-datachannel flag inversion", () => {
    const { port, pc } = setup();

    const control = port.createDataChannel("codra-control", { ordered: true });
    port.createDataChannel("codra-terminal");

    expect(
      pc.createdChannels.map((entry) => [entry.label, entry.options]),
    ).toEqual([
      ["codra-control", { ordered: true }],
      ["codra-terminal", { ordered: true }],
    ]);
    // Adopted through browser-channel.ts rather than a second adapter: only
    // that one moves binaryType off the browser default.
    expect(pc.createdChannels[0]?.channel.binaryType).toBe("arraybuffer");
    expect(control.label).toBe("codra-control");
    expect(control.ordered).toBe(true);
  });

  it("adopts an incoming data channel through the same channel adapter", () => {
    const { port, pc } = setup();
    const channels: PeerChannelPort[] = [];
    port.onDataChannel((channel) => channels.push(channel));

    const incoming = new FakeDataChannel("codra-control");
    pc.emitDataChannel(incoming);

    expect(channels.map((channel) => channel.label)).toEqual(["codra-control"]);
    expect(incoming.binaryType).toBe("arraybuffer");
    expect(incoming.bufferedAmountLowThreshold).toBeGreaterThan(0);
  });

  it("closes once, drops listeners and issues nothing further to a closed connection", async () => {
    const { port, pc } = setup();
    const states: string[] = [];
    const descriptions: string[] = [];
    port.onStateChange((state) => states.push(state));
    port.onLocalDescription((sdp) => descriptions.push(sdp));
    const watcher = watchUnhandledRejections();

    port.close();
    port.close();

    expect(pc.closeCalls).toBe(1);

    // The fake throws InvalidStateError on any use after close, exactly as a
    // browser does, so a leaked operation would surface as a routed failure.
    port.setLocalDescription("offer");
    port.setRemoteDescription(REMOTE_SDP, "answer");
    port.addRemoteCandidate("candidate:late", "0");
    await settle();

    expect(pc.calls).toEqual([]);
    expect(descriptions).toEqual([]);
    pc.setConnectionState("failed");
    expect(states).toEqual([]);
    expect(await watcher.stop()).toEqual([]);
  });

  it("does not apply a local description that was created before the session closed", async () => {
    const { port, pc } = setup();
    pc.manualCreateOffer = true;
    const descriptions: string[] = [];
    port.onLocalDescription((sdp) => descriptions.push(sdp));
    const watcher = watchUnhandledRejections();

    port.setLocalDescription("offer");
    await settle();
    expect(pc.calls).toEqual(["createOffer"]);

    // Creating the offer and applying it are two round trips; the negotiation
    // deadline can fire in between.
    port.close();
    pc.releaseOffer();
    await settle();

    expect(pc.calls).toEqual(["createOffer"]);
    expect(descriptions).toEqual([]);
    expect(await watcher.stop()).toEqual([]);
  });

  it("abandons an in-flight operation when the session closes underneath it", async () => {
    const { port, pc } = setup();
    pc.manualRemoteDescription = true;
    const states: string[] = [];
    port.onStateChange((state) => states.push(state));
    const watcher = watchUnhandledRejections();

    port.setRemoteDescription(REMOTE_SDP, "answer");
    port.addRemoteCandidate("candidate:late", "0");
    await settle();
    // PeerNegotiationSession.close() runs while setRemoteDescription is still
    // pending — the negotiation deadline is the usual reason.
    port.close();
    pc.releaseRemoteDescription();
    await settle();

    // The candidate queued behind the pending description is dropped with it,
    // rather than being applied to a connection that is already closed.
    expect(pc.calls).toEqual(["setRemoteDescription"]);
    expect(pc.appliedCandidates).toEqual([]);
    expect(states).toEqual([]);
    expect(await watcher.stop()).toEqual([]);
  });

  it("configures a relay-only connection with the caller's ICE servers", () => {
    const iceServers: RTCIceServer[] = [
      {
        urls: "turn:turn.example.com:3478?transport=udp",
        username: "user",
        credential: "secret",
      },
    ];
    const { pc } = setup(iceServers, { relayOnly: true });

    expect(pc.configuration).toEqual({
      iceServers,
      iceTransportPolicy: "relay",
    });
    // Passed through untouched: normalization belongs to the caller.
    expect(pc.configuration?.iceServers).toBe(iceServers);
  });

  it("allows every transport when relayOnly is false", () => {
    const { pc } = setup([], { relayOnly: false });

    expect(pc.configuration).toEqual({
      iceServers: [],
      iceTransportPolicy: "all",
    });
  });
});

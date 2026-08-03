import type { PeerChannelPort, PeerConnectionPort } from "@codra/remote-client";
import { adoptBrowserChannel } from "./browser-channel";

// A local copy of the listener set `native-peer.ts` and `browser-channel.ts`
// each keep. `PeerConnectionPort`'s registration methods return `void`, so no
// unsubscribe handle is needed here — only the ability to drop every listener
// when the connection closes.
class ListenerSet<T extends (...arguments_: never[]) => void> {
  private readonly listeners = new Set<T>();

  add(listener: T): void {
    this.listeners.add(listener);
  }

  emit(...arguments_: Parameters<T>): void {
    for (const listener of [...this.listeners]) listener(...arguments_);
  }

  clear(): void {
    this.listeners.clear();
  }
}

interface PendingCandidate {
  candidate: string;
  mid: string;
}

const MID_PREFIX = "a=mid:";

function sdpDeclaresMid(sdp: string, mid: string): boolean {
  return sdp
    .split(/\r\n|\r|\n/u)
    .some(
      (line) =>
        line.startsWith(MID_PREFIX) &&
        line.slice(MID_PREFIX.length).trim() === mid,
    );
}

/**
 * Adapts the browser's Promise-based `RTCPeerConnection` to the synchronous,
 * void-returning `PeerConnectionPort` that `PeerNegotiationSession` drives.
 *
 * Two things follow from that shape and drive everything below.
 *
 * 1. Every browser call has to be enqueued rather than awaited by the caller,
 *    so the adapter owns a single promise chain. Serialising on one chain is
 *    what keeps `setRemoteDescription` ahead of the candidates that depend on
 *    it, whatever order the signals arrive in.
 * 2. The port has no error return and no error listener, so a rejected browser
 *    promise has exactly one legal exit: the state listener. Anything else
 *    would either surface as an unhandled rejection or hang the negotiation
 *    until its deadline fires.
 */
class BrowserPeerAdapter implements PeerConnectionPort {
  private readonly localDescriptionListeners = new ListenerSet<
    (sdp: string, type: "offer" | "answer") => void
  >();
  private readonly localCandidateListeners = new ListenerSet<
    (candidate: string, mid: string) => void
  >();
  private readonly stateListeners = new ListenerSet<(state: string) => void>();
  private readonly gatheringStateListeners = new ListenerSet<
    (state: string) => void
  >();
  private readonly dataChannelListeners = new ListenerSet<
    (channel: PeerChannelPort) => void
  >();
  private readonly pendingCandidates: PendingCandidate[] = [];
  private operations: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private closed = false;

  constructor(private readonly pc: RTCPeerConnection) {
    // `addEventListener` rather than the `on*` properties: a property
    // assignment silently replaces whatever else took the same slot.
    pc.addEventListener("icecandidate", (event) => {
      const candidate = event.candidate;
      // A null candidate — and, in some browsers, an empty candidate string —
      // is the end-of-gathering marker. PeerNegotiationSession learns about
      // that from the gathering state instead, and publishing it here would be
      // rejected by SignalPayloadSchema, whose `candidate` is `.min(1)`.
      if (!candidate || candidate.candidate.length === 0) return;
      this.localCandidateListeners.emit(
        candidate.candidate,
        // Browsers always populate `sdpMid` for a candidate they generated;
        // the index fallback keeps the mid honest if one ever does not, since
        // the host feeds this value straight back into `addRemoteCandidate`.
        candidate.sdpMid ?? String(candidate.sdpMLineIndex ?? 0),
      );
    });
    pc.addEventListener("icegatheringstatechange", () => {
      this.gatheringStateListeners.emit(pc.iceGatheringState);
    });
    // `connectionState`, never `iceConnectionState`. Its vocabulary is the one
    // PeerNegotiationSession tests (peer-session.ts:101-111), and the ICE-level
    // state reports a transient "disconnected" during ordinary churn, which
    // would tear down a healthy session.
    pc.addEventListener("connectionstatechange", () => {
      this.stateListeners.emit(pc.connectionState);
    });
    pc.addEventListener("datachannel", (event) => {
      this.dataChannelListeners.emit(adoptBrowserChannel(event.channel));
    });
  }

  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): PeerChannelPort {
    // node-datachannel takes `{ unordered }`, so `native-peer.ts` inverts the
    // flag. The browser takes `{ ordered }` directly; inverting it here would
    // create an unordered channel and trip the reliability assertion at
    // peer-session.ts:218-224.
    return adoptBrowserChannel(
      this.pc.createDataChannel(label, { ordered: options?.ordered !== false }),
    );
  }

  setLocalDescription(type: "offer" | "answer"): void {
    this.enqueue(async () => {
      const description =
        type === "offer"
          ? await this.pc.createOffer()
          : await this.pc.createAnswer();
      // Creating a description and applying it are two round trips, and the
      // session can close between them — the negotiation deadline is the usual
      // reason. Applying it then would only produce an InvalidStateError.
      if (this.inactive) return;
      await this.pc.setLocalDescription(description);
      // The browser fires no local-description event, so it is synthesised
      // here. The SDP that must be signalled is the one the connection
      // actually adopted — browsers rewrite the description while applying it
      // — not the `createOffer()`/`createAnswer()` result. A description that
      // lands after close is emitted into an already-cleared listener set.
      const local = this.pc.localDescription;
      if (!local || (local.type !== "offer" && local.type !== "answer"))
        throw new Error("REMOTE_LOCAL_DESCRIPTION_UNAVAILABLE");
      this.localDescriptionListeners.emit(local.sdp, local.type);
    });
  }

  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    this.enqueue(async () => {
      await this.pc.setRemoteDescription({ type, sdp });
      await this.flushPendingCandidates();
    });
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    // Always queued, never applied inline. `addIceCandidate` rejects with
    // InvalidStateError before a remote description exists, and a signalling
    // race puts candidates ahead of the answer often enough that dropping them
    // would show up as an ICE failure with no visible cause.
    this.pendingCandidates.push({ candidate, mid });
    this.enqueue(() => this.flushPendingCandidates());
  }

  onLocalDescription(
    listener: (sdp: string, type: "offer" | "answer") => void,
  ): void {
    this.localDescriptionListeners.add(listener);
  }

  onLocalCandidate(listener: (candidate: string, mid: string) => void): void {
    this.localCandidateListeners.add(listener);
  }

  onStateChange(listener: (state: string) => void): void {
    this.stateListeners.add(listener);
  }

  onGatheringStateChange(listener: (state: string) => void): void {
    this.gatheringStateListeners.add(listener);
  }

  onDataChannel(listener: (channel: PeerChannelPort) => void): void {
    this.dataChannelListeners.add(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingCandidates.length = 0;
    this.pc.close();
    this.localDescriptionListeners.clear();
    this.localCandidateListeners.clear();
    this.stateListeners.clear();
    this.gatheringStateListeners.clear();
    this.dataChannelListeners.clear();
  }

  private get inactive(): boolean {
    return this.closed || this.failure !== undefined;
  }

  private async flushPendingCandidates(): Promise<void> {
    // Runs only inside the operation chain, so a flush never overlaps another
    // flush and the queue drains strictly in arrival order. A drain in
    // progress is stopped by `close()` emptying the queue, and a rejection
    // stops it by unwinding out of this loop into the chain's catch.
    if (!this.pc.remoteDescription) return;
    for (;;) {
      const pending = this.pendingCandidates.shift();
      if (!pending) return;
      await this.pc.addIceCandidate(this.toCandidateInit(pending));
    }
  }

  private toCandidateInit({
    candidate,
    mid,
  }: PendingCandidate): RTCIceCandidateInit {
    // node-datachannel labels its data section `a=mid:0`, and
    // PeerNegotiationSession substitutes the literal "0" for any signal that
    // carries no sdpMid at all (peer-session.ts:174-177). If the host's SDP
    // names that section anything else, `addIceCandidate` rejects the mid as
    // matching no m-line — so index the section positionally instead. The
    // negotiation is data-only, so there is exactly one m-section.
    const sdp = this.pc.remoteDescription?.sdp ?? "";
    return sdpDeclaresMid(sdp, mid)
      ? { candidate, sdpMid: mid }
      : { candidate, sdpMLineIndex: 0 };
  }

  private enqueue(work: () => Promise<void>): void {
    this.operations = this.operations
      .then(async () => {
        // Checked here rather than at call time: an operation can be queued
        // while the one ahead of it is still in flight, and the connection can
        // close or fail in between.
        if (this.inactive) return;
        await work();
      })
      .catch((error: unknown) => {
        this.routeFailure(error);
      });
  }

  private routeFailure(error: unknown): void {
    if (this.inactive) return;
    // Kept so the first failure short-circuits every queued operation behind
    // it: once a description or a candidate has been refused, the rest of the
    // negotiation is dead and further browser calls would only cascade.
    this.failure =
      error instanceof Error
        ? error
        : new Error("REMOTE_PEER_OPERATION_FAILED", { cause: error });
    // The single legal exit for a rejection. PeerNegotiationSession turns this
    // into REMOTE_PEER_FAILED and closes the session (peer-session.ts:104-110).
    this.stateListeners.emit("failed");
  }
}

export function createBrowserPeerConnection(
  iceServers: RTCIceServer[],
  options: { relayOnly: boolean },
): PeerConnectionPort {
  // Mirrors native-peer.ts:196-210, minus the two node-datachannel-only knobs:
  // the browser never auto-negotiates on its own here (nothing listens to
  // `negotiationneeded`), and ICE-TCP is governed by which TURN urls the caller
  // passes rather than by a flag. The caller normalizes credentials into flat
  // RTCIceServer entries; this function does not reshape them.
  const configuration: RTCConfiguration = {
    iceServers,
    // "relay" discards host and server-reflexive candidates outright, which is
    // what every production session uses.
    iceTransportPolicy: options.relayOnly ? "relay" : "all",
  };
  return new BrowserPeerAdapter(new RTCPeerConnection(configuration));
}

import {
  REMOTE_SESSION_MAX_LEASE_MS,
  RemoteSessionSchema,
  SIGNAL_LEASE_MS,
  SignalSchema,
  buildSignalSigningPayload,
  encodeBase64Url,
  type RemoteSession,
  type Signal,
} from "@codra/protocol";
import { signCanonical, verifyCanonical } from "@codra/webrtc";
import { describe, expect, it } from "vitest";
import {
  SignedSignalTransport,
  type SignalSubscription,
  type SignalTransportBackend,
} from "./signal-transport";

const clientDeviceId = "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d";
const hostDeviceId = "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1";
const clientThumbprint = "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M";
const hostThumbprint = "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo";
const negotiationId = "negotiation-1";
const now = 1_700_000_000_100;

function approvedSession(expiresAt: number = now + 60 * 60 * 1000) {
  return RemoteSessionSchema.parse({
    sessionId: "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f",
    ownerUid: "owner-uid",
    clientDeviceId,
    hostDeviceId,
    clientKeyThumbprint: clientThumbprint,
    hostKeyThumbprint: hostThumbprint,
    clientDeviceGeneration: 1,
    hostDeviceGeneration: 2,
    protocolVersion: 1,
    requestedScopes: ["workspace.read"],
    approvedScopes: ["workspace.read"],
    clientChallenge: "client-challenge",
    hostChallenge: "host-challenge",
    requestSignature: "A".repeat(86),
    approvalSignature: "A".repeat(86),
    createdAt: now - 100,
    decidedAt: now - 50,
    expiresAt,
    status: "approved",
  });
}

class BackendFake implements SignalTransportBackend {
  readonly published: Signal[] = [];
  subscription?: SignalSubscription;
  unsubscribed = false;

  async publish(signal: Signal): Promise<Signal> {
    this.published.push(SignalSchema.parse(signal));
    return signal;
  }

  subscribe(subscription: SignalSubscription): () => void {
    this.subscription = subscription;
    return () => {
      this.unsubscribed = true;
    };
  }
}

/**
 * Replays `publishSignal` at `functions/src/index.ts:489-504`: the Cloud
 * Function overwrites `createdAt`, clamps `expiresAt` to
 * `min(input.expiresAt, serverNow + SIGNAL_LEASE_MS)`, and only *then* verifies
 * the signature — over the clamped object. `buildSignalSigningPayload` covers
 * `expiresAtMillis`, so a signed lease past the clamp boundary is rewritten out
 * from under its own signature and the server answers
 * `SIGNAL_SIGNATURE_INVALID`.
 */
async function replayServerClampThenVerify(
  signal: Signal,
  serverNow: number,
  publicKey: CryptoKey,
): Promise<boolean> {
  const clamped = SignalSchema.parse({
    ...signal,
    createdAt: serverNow,
    expiresAt: Math.min(signal.expiresAt, serverNow + SIGNAL_LEASE_MS),
  });
  return verifyCanonical(
    publicKey,
    clamped.signature,
    buildSignalSigningPayload(clamped),
  );
}

async function createHarness(session: RemoteSession = approvedSession()) {
  const clientKeys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const hostKeys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const backend = new BackendFake();
  const transport = new SignedSignalTransport({
    session,
    negotiationId,
    local: {
      deviceId: clientDeviceId,
      keyThumbprint: clientThumbprint,
      generation: 1,
      privateKey: clientKeys.privateKey,
    },
    peer: {
      deviceId: hostDeviceId,
      keyThumbprint: hostThumbprint,
      generation: 2,
      publicKey: hostKeys.publicKey,
    },
    backend,
    now: () => now,
  });
  return { transport, backend, clientKeys, hostKeys };
}

describe("SignedSignalTransport", () => {
  it("serializes locally signed signals with contiguous sequence numbers", async () => {
    const harness = await createHarness();

    await Promise.all([
      harness.transport.publish({ type: "offer", sdp: "v=0 offer" }),
      harness.transport.publish({
        type: "candidate",
        candidate: "candidate:1",
        sdpMid: "0",
      }),
    ]);

    expect(harness.backend.published.map((signal) => signal.sequence)).toEqual([
      1, 2,
    ]);
    expect(harness.backend.published.map((signal) => signal.kind)).toEqual([
      "offer",
      "candidate",
    ]);
    for (const signal of harness.backend.published) {
      await expect(
        verifyCanonical(
          harness.clientKeys.publicKey,
          signal.signature,
          buildSignalSigningPayload(signal),
        ),
      ).resolves.toBe(true);
      expect(signal.senderDeviceId).toBe(clientDeviceId);
      expect(signal.recipientDeviceId).toBe(hostDeviceId);
    }
  });

  it("verifies the bound peer signature before delivering incoming signals", async () => {
    const harness = await createHarness();
    const received: Signal[] = [];
    const errors: Error[] = [];
    harness.transport.start(
      (signals) => received.push(...signals),
      (error) => errors.push(error),
    );
    const unsigned = {
      sessionId: approvedSession().sessionId,
      negotiationId,
      senderDeviceId: hostDeviceId,
      recipientDeviceId: clientDeviceId,
      signerThumbprint: hostThumbprint,
      signerDeviceGeneration: 2,
      sequence: 1,
      kind: "answer" as const,
      payload: { type: "answer" as const, sdp: "v=0 answer" },
      createdAt: now,
      expiresAt: now + 60_000,
      signature: "A".repeat(86),
    };
    const incoming = SignalSchema.parse({
      ...unsigned,
      signature: await signCanonical(
        harness.hostKeys.privateKey,
        buildSignalSigningPayload(unsigned),
      ),
    });

    await expect(
      harness.backend.subscription?.verify?.(incoming),
    ).resolves.toBe(true);
    harness.backend.subscription?.onSignals([incoming]);

    expect(received).toEqual([incoming]);
    expect(errors).toEqual([]);
    await expect(
      harness.backend.subscription?.verify?.({
        ...incoming,
        sequence: 2,
        signature: encodeBase64Url(new Uint8Array(64).fill(1)),
      }),
    ).rejects.toThrow("SIGNAL_SIGNATURE_INVALID");
  });

  it("stops the live subscription without publishing or delivering more data", async () => {
    const harness = await createHarness();
    const received: Signal[] = [];
    harness.transport.start(
      (signals) => received.push(...signals),
      () => undefined,
    );

    harness.transport.close();
    harness.backend.subscription?.onSignals([]);

    expect(harness.backend.unsubscribed).toBe(true);
    expect(received).toEqual([]);
    await expect(
      harness.transport.publish({ type: "end-of-candidates" }),
    ).rejects.toThrow("SIGNAL_TRANSPORT_CLOSED");
  });

  it("never signs a lease longer than SIGNAL_LEASE_MS even when the session lease is the schema maximum", async () => {
    const harness = await createHarness(
      approvedSession(now - 100 + REMOTE_SESSION_MAX_LEASE_MS),
    );

    await harness.transport.publish({ type: "offer", sdp: "v=0 offer" });

    const signal = harness.backend.published[0];
    expect(signal.createdAt).toBe(now);
    expect(signal.expiresAt).toBe(now + SIGNAL_LEASE_MS);
    expect(signal.expiresAt - signal.createdAt).toBeLessThanOrEqual(
      SIGNAL_LEASE_MS,
    );
  });

  it("keeps its signature valid across the publishSignal expiresAt clamp, which runs before verification", async () => {
    // A 15-minute session lease is what DesktopPeerConnector requests
    // (CLIENT_SESSION_LEASE_MS), so `session.expiresAt` — not the one-hour
    // signal lease — is the binding term and the server's clamp is a no-op.
    const harness = await createHarness(approvedSession(now + 15 * 60 * 1000));
    await harness.transport.publish({ type: "offer", sdp: "v=0 offer" });
    const signal = harness.backend.published[0];
    expect(signal.expiresAt).toBe(now + 15 * 60 * 1000);

    await expect(
      replayServerClampThenVerify(
        signal,
        now - 60_000,
        harness.clientKeys.publicKey,
      ),
    ).resolves.toBe(true);

    // The clamp precedes verification, so a lease one millisecond past the
    // server's boundary is rewritten and the signature no longer covers what
    // the server checks. This is why the transport must never emit one.
    const overLease = {
      ...signal,
      expiresAt: signal.createdAt + SIGNAL_LEASE_MS,
    };
    const signedOverLease = SignalSchema.parse({
      ...overLease,
      signature: await signCanonical(
        harness.clientKeys.privateKey,
        buildSignalSigningPayload(SignalSchema.parse(overLease)),
      ),
    });
    await expect(
      replayServerClampThenVerify(
        signedOverLease,
        signal.createdAt - 1,
        harness.clientKeys.publicKey,
      ),
    ).resolves.toBe(false);
  });
});

import {
  RemoteSessionSchema,
  SignalSchema,
  buildSignalSigningPayload,
  encodeBase64Url,
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

function approvedSession() {
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
    expiresAt: now + 60 * 60 * 1000,
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

async function createHarness() {
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
    session: approvedSession(),
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
});

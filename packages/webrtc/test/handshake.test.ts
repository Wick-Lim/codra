import { describe, expect, it } from "vitest";
import { createDeviceIdentity } from "../src/identity";
import { HandshakeGate } from "../src/handshake";
import { signCanonical } from "../src/canonical-crypto";

describe("mutual handshake", () => {
  it("starts locked and clears authorization when negotiation changes", () => {
    const gate = new HandshakeGate({ role: "browser", negotiationId: "n1" });
    expect(gate.authorized).toBe(false);
    gate.reset("n2");
    expect(gate.authorized).toBe(false);
  });

  it("signs and verifies the exact hello acknowledgement payload", async () => {
    const client = await createDeviceIdentity();
    const host = await createDeviceIdentity();
    const helloUnsigned = {
      type: "hello" as const,
      domain: "codra.hello.v1" as const,
      protocolVersion: 1 as const,
      sessionId: "11111111-1111-4111-8111-111111111111",
      negotiationId: "negotiation-1",
      clientDeviceId: "22222222-2222-4222-8222-222222222222",
      hostDeviceId: "33333333-3333-4333-8333-333333333333",
      clientKeyThumbprint: client.keyThumbprint,
      hostKeyThumbprint: host.keyThumbprint,
      clientDeviceGeneration: 1,
      hostDeviceGeneration: 1,
      clientChallenge: "client-challenge",
      hostChallenge: "host-challenge",
    };
    const hello = {
      ...helloUnsigned,
      signature: await signCanonical(client.privateKey, helloUnsigned),
    };
    const hostGate = new HandshakeGate({
      role: "host",
      negotiationId: hello.negotiationId,
      sessionId: hello.sessionId,
      signer: host.privateKey,
      publicKeyResolver: async (thumbprint) =>
        thumbprint === client.keyThumbprint ? client.publicKey : undefined,
    });
    const ack = await hostGate.acceptClientHello(hello);
    expect(ack.domain).toBe("codra.hello.v1");

    const browserGate = new HandshakeGate({
      role: "browser",
      negotiationId: hello.negotiationId,
      sessionId: hello.sessionId,
      publicKeyResolver: async (thumbprint) =>
        thumbprint === host.keyThumbprint ? host.publicKey : undefined,
    });
    await browserGate.verifyHelloAck(ack, hello);
    expect(browserGate.authorized).toBe(true);
  });
});

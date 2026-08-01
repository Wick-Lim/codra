import { describe, expect, it } from "vitest";
import { SignalVerifier } from "../src/signal-verifier";

describe("signal verifier", () => {
  it("starts each directional negotiation cursor at one", () => {
    const verifier = new SignalVerifier({
      sessionId: "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f",
      negotiationId: "negotiation-1",
      senderDeviceId: "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d",
      recipientDeviceId: "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1",
      publicKeyResolver: async () => undefined,
      now: () => 1_700_000_000_000,
    });
    expect(verifier.cursor).toBe(0);
  });
});

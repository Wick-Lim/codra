import { describe, expect, it } from "vitest";
import { createDeviceIdentity } from "../src/identity";

describe("webrtc identity", () => {
  it("creates a P-256 identity with an RFC 7638 thumbprint", async () => {
    const identity = await createDeviceIdentity();
    expect(identity.publicKeyJwk.crv).toBe("P-256");
    expect(identity.publicKeyJwk.kty).toBe("EC");
    expect(identity.keyThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(identity.privateKey.extractable).toBe(false);
  });
});

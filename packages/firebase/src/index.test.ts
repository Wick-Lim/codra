import { describe, expect, it } from "vitest";
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  DEMO_FIREBASE_OPTIONS,
  assertFirebaseRuntimeConfig,
  deviceCollection,
  remoteSessionCollection,
  signalCollection,
  SignalSequenceCollector,
} from "./index";
import { productionPublicConfig } from "@codra/protocol/production";

describe("Firebase runtime boundaries", () => {
  it("accepts only the demo project for emulator config", () => {
    expect(() =>
      assertFirebaseRuntimeConfig("emulator", DEMO_FIREBASE_OPTIONS),
    ).not.toThrow();
    expect(() =>
      assertFirebaseRuntimeConfig("emulator", productionPublicConfig),
    ).toThrow();
  });

  it("requires a separately provisioned desktop App Check app", () => {
    expect(() =>
      assertFirebaseRuntimeConfig("production", productionPublicConfig),
    ).toThrow();
    expect(() =>
      assertFirebaseRuntimeConfig(
        "production",
        productionPublicConfig,
        productionPublicConfig.appId,
      ),
    ).toThrow();
    expect(() =>
      assertFirebaseRuntimeConfig(
        "production",
        productionPublicConfig,
        "1:92715578857:web:abcdef123456",
      ),
    ).not.toThrow();
  });

  it("keeps client document paths under the account namespace", () => {
    const firestore = getFirestore(
      initializeApp(DEMO_FIREBASE_OPTIONS, `test-${Math.random()}`),
    );
    expect(deviceCollection(firestore, "uid").path).toBe("users/uid/devices");
    expect(remoteSessionCollection(firestore, "uid").path).toBe(
      "users/uid/remoteSessions",
    );
    expect(signalCollection(firestore, "uid", "session").path).toBe(
      "users/uid/remoteSessions/session/signals",
    );
  });

  it("collects only contiguous verified signals for one negotiation", async () => {
    const received: number[][] = [];
    const binding = {
      sessionId: "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f",
      negotiationId: "negotiation-1",
      senderDeviceId: "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1",
      recipientDeviceId: "f5c0bc9a-94a7-4af0-8c11-e6b0a5b06a2d",
      signerThumbprint: "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M",
      signerDeviceGeneration: 1,
      kind: "candidate" as const,
      createdAt: 1,
      expiresAt: 2,
      signature: "A".repeat(86),
    };
    const signal = (sequence: number) => ({
      ...binding,
      sequence,
      payload: {
        type: "candidate" as const,
        candidate: `candidate:${sequence}`,
      },
    });
    const collector = new SignalSequenceCollector({
      ...binding,
      afterSequence: 0,
      verify: async (candidate) => candidate.sequence !== 3,
      onSignals: (signals) =>
        received.push(signals.map((candidate) => candidate.sequence)),
    });

    await collector.accept([signal(2), signal(1)]);
    await collector.accept([signal(1), signal(2)]);
    expect(received).toEqual([[1, 2]]);
    expect(collector.afterSequence).toBe(2);
    await expect(collector.accept([signal(3)])).rejects.toThrow(
      "SIGNAL_SIGNATURE_INVALID",
    );
    await expect(collector.accept([signal(4)])).rejects.toThrow(
      "SIGNAL_SEQUENCE_GAP",
    );
    await expect(
      collector.accept([{ ...signal(3), negotiationId: "stale-negotiation" }]),
    ).rejects.toThrow("SIGNAL_BINDING_MISMATCH");
  });
});

import { describe, expect, it } from "vitest";
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  DEMO_FIREBASE_OPTIONS,
  assertFirebaseRuntimeConfig,
  deviceCollection,
  remoteSessionCollection,
  signalCollection,
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
});

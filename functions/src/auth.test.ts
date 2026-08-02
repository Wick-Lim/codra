import { describe, expect, it } from "vitest";
import type { CallableRequest } from "firebase-functions/v2/https";
import {
  assertCanInitiateRemoteSession,
  assertRemoteClientKind,
  DeviceRegistrationInputSchema,
  parseCallableInput,
  requireDeviceClaims,
  resolveSessionPeerBinding,
} from "./auth";

describe("device auth boundaries", () => {
  it("rejects malformed device registration input", () => {
    expect(() => parseCallableInput(DeviceRegistrationInputSchema, {})).toThrow(
      "INVALID_REQUEST",
    );
  });

  it("requires all device-scoped custom claims", () => {
    const request = {
      auth: {
        uid: "uid",
        token: {
          firebase: { sign_in_provider: "custom" },
          codraDeviceId: "device",
          codraKeyThumbprint: "thumbprint",
          codraDeviceKind: "host",
          codraDeviceGeneration: 1,
        },
      },
    } as unknown as CallableRequest<unknown>;
    expect(requireDeviceClaims(request)).toEqual({
      uid: "uid",
      deviceId: "device",
      keyThumbprint: "thumbprint",
      kind: "host",
      generation: 1,
    });
  });

  it("allows browser and host clients but rejects unknown kinds and self-targets", () => {
    expect(() => assertRemoteClientKind("browser")).not.toThrow();
    expect(() => assertRemoteClientKind("host")).not.toThrow();
    expect(() => assertRemoteClientKind("service")).toThrow(
      "REMOTE_CLIENT_DEVICE_REQUIRED",
    );
    expect(() =>
      assertCanInitiateRemoteSession(
        {
          uid: "uid",
          deviceId: "device-a",
          keyThumbprint: "thumbprint",
          kind: "host",
          generation: 1,
        },
        "device-b",
      ),
    ).not.toThrow();
    expect(() =>
      assertCanInitiateRemoteSession(
        {
          uid: "uid",
          deviceId: "device-a",
          keyThumbprint: "thumbprint",
          kind: "browser",
          generation: 1,
        },
        "device-a",
      ),
    ).toThrow("REMOTE_SELF_TARGET_FORBIDDEN");
  });

  it("resolves only the other immutable participant binding", () => {
    const binding = {
      clientDeviceId: "client-device",
      clientKeyThumbprint: "client-thumbprint",
      clientDeviceGeneration: 3,
      hostDeviceId: "host-device",
      hostKeyThumbprint: "host-thumbprint",
      hostDeviceGeneration: 7,
    };
    expect(
      resolveSessionPeerBinding(
        {
          uid: "uid",
          deviceId: "client-device",
          keyThumbprint: "client-thumbprint",
          kind: "host",
          generation: 3,
        },
        binding,
      ),
    ).toEqual({
      deviceId: "host-device",
      keyThumbprint: "host-thumbprint",
      generation: 7,
    });
    expect(
      resolveSessionPeerBinding(
        {
          uid: "uid",
          deviceId: "host-device",
          keyThumbprint: "host-thumbprint",
          kind: "host",
          generation: 7,
        },
        binding,
      ),
    ).toEqual({
      deviceId: "client-device",
      keyThumbprint: "client-thumbprint",
      generation: 3,
    });
    expect(() =>
      resolveSessionPeerBinding(
        {
          uid: "uid",
          deviceId: "client-device",
          keyThumbprint: "wrong-thumbprint",
          kind: "browser",
          generation: 3,
        },
        binding,
      ),
    ).toThrow("SESSION_PARTICIPANT_REQUIRED");
  });
});

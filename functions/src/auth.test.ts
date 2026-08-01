import { describe, expect, it } from "vitest";
import type { CallableRequest } from "firebase-functions/v2/https";
import {
  DeviceRegistrationInputSchema,
  parseCallableInput,
  requireDeviceClaims,
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
});

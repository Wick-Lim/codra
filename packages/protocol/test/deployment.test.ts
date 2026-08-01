import { describe, expect, it } from "vitest";
import {
  EmulatorDeploymentConfigSchema,
  ProductionDeploymentConfigSchema,
  createProductionDeployment,
  emulatorDeployment,
} from "../src/deployment";

describe("deployment contracts", () => {
  it("freezes the real Firebase production project and bridge", () => {
    const productionDeployment = createProductionDeployment({
      desktopAppCheckFirebaseAppId:
        "1:92715578857:web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      operatorApproved: true,
    });
    expect(productionDeployment.projectId).toBe("codra-1b3bb");
    expect(productionDeployment.browserOrigins).toEqual([
      "https://codra-1b3bb.web.app",
      "https://codra-1b3bb.firebaseapp.com",
    ]);
    expect(productionDeployment.accountBootstrapProvider).toBe("google.com");
    expect(productionDeployment.desktopAuthBridgeUrl).toBe(
      "https://codra-1b3bb.firebaseapp.com/desktop-auth",
    );
    expect(productionDeployment.firebaseAuthHandlerUrl).toBe(
      "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
    );
    expect(() =>
      ProductionDeploymentConfigSchema.parse({
        ...productionDeployment,
        desktopAppCheckFirebaseAppId: productionDeployment.bridgeFirebaseAppId,
      }),
    ).toThrow();
  });

  it("keeps emulator settings loopback and password-test-only", () => {
    expect(emulatorDeployment).toMatchObject({
      mode: "emulator",
      projectId: "demo-codra",
      browserOrigin: "http://127.0.0.1:5000",
      accountBootstrapProvider: "password-test-only",
    });
    expect(() =>
      EmulatorDeploymentConfigSchema.parse({
        ...emulatorDeployment,
        projectId: "codra-1b3bb",
      }),
    ).toThrow();
  });
});

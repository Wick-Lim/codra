import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { processExists } from "./process-cleanup";
import {
  launchRemoteDevice,
  seedRemoteTestAccount,
  shutdownRemoteDevices,
  startRemoteEmulators,
} from "./remote-harness";
import type { RemoteDeviceHandle } from "./remote-harness";

test("the harness runs two isolated remote-test devices against the emulators", async () => {
  expect(existsSync("apps/desktop/out-remote-test/main/index.js")).toBe(true);
  const emulators = await startRemoteEmulators();
  const devices: RemoteDeviceHandle[] = [];
  try {
    expect(emulators.projectId).toBe("demo-codra");
    expect(emulators.authOrigin).toBe("http://127.0.0.1:9099");
    expect(emulators.firestoreOrigin).toBe("http://127.0.0.1:8080");
    expect(emulators.functionsOrigin).toBe("http://127.0.0.1:5001");

    const account = await seedRemoteTestAccount(emulators);
    devices.push(await launchRemoteDevice({ label: "a", ...account }));
    devices.push(await launchRemoteDevice({ label: "b", ...account }));

    const pids = devices.map((device) => device.app.process().pid!);
    expect(new Set(pids).size).toBe(2);
    for (const pid of pids) expect(processExists(pid)).toBe(true);
    expect(devices[0].userDataDir).not.toBe(devices[1].userDataDir);
    expect(devices[0].descendantPids).not.toBe(devices[1].descendantPids);
    for (const device of devices) {
      await expect(
        device.page.getByRole("button", { name: "New terminal" }),
      ).toBeVisible();
    }

    const launched = devices.splice(0, devices.length);
    await shutdownRemoteDevices(launched);
    for (const pid of pids) {
      await expect.poll(() => processExists(pid)).toBe(false);
    }
  } finally {
    try {
      if (devices.length > 0) await shutdownRemoteDevices(devices);
    } finally {
      await emulators.stop();
    }
  }
});

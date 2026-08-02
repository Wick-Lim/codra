import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { resolveDeviceDisplayName } from "../../apps/desktop/src/main/remote/device-name";
import {
  launchRemoteDevice,
  seedRemoteTestAccount,
  shutdownRemoteDevices,
  startRemoteEmulators,
  type RemoteDeviceHandle,
} from "./remote-harness";

const remoteMainEntry = path.resolve(
  "apps/desktop/out-remote-test/main/index.js",
);

interface RemoteTarget {
  kind: "remote";
  deviceId: string;
  displayName: string;
}

test("approves a remote session in the renderer and completes the hello handshake", async () => {
  test.skip(
    process.platform !== "darwin",
    "two-device remote harness is macOS",
  );
  expect(
    existsSync(remoteMainEntry),
    `${remoteMainEntry} is missing. Run: pnpm build:remote-test`,
  ).toBe(true);

  const emulators = await startRemoteEmulators();
  const devices: RemoteDeviceHandle[] = [];
  try {
    const account = await seedRemoteTestAccount(emulators);
    const client = await launchRemoteDevice({ label: "client", ...account });
    devices.push(client);
    const host = await launchRemoteDevice({ label: "host", ...account });
    devices.push(host);

    for (const device of devices) {
      const signedIn = await device.page.evaluate(() =>
        window.codra.remote.login("email_password"),
      );
      expect(signedIn.state).toBe("signed_in");
      const online = await device.page.evaluate(() =>
        window.codra.remote.activate(),
      );
      expect(online).toEqual({ state: "online" });
    }

    let hostTarget: RemoteTarget | undefined;
    await expect
      .poll(
        async () => {
          const targets = await client.page.evaluate(() =>
            window.codra.agents.targets(),
          );
          hostTarget = targets
            .map((entry) => entry.target)
            .find((target): target is RemoteTarget => target.kind === "remote");
          return hostTarget === undefined ? 0 : 1;
        },
        { timeout: 60_000, message: "the client never discovered the host" },
      )
      .toBe(1);

    let connectFailure: unknown;
    const connection = client.page
      .evaluate(
        (target) => window.codra.agents.connectTarget(target),
        hostTarget!,
      )
      .catch((error: unknown) => {
        connectFailure = error;
        return undefined;
      });

    const approval = host.page.locator("dialog.session-approval-dialog");
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(approval).toContainText(resolveDeviceDisplayName(hostname()));
    await expect(approval).toContainText("agent.launch");
    await expect(approval.getByRole("button", { name: "Deny" })).toBeVisible();
    await approval.getByRole("button", { name: "Approve" }).click();
    await expect(approval).toBeHidden();

    const connected = await connection;
    expect(
      connectFailure,
      `connectTarget rejected: ${String(connectFailure)}`,
    ).toBeUndefined();
    expect(connected).toEqual({ target: hostTarget, state: "connected" });

    const runtimes = await client.page.evaluate(
      (target) => window.codra.agents.listForTarget(target),
      hostTarget!,
    );
    expect(runtimes.map((runtime) => runtime.kind).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
      "ollama",
    ]);
  } finally {
    try {
      await shutdownRemoteDevices(devices);
    } finally {
      await emulators.stop();
    }
  }
});

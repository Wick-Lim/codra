import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path, { delimiter } from "node:path";
import { installFakeClaudeAgent } from "./remote-fake-agent";
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

async function replayText(page: Page, terminalId: string): Promise<string> {
  const chunks = await page.evaluate(
    (id) =>
      window.codra.terminal.replay({
        terminalId: id,
        afterSequence: 0,
        limit: 1000,
      }),
    terminalId,
  );
  return chunks.map((chunk) => chunk.data).join("");
}

function tickNumbers(text: string): number[] {
  return [...text.matchAll(/CODRA_FAKE_AGENT_TICK (\d+)/gu)].map((match) =>
    Number(match[1]),
  );
}

async function terminalState(
  page: Page,
  terminalId: string,
): Promise<string | undefined> {
  const terminals = await page.evaluate(() => window.codra.terminal.list());
  return terminals.find((terminal) => terminal.id === terminalId)?.state;
}

test("resumes a dropped remote session with no lost and no duplicated output", async () => {
  test.skip(
    process.platform !== "darwin",
    "two-device remote harness is macOS",
  );
  expect(
    existsSync(remoteMainEntry),
    `${remoteMainEntry} is missing. Run: pnpm build:remote-test`,
  ).toBe(true);

  const agent = await installFakeClaudeAgent();
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${agent.binDirectory}${delimiter}${previousPath}`;
  const emulators = await startRemoteEmulators();
  const devices: RemoteDeviceHandle[] = [];
  try {
    const account = await seedRemoteTestAccount(emulators);
    const client = await launchRemoteDevice({ label: "client", ...account });
    devices.push(client);
    // autoApproveSessions is set only on the host, the device that receives
    // and approves the session — buildDeviceEnv always strips any ambient
    // CODRA_REMOTE_TEST_AUTO_APPROVE first, so opting in here is the only
    // way this device's approval modal gets auto-answered. remote-direct
    // already covers driving that modal by hand; this spec's subject is
    // cursor continuity across a dropped transport, not the approval flow.
    const host = await launchRemoteDevice({
      label: "host",
      ...account,
      autoApproveSessions: true,
    });
    devices.push(host);
    for (const device of devices) {
      await device.page.evaluate(() =>
        window.codra.remote.login("email_password"),
      );
      expect(
        await device.page.evaluate(() => window.codra.remote.activate()),
      ).toEqual({ state: "online" });
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
    expect(
      await client.page.evaluate(
        (target) => window.codra.agents.connectTarget(target),
        hostTarget!,
      ),
    ).toEqual({ target: hostTarget, state: "connected" });

    const terminal = await client.page.evaluate(
      (target) =>
        window.codra.terminal.create({
          target,
          cwd: "/tmp",
          cols: 100,
          rows: 30,
          agent: {
            kind: "claude",
            yolo: false,
            prompt: "hold this remote session open",
          },
        }),
      hostTarget!,
    );

    await expect
      .poll(
        async () =>
          tickNumbers(await replayText(client.page, terminal.id)).length,
        { timeout: 60_000, message: "no agent output arrived before the drop" },
      )
      .toBeGreaterThan(3);
    const beforeBreak = tickNumbers(await replayText(client.page, terminal.id));

    // Forcibly drop the transport by deactivating the host's remote access.
    // This tears down the host's DesktopPeerConnector (and every
    // RTCPeerConnection it holds), which is what a real network break looks
    // like from the client's side: the data channels close without either
    // end sending a graceful session.close. It is more realistic than
    // closing only the client's peer connection, because it also exercises
    // the host-side cleanup path (ProxyTerminalRouter marking the session
    // disconnected, AttachmentPump left mid-stream) that resume() has to
    // recover from once the host comes back.
    await host.page.evaluate(() => window.codra.remote.deactivate());
    await expect
      .poll(() => terminalState(client.page, terminal.id), { timeout: 60_000 })
      .toBe("exited");
    // Let the fake agent keep ticking for a few seconds while the transport
    // is down, so the replay buffer accumulates output nothing has read yet
    // — this is what makes the resume path prove continuity rather than
    // merely reconnection: there is guaranteed-missed output to recover.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(
      await host.page.evaluate(() => window.codra.remote.activate()),
    ).toEqual({ state: "online" });
    await expect
      .poll(
        async () => {
          const targets = await client.page.evaluate(() =>
            window.codra.agents.targets(),
          );
          return targets.some((entry) => entry.target.kind === "remote");
        },
        { timeout: 60_000, message: "the host never came back online" },
      )
      .toBe(true);
    expect(
      await client.page.evaluate(
        (target) => window.codra.agents.connectTarget(target),
        hostTarget!,
      ),
    ).toEqual({ target: hostTarget, state: "connected" });

    await expect
      .poll(() => terminalState(client.page, terminal.id), { timeout: 60_000 })
      .toBe("running");
    await expect
      .poll(
        async () => {
          const ticks = tickNumbers(await replayText(client.page, terminal.id));
          return ticks.at(-1) ?? 0;
        },
        {
          timeout: 60_000,
          message: "output did not resume after renegotiation",
        },
      )
      .toBeGreaterThan(beforeBreak.at(-1)! + 5);

    // This is the whole claim of the spec. `afterBreak` is the client's
    // replay buffer decoded start to finish; it is built by
    // ProxyTerminalRouter.acceptFrame incrementing `nextSequence` by
    // exactly one per accepted frame and rejecting (via disconnectSession)
    // any frame whose cursor does not land exactly on the previous frame's
    // end. If the resume path had dropped a chunk that ticked while the
    // transport was down, there would be a gap in this sequence — a tick
    // number skipped. If the host's replay-from-cursor-0 on re-attach had
    // caused the pre-break "one"/"two"-style frames the AttachmentPump
    // already sent once to be re-emitted as new output (the exact defect
    // the brief's Fact 3 describes: acknowledging session.nextCursor
    // instead of the frame's own end tears the session down, or — before
    // that fix — would let a stale replay duplicate content the client
    // already has), a tick number would repeat. Asserting the exact
    // integer run 1..n rules out both failure modes at once; a looser
    // check such as "length increased" or "contains tick N" would not.
    const afterBreak = tickNumbers(await replayText(client.page, terminal.id));
    expect(afterBreak).toEqual(
      Array.from({ length: afterBreak.length }, (_, index) => index + 1),
    );
    expect(afterBreak.length).toBeGreaterThan(beforeBreak.length);

    await client.page.evaluate(
      (id) => window.codra.terminal.write({ terminalId: id, data: "quit\r" }),
      terminal.id,
    );
  } finally {
    process.env.PATH = previousPath;
    try {
      await shutdownRemoteDevices(devices);
    } finally {
      try {
        await emulators.stop();
      } finally {
        await agent.remove();
      }
    }
  }
});

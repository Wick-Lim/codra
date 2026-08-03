import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";
import { installFakeClaudeAgent } from "./remote-fake-agent";
import {
  launchRemoteDevice,
  seedRemoteTestAccount,
  shutdownRemoteDevices,
  startRemoteEmulators,
  type RemoteDeviceHandle,
  type RemoteEmulators,
} from "./remote-harness";

const remoteMainEntry = path.resolve(
  "apps/desktop/out-remote-test/main/index.js",
);

interface RemoteTarget {
  kind: "remote";
  deviceId: string;
  displayName: string;
}

interface ScannedDocument {
  name: string;
  haystack: string;
}

async function firestoreJson(
  url: string,
  init?: { method: string; body: string },
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Bearer owner",
      "content-type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Firestore emulator returned ${response.status} for ${url}: ${await response.text()}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

async function listCollectionIds(
  origin: string,
  parent: string,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const body = await firestoreJson(
      `${origin}/v1/${parent}:listCollectionIds`,
      {
        method: "POST",
        body: JSON.stringify({
          pageSize: 300,
          ...(pageToken ? { pageToken } : {}),
        }),
      },
    );
    ids.push(...((body.collectionIds as string[] | undefined) ?? []));
    pageToken = body.nextPageToken as string | undefined;
  } while (pageToken);
  return ids;
}

async function listDocuments(
  origin: string,
  parent: string,
  collectionId: string,
): Promise<Array<Record<string, unknown>>> {
  const documents: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      pageSize: "300",
      showMissing: "true",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const body = await firestoreJson(
      `${origin}/v1/${parent}/${collectionId}?${query.toString()}`,
    );
    documents.push(
      ...((body.documents as Array<Record<string, unknown>> | undefined) ?? []),
    );
    pageToken = body.nextPageToken as string | undefined;
  } while (pageToken);
  return documents;
}

function decodedBytes(body: string): string {
  return [...body.matchAll(/"bytesValue":"([A-Za-z0-9+/=]*)"/gu)]
    .map((match) => Buffer.from(match[1]!, "base64").toString("utf8"))
    .join("\n");
}

async function scanEveryFirestoreDocument(
  emulators: RemoteEmulators,
): Promise<ScannedDocument[]> {
  const origin = emulators.firestoreOrigin;
  const scanned: ScannedDocument[] = [];
  const queue = [
    `projects/${emulators.projectId}/databases/(default)/documents`,
  ];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const collectionId of await listCollectionIds(origin, parent)) {
      for (const document of await listDocuments(
        origin,
        parent,
        collectionId,
      )) {
        const name = String(document.name ?? "");
        const body = JSON.stringify(document);
        scanned.push({
          name,
          haystack: `${name}\n${body}\n${decodedBytes(body)}`,
        });
        queue.push(name);
      }
    }
  }
  return scanned;
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

test("runs an agent on the peer's workspace and writes nothing sensitive to Firestore", async () => {
  test.skip(
    process.platform !== "darwin",
    "two-device remote harness is macOS",
  );
  expect(
    existsSync(remoteMainEntry),
    `${remoteMainEntry} is missing. Run: pnpm build:remote-test`,
  ).toBe(true);

  // workspaceParent is a dedicated, single-purpose directory rather than
  // os.tmpdir() itself: WorkspaceService.list (workspace-service.ts) caps a
  // directory listing at WORKSPACE_DIRECTORY_MAX_ENTRIES (250) sorted
  // entries, and a shared machine's OS temp directory routinely holds
  // hundreds of unrelated directories from other tools (browsers, other
  // test runs, package managers). Listing os.tmpdir() directly would make
  // whether workspaceRoot lands on the first page — and thus whether this
  // assertion passes — depend on what else happens to be in /tmp when the
  // test runs, rather than on the behavior under test.
  const workspaceParent = await realpath(
    await mkdtemp(path.join(tmpdir(), "codra-remote-workspace-parent-")),
  );
  const workspaceRoot = await realpath(
    await mkdtemp(path.join(workspaceParent, "workspace-")),
  );
  const prompt = `audit the checkout ${randomUUID()}`;
  const inputToken = `CODRA_PROBE_${randomUUID()}`;
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
    // and approves the session — buildDeviceEnv (remote-harness.ts) always
    // strips any ambient CODRA_REMOTE_TEST_AUTO_APPROVE first, so opting in
    // here is the only way this device's approval modal gets auto-answered.
    // remote-direct already covers driving that modal by hand; this spec's
    // subject is the workspace-browse/agent/Firestore-privacy flow, not the
    // approval UI.
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

    const roots = await client.page.evaluate(
      (target) => window.codra.agents.workspaceRoots(target),
      hostTarget!,
    );
    expect(roots.length).toBeGreaterThan(0);
    const page = await client.page.evaluate(
      ({ target, parent }) => window.codra.agents.workspaceList(target, parent),
      { target: hostTarget!, parent: workspaceParent },
    );
    expect(page.entries.map((entry) => entry.path)).toContain(workspaceRoot);
    expect(
      await client.page.evaluate(
        ({ target, selected }) =>
          window.codra.agents.workspaceValidate(target, selected),
        { target: hostTarget!, selected: workspaceRoot },
      ),
    ).toEqual({ path: workspaceRoot, label: path.basename(workspaceRoot) });

    const terminal = await client.page.evaluate(
      ({ target, cwd, agentPrompt }) =>
        window.codra.terminal.create({
          target,
          cwd,
          cols: 100,
          rows: 30,
          agent: { kind: "claude", yolo: false, prompt: agentPrompt },
        }),
      { target: hostTarget!, cwd: workspaceRoot, agentPrompt: prompt },
    );
    expect(terminal.origin).toEqual(hostTarget);

    await expect
      .poll(() => replayText(client.page, terminal.id), { timeout: 60_000 })
      .toContain(`CODRA_FAKE_AGENT_READY -- ${prompt}`);

    await client.page.evaluate(
      ({ id, token }) =>
        window.codra.terminal.write({ terminalId: id, data: `${token}\r` }),
      { id: terminal.id, token: inputToken },
    );
    await expect
      .poll(() => replayText(client.page, terminal.id), { timeout: 60_000 })
      .toContain(`CODRA_FAKE_AGENT_ECHO ${inputToken}`);

    await client.page.evaluate(
      (id) => window.codra.terminal.write({ terminalId: id, data: "where\r" }),
      terminal.id,
    );
    await expect
      .poll(() => replayText(client.page, terminal.id), { timeout: 60_000 })
      .toContain(`CODRA_FAKE_AGENT_CWD ${workspaceRoot}`);

    await client.page.evaluate(
      (id) =>
        window.codra.terminal.resize({ terminalId: id, cols: 120, rows: 40 }),
      terminal.id,
    );
    await client.page.evaluate(
      (id) => window.codra.terminal.write({ terminalId: id, data: "size\r" }),
      terminal.id,
    );
    await expect
      .poll(() => replayText(client.page, terminal.id), { timeout: 60_000 })
      .toContain("CODRA_FAKE_AGENT_SIZE 40x120");

    const documents = await scanEveryFirestoreDocument(emulators);
    expect(
      documents.length,
      "the Firestore scan found no documents at all — the scan is broken, not the privacy claim proven",
    ).toBeGreaterThan(0);
    expect(
      documents.some((document) => document.name.includes("/devices/")),
      "the scan never reached users/{uid}/devices",
    ).toBe(true);
    expect(
      documents.some((document) => document.name.includes("/remoteSessions/")),
      "the scan never reached users/{uid}/remoteSessions",
    ).toBe(true);
    expect(
      documents.some((document) => document.name.includes("/signals/")),
      "the scan never recursed into the signals subcollection",
    ).toBe(true);

    for (const needle of [prompt, inputToken, workspaceRoot]) {
      const leaked = documents
        .filter((document) => document.haystack.includes(needle))
        .map((document) => document.name);
      expect(leaked, `Firestore documents leaked ${needle}`).toEqual([]);
    }

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
        await rm(workspaceParent, { recursive: true, force: true });
      }
    }
  }
});

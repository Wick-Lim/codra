import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path, { delimiter } from "node:path";
import { resolveDeviceDisplayName } from "../../apps/desktop/src/main/remote/device-name";
import { scanEveryFirestoreDocument } from "./firestore-scan";
import { installFakeClaudeAgent } from "./remote-fake-agent";
import {
  EMULATOR_HOSTING_ORIGIN,
  buildWebConsoleBundle,
  launchRemoteDevice,
  newRemoteTestCredentials,
  seedRemoteTestAccount,
  shutdownRemoteDevices,
  startRemoteEmulators,
  type RemoteDeviceHandle,
} from "./remote-harness";

const remoteMainEntry = path.resolve(
  "apps/desktop/out-remote-test/main/index.js",
);

/**
 * Wide enough that no line this spec asserts on wraps, tall enough that the
 * fake agent's ticker — five lines a second — does not scroll the launch banner
 * out of the rendered rows before the first assertion samples them.
 * `.terminal-pane` is `min(62vh, 620px)`, so the height is what buys the rows.
 */
const CONSOLE_VIEWPORT = { width: 1600, height: 1200 };

function terminalPane(page: Page): Locator {
  return page.getByTestId("console-terminal");
}

/**
 * The text xterm has rendered into the DOM.
 *
 * xterm's DOM renderer emits one `<div>` per *visible* row, so this is the
 * viewport and not the scrollback — which is exactly what makes it a real
 * assertion about what an operator would see.
 */
function renderedTerminalText(page: Page): Promise<string> {
  return terminalPane(page).locator(".xterm-rows").innerText();
}

/**
 * The rendered rows, plus the rows at the very top of the scrollback.
 *
 * Only the launch banner needs this. It is written once, at the top of a fresh
 * terminal, and the ticker pushes it above the viewport within a few seconds;
 * the 10,000-line scrollback still holds it. Scrolling the viewport to the top
 * makes xterm render those rows, and the viewport is put back at the bottom
 * afterwards so the live assertions that follow still see new output.
 */
async function terminalTranscript(page: Page): Promise<string> {
  const rendered = await renderedTerminalText(page);
  const viewport = terminalPane(page).locator(".xterm-viewport");
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  const top = await renderedTerminalText(page);
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  return `${rendered}\n${top}`;
}

async function typeIntoTerminal(page: Page, line: string): Promise<void> {
  await terminalPane(page).locator(".xterm-screen").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

test("runs an agent from the browser console and writes nothing sensitive to Firestore", async ({
  page,
}) => {
  test.skip(
    process.platform !== "darwin",
    "two-device remote harness is macOS",
  );
  expect(
    existsSync(remoteMainEntry),
    `${remoteMainEntry} is missing. Run: pnpm build:remote-test`,
  ).toBe(true);

  // In /tmp, and not in os.tmpdir() or the home directory. WorkspacePicker can
  // only reach a directory by clicking down from a root the host offers, and
  // the roots are the home directory, `/`, and each mounted volume
  // (workspace-service.ts `defaultRootCandidates`) — so the workspace has to
  // sit somewhere a short click path from one of them reaches. Three
  // considerations pick /tmp:
  //
  // - `WorkspaceService.list` caps a listing at
  //   WORKSPACE_DIRECTORY_MAX_ENTRIES (250) sorted entries, and $TMPDIR on
  //   macOS (/var/folders/…/T) routinely holds more than that, which would
  //   make finding this directory depend on what else is in it.
  // - A Playwright *test timeout* aborts the test function outright, so no
  //   `finally` can be relied on to clean up; a leftover directory belongs
  //   somewhere the OS already sweeps, not in the operator's home.
  // - It is three clicks from the `/` root: private, tmp, then this
  //   directory.
  const workspaceRoot = await realpath(
    await mkdtemp(path.join(await realpath("/tmp"), "codra-web-console-")),
  );
  const workspaceName = path.basename(workspaceRoot);
  const prompt = `audit the checkout ${randomUUID()}`;
  const inputToken = `CODRA_PROBE_${randomUUID()}`;
  const agent = await installFakeClaudeAgent();
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${agent.binDirectory}${delimiter}${previousPath}`;
  // Everything below can fail before the emulators exist — the web build and
  // the emulator start both do real work — so the workspace, the fake agent,
  // and the PATH mutation are released in a `finally` that wraps them.
  try {
    // The account has to exist as a value before either the bundle or the
    // emulators exist: apps/web bakes it in at build time, and the Hosting
    // emulator needs the built tree to serve.
    const account = newRemoteTestCredentials();
    await buildWebConsoleBundle(account);
    const emulators = await startRemoteEmulators({ hosting: true });
    const devices: RemoteDeviceHandle[] = [];
    try {
      await seedRemoteTestAccount(emulators, account);
      const host = await launchRemoteDevice({ label: "host", ...account });
      devices.push(host);
      await host.page.evaluate(() =>
        window.codra.remote.login("email_password"),
      );
      expect(
        await host.page.evaluate(() => window.codra.remote.activate()),
      ).toEqual({ state: "online" });
      const hostName = resolveDeviceDisplayName(hostname());

      await page.setViewportSize(CONSOLE_VIEWPORT);
      await page.goto(`${EMULATOR_HOSTING_ORIGIN}/console`);

      // Step 1: sign in. This build's bootstrap is the emulator's
      // email/password one, so the button says so.
      await page
        .getByRole("button", { name: "Sign in with the test account" })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Reach the terminal you were working in.",
        }),
      ).toBeVisible({ timeout: 120_000 });

      // Step 2: the host this browser is about to ask for. listHostDevices
      // filters to `kind == "host"`, so the browser's own device never appears
      // here however many times the list is refreshed.
      const hostRow = page.locator(".host-row").filter({ hasText: hostName });
      await expect
        .poll(
          async () => {
            if ((await hostRow.count()) > 0) return 1;
            await page.getByRole("button", { name: "Refresh hosts" }).click();
            return hostRow.count();
          },
          {
            timeout: 60_000,
            message: "the browser console never listed the desktop host",
          },
        )
        .toBe(1);

      // Step 3: request, and approve it by hand on the desktop. Nothing is
      // negotiated until the host user consents, and the modal is where they do
      // it — so this is driven, not auto-approved.
      await hostRow.getByRole("button", { name: "Request connection" }).click();
      const approval = host.page.locator("dialog.session-approval-dialog");
      await expect(approval).toBeVisible({ timeout: 60_000 });
      // The modal names its requester. Today a browser session is named by
      // device id rather than by "CODRA browser": the host resolves the name
      // through `listHostDevices`, which filters to `kind == "host"`, so a
      // browser client is never found (see docs/remote-access-follow-ups.md).
      // Both spellings are accepted so this assertion neither locks the gap in
      // nor breaks when it is closed.
      await expect(approval).toContainText(
        /Allow (CODRA browser|Device [0-9a-f]{8}…) to connect\?/u,
      );
      // Every scope the console requested is listed and independently deniable.
      // `terminal.attach` alone can never produce a terminal, which is why
      // `agent.launch` is in the set: the console launches the agent it attaches
      // to rather than reaching the host's existing terminals.
      for (const scope of [
        "workspace.read",
        "agent.runtimes",
        "agent.launch",
        "terminal.write",
        "terminal.resize",
        "terminal.detach",
        "terminal.attach",
      ]) {
        await expect(approval).toContainText(scope);
      }
      await approval.getByRole("button", { name: "Approve" }).click();
      await expect(approval).toBeHidden();

      // Step 4: approval verified, ICE acquired, offer/answer exchanged over
      // signed Firestore signals, both data channels open, hello handshake done.
      const workspacePicker = page.getByRole("region", {
        name: "Choose a folder on the host",
      });
      await expect(workspacePicker).toBeVisible({ timeout: 120_000 });

      // Step 5: browse the host's filesystem over the channel and pick a
      // folder. `/tmp` itself is a symlink, and `WorkspaceService.list` keeps
      // only entries `isDirectory()` reports as directories, so the route to
      // the workspace runs through the real `/private/tmp`.
      await workspacePicker
        .getByRole("button", { name: "/", exact: true })
        .click();
      for (const segment of ["private", "tmp", workspaceName]) {
        await workspacePicker
          .getByRole("button", { name: `Open ${segment}`, exact: true })
          .click();
      }
      await workspacePicker
        .getByRole("button", { name: `Use ${workspaceName}` })
        .click();

      // Step 6: the host's runtime catalogue, then the launch itself.
      const runtimePicker = page.getByRole("region", {
        name: "Choose a runtime and describe the first task",
      });
      await expect(runtimePicker).toBeVisible({ timeout: 60_000 });
      // By role and accessible name rather than `getByLabel`: these controls sit
      // inside their `<label>`, so the label's own text is "Runtime" followed by
      // every option's text, and `getByLabel("Runtime", { exact: true })` matches
      // nothing at all — an action on it waits out the whole test timeout. The
      // accessible name is computed the other way round and is just "Runtime".
      await runtimePicker
        .getByRole("combobox", { name: "Runtime", exact: true })
        .selectOption("claude");
      await runtimePicker
        .getByRole("textbox", { name: "First prompt", exact: true })
        .fill(prompt);
      await runtimePicker.getByRole("button", { name: "Launch agent" }).click();

      // Step 7: the terminal the launch created, attached and streaming.
      await expect(terminalPane(page)).toBeVisible({ timeout: 120_000 });
      await expect(
        page.getByRole("region", { name: "Terminal Claude" }),
      ).toBeVisible();

      // The prompt reached the agent's argv on the host, which is the one place
      // it may travel: over the data channel, never through Firestore.
      await expect
        .poll(() => terminalTranscript(page), {
          timeout: 60_000,
          message: "the launched agent never echoed the prompt it was given",
        })
        .toContain(`CODRA_FAKE_AGENT_READY -- ${prompt}`);

      // Output round trip: the agent's own output, produced after the launch
      // reply, arriving as live frames rather than replay.
      await expect
        .poll(() => renderedTerminalText(page), {
          timeout: 60_000,
          message: "no live output frame reached the browser terminal",
        })
        .toContain("CODRA_FAKE_AGENT_TICK");

      // Input round trip, and proof the agent was launched in the folder chosen
      // above rather than in the host's own working directory.
      await typeIntoTerminal(page, "where");
      await expect
        .poll(() => renderedTerminalText(page), {
          timeout: 60_000,
          message: "the agent did not report the chosen workspace as its cwd",
        })
        .toContain(`CODRA_FAKE_AGENT_CWD ${workspaceRoot}`);

      // Input echo: a value typed into xterm reaches the pty and comes back.
      await typeIntoTerminal(page, inputToken);
      await expect
        .poll(() => renderedTerminalText(page), {
          timeout: 60_000,
          message: "typed input never came back through the terminal",
        })
        .toContain(`CODRA_FAKE_AGENT_ECHO ${inputToken}`);

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
        documents.some((document) =>
          document.name.includes("/remoteSessions/"),
        ),
        "the scan never reached users/{uid}/remoteSessions",
      ).toBe(true);
      expect(
        documents.some((document) => document.name.includes("/signals/")),
        "the scan never recursed into the signals subcollection",
      ).toBe(true);
      // The browser registered a device of its own, under the name
      // BrowserRemoteController.connect gives it. A display name is exactly the
      // kind of thing the control plane may carry; a terminal byte is not.
      expect(
        documents.some(
          (document) =>
            document.name.includes("/devices/") &&
            document.haystack.includes("CODRA browser"),
        ),
        "the browser never registered a device of its own",
      ).toBe(true);

      for (const needle of [prompt, inputToken, workspaceRoot]) {
        const leaked = documents
          .filter((document) => document.haystack.includes(needle))
          .map((document) => document.name);
        expect(leaked, `Firestore documents leaked ${needle}`).toEqual([]);
      }

      await typeIntoTerminal(page, "quit");
      await page.getByRole("button", { name: "End session" }).click();
    } finally {
      try {
        // Closing the page before the devices tears the browser's peer
        // connection down from the client side, so the scan below covers the
        // whole session close — not only the host's half of it.
        await page.close();
        await shutdownRemoteDevices(devices);
        // The scan above ran while the session was live, so it cannot see a
        // summary or final-status record written at session close, which is
        // exactly the kind of document a well-meaning implementation would be
        // tempted to write. Re-run the same needle check now that both ends
        // are gone but the emulators are still up.
        const teardownDocuments = await scanEveryFirestoreDocument(emulators);
        for (const needle of [prompt, inputToken, workspaceRoot]) {
          const leaked = teardownDocuments
            .filter((document) => document.haystack.includes(needle))
            .map((document) => document.name);
          expect(
            leaked,
            `Firestore documents leaked ${needle} during teardown`,
          ).toEqual([]);
        }
      } finally {
        await emulators.stop();
      }
    }
  } finally {
    process.env.PATH = previousPath;
    try {
      await agent.remove();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
});

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  processExists,
  rememberDescendants,
  terminateCapturedProcessTree,
} from "./process-cleanup";

const desktopMainEntry = path.resolve("apps/desktop/out/main/index.js");
const completedMarker = "__CODRA_E2E_COMPLETE__";

test("restores an active terminal and quits it through the confirmed warning", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "codra-dev-e2e-"));
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let electronPid: number | undefined;
  let shellPid: number | undefined;
  const knownDescendantPids = new Set<number>();

  try {
    electronApp = await electron.launch({
      args: [desktopMainEntry],
      env: {
        ...process.env,
        CODRA_USER_DATA_DIR: userDataDir,
      },
    });
    electronPid = electronApp.process().pid!;
    let page = await electronApp.firstWindow();
    await page.getByRole("button", { name: "New terminal" }).click();
    await rememberDescendants(electronPid, knownDescendantPids);
    const activeTerminal = page.getByTestId("active-terminal");
    await expect(activeTerminal).toBeVisible();
    const terminalId = await activeTerminal.getAttribute("data-terminal-id");
    expect(terminalId).toBeTruthy();

    await page.evaluate(
      async ({ id }) => {
        await window.codra.terminal.write({
          terminalId: id,
          data: "printf '%s%s%s:%s\\n' '__CODRA_' 'E2E_' 'COMPLETE__' \"$$\"\r",
        });
      },
      { id: terminalId! },
    );

    let initialReplay = "";
    await expect
      .poll(async () => {
        const replay = await page.evaluate(
          async ({ id }) =>
            window.codra.terminal.replay({
              terminalId: id,
              afterSequence: 0,
              limit: 500,
            }),
          { id: terminalId! },
        );
        initialReplay = replay.map((chunk) => chunk.data).join("");
        return initialReplay;
      })
      .toMatch(new RegExp(`${completedMarker}:(\\d+)`));

    const pidMatch = initialReplay.match(
      new RegExp(`${completedMarker}:(\\d+)`),
    );
    expect(pidMatch).not.toBeNull();
    shellPid = Number(pidMatch![1]);
    knownDescendantPids.add(shellPid);
    expect(processExists(shellPid)).toBe(true);

    await page.close();
    const reopenedWindow = electronApp.waitForEvent("window");
    await electronApp.evaluate(({ app }) => app.emit("activate"));
    page = await reopenedWindow;

    const restoredTerminal = page.getByTestId("active-terminal");
    await expect(restoredTerminal).toHaveAttribute(
      "data-terminal-id",
      terminalId!,
    );
    await expect(
      page.getByRole("navigation", { name: "Terminals" }).getByRole("listitem"),
    ).toHaveCount(1);

    const restoredReplay = await page.evaluate(
      async ({ id }) =>
        window.codra.terminal.replay({
          terminalId: id,
          afterSequence: 0,
          limit: 500,
        }),
      { id: terminalId! },
    );
    expect(restoredReplay.map((chunk) => chunk.data).join("")).toContain(
      completedMarker,
    );

    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (options) => {
        if (
          options.type !== "warning" ||
          options.buttons?.join("|") !== "Cancel|Quit" ||
          options.defaultId !== 0 ||
          options.cancelId !== 0 ||
          options.title !== "Quit Codra?" ||
          options.message !== "Close 1 active terminal?" ||
          options.detail !== "Their running processes will be terminated."
        ) {
          throw new Error("Unexpected active-terminal quit warning");
        }
        return { response: 1, checkboxChecked: false };
      };
    });
    await electronApp.evaluate(({ app }) => app.quit());
    await expect.poll(() => processExists(shellPid!)).toBe(false);
    await expect.poll(() => processExists(electronPid!)).toBe(false);
  } finally {
    try {
      await terminateCapturedProcessTree({
        rootPid: electronPid,
        knownDescendantPids,
        knownShellPid: shellPid,
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
});

test("keeps the secured CODRA renderer when navigation or a new window is requested", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "codra-security-e2e-"));
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let electronPid: number | undefined;
  const knownDescendantPids = new Set<number>();

  try {
    electronApp = await electron.launch({
      args: [desktopMainEntry],
      env: {
        ...process.env,
        CODRA_USER_DATA_DIR: userDataDir,
      },
    });
    electronPid = electronApp.process().pid!;
    await electronApp.context().route("https://attacker.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Untrusted</title><h1>Untrusted renderer</h1>",
      }),
    );
    const page = await electronApp.firstWindow();
    await expect(
      page.getByRole("button", { name: "New terminal" }),
    ).toBeVisible();
    const trustedUrl = page.url();

    await page.evaluate(async () => {
      window.location.assign("https://attacker.example/navigation");
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(page.url()).toBe(trustedUrl);

    await page.evaluate(async () => {
      window.open("https://attacker.example/popup", "_blank");
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(electronApp.windows()).toHaveLength(1);
    expect(page.url()).toBe(trustedUrl);
    await electronApp.close();
    await expect.poll(() => processExists(electronPid!)).toBe(false);
  } finally {
    try {
      await terminateCapturedProcessTree({
        rootPid: electronPid,
        knownDescendantPids,
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
});

test("keeps agent workdir and launch actions visible in a compact window", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "codra-agent-ui-e2e-"));
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let electronPid: number | undefined;
  const knownDescendantPids = new Set<number>();

  try {
    electronApp = await electron.launch({
      args: [desktopMainEntry],
      env: {
        ...process.env,
        CODRA_USER_DATA_DIR: userDataDir,
      },
    });
    electronPid = electronApp.process().pid!;
    const page = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 720);
    });
    await expect
      .poll(() => page.evaluate(() => window.innerHeight))
      .toBeLessThanOrEqual(720);

    await page.getByRole("button", { name: "New agent" }).click();

    const workdir = page.getByRole("textbox", { name: "Working directory" });
    await expect(workdir).toBeVisible();
    await expect(workdir).not.toHaveValue("");
    await expect(
      page.getByRole("textbox", { name: "First prompt" }),
    ).toBeFocused();
    const startButton = page.getByRole("button", { name: "Start agent" });
    const startBox = await startButton.boundingBox();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(startBox).not.toBeNull();
    expect(startBox!.y + startBox!.height).toBeLessThanOrEqual(viewportHeight);

    await electronApp.close();
    await expect.poll(() => processExists(electronPid!)).toBe(false);
  } finally {
    try {
      await terminateCapturedProcessTree({
        rootPid: electronPid,
        knownDescendantPids,
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
});

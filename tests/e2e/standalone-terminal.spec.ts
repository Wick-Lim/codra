import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const desktopMainEntry = path.resolve("apps/desktop/out/main/index.js");
const completedMarker = "__CODRA_E2E_COMPLETE__";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

test("creates a real terminal and restores its identity and scrollback after window close", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "codra-dev-e2e-"));
  const electronApp = await electron.launch({
    args: [desktopMainEntry],
    env: {
      ...process.env,
      CODRA_USER_DATA_DIR: userDataDir,
    },
  });
  const electronProcess = electronApp.process();
  const electronPid = electronProcess.pid!;
  let shellPid: number | undefined;

  try {
    let page = await electronApp.firstWindow();
    await page.getByRole("button", { name: "New terminal" }).click();
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

    await page.evaluate(async ({ id }) => window.codra.terminal.close(id), {
      id: terminalId!,
    });
    await expect.poll(() => processExists(shellPid!)).toBe(false);
    await electronApp.close();
    await expect.poll(() => processExists(electronPid)).toBe(false);
  } finally {
    if (processExists(electronPid)) electronProcess.kill("SIGKILL");
    if (shellPid !== undefined && processExists(shellPid)) {
      process.kill(shellPid, "SIGKILL");
    }
    await rm(userDataDir, { recursive: true, force: true });
  }
});

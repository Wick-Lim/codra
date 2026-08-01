import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const desktopDist = path.resolve("apps/desktop/dist");
const completedMarker = "__CODRA_PACKAGED_SMOKE__";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function findPackagedExecutable(): Promise<string> {
  const entries = await readdir(desktopDist, { withFileTypes: true }).catch(
    () => [],
  );
  const macDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => entry.name)
    .sort();
  const preferredDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
  const orderedDirectories = [
    preferredDirectory,
    ...macDirectories.filter((name) => name !== preferredDirectory),
  ];

  for (const directory of orderedDirectories) {
    const executable = path.join(
      desktopDist,
      directory,
      "CODRA.app",
      "Contents",
      "MacOS",
      "CODRA",
    );
    try {
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      // Keep looking for a host-architecture unpacked application.
    }
  }
  throw new Error(
    `No executable CODRA.app found below ${desktopDist}; run package:dir first`,
  );
}

test("packaged CODRA launches a real shell and reaps it on terminal close", async () => {
  test.skip(process.platform !== "darwin", "macOS packaged smoke test");

  const executablePath = await findPackagedExecutable();
  const userDataDir = await mkdtemp(
    path.join(tmpdir(), "codra-packaged-smoke-"),
  );
  const electronApp = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      CODRA_PACKAGED_SMOKE: "1",
      CODRA_USER_DATA_DIR: userDataDir,
    },
  });
  const electronProcess = electronApp.process();
  const electronPid = electronProcess.pid!;
  let shellPid: number | undefined;

  try {
    const page = await electronApp.firstWindow();
    await page.getByRole("button", { name: "New terminal" }).click();
    const activeTerminal = page.getByTestId("active-terminal");
    await expect(activeTerminal).toBeVisible();
    const terminalId = await activeTerminal.getAttribute("data-terminal-id");
    expect(terminalId).toBeTruthy();

    await page.evaluate(
      async ({ id }) => {
        await window.codra.terminal.write({
          terminalId: id,
          data: "printf '%s%s%s:%s\\n' '__CODRA_' 'PACKAGED_' 'SMOKE__' \"$$\"\r",
        });
      },
      { id: terminalId! },
    );

    let replayText = "";
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
        replayText = replay.map((chunk) => chunk.data).join("");
        return replayText;
      })
      .toMatch(new RegExp(`${completedMarker}:(\\d+)`));

    const pidMatch = replayText.match(new RegExp(`${completedMarker}:(\\d+)`));
    expect(pidMatch).not.toBeNull();
    shellPid = Number(pidMatch![1]);
    expect(processExists(shellPid)).toBe(true);

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

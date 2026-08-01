import { execFile } from "node:child_process";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { access, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  processExists,
  rememberDescendants,
  terminateCapturedProcessTree,
} from "./process-cleanup";

const execFileAsync = promisify(execFile);
const desktopDist = path.resolve("apps/desktop/dist");
const archiveScriptPath = path.resolve("scripts/archive-host-app.mjs");
const completedMarker = "__CODRA_PACKAGED_SMOKE__";

interface PackageProvenance {
  id: string;
  commit: string;
  arch: string;
  createdAt: string;
}

interface SmokeReceipt {
  provenanceId: string;
  nonce: string;
  commit: string;
  arch: string;
}

function hostPackagingPaths() {
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(
      `Unsupported macOS packaging architecture: ${process.arch}`,
    );
  }
  const outputDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
  const appPath = path.join(desktopDist, outputDirectory, "CODRA.app");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  return {
    appPath,
    executablePath: path.join(appPath, "Contents", "MacOS", "CODRA"),
    externalProvenancePath: path.join(desktopDist, "package-provenance.json"),
    archivePath: path.join(desktopDist, "CODRA-host.app.tar.gz"),
    pendingSmokePath: path.join(desktopDist, "package-smoke.pending.json"),
    passedSmokePath: path.join(desktopDist, "package-smoke.passed.json"),
    packagedProvenancePath: path.join(resourcesPath, "package-provenance.json"),
    selectedHelperPath: path.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
      "build",
      "Release",
      "spawn-helper",
    ),
    nativeBindingPath: path.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "prebuilds",
      `darwin-${process.arch}.node`,
    ),
  };
}

async function readProvenance(filePath: string): Promise<PackageProvenance> {
  return JSON.parse(await readFile(filePath, "utf8")) as PackageProvenance;
}

async function readReceipt(filePath: string): Promise<SmokeReceipt> {
  return JSON.parse(await readFile(filePath, "utf8")) as SmokeReceipt;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fileDescription(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync("file", [filePath]);
  return stdout;
}

test("packaged CODRA proves current host natives and reaps its real shell", async () => {
  test.skip(process.platform !== "darwin", "macOS packaged smoke test");

  const paths = hostPackagingPaths();
  const userDataDir = await mkdtemp(
    path.join(tmpdir(), "codra-packaged-smoke-"),
  );
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let electronPid: number | undefined;
  let shellPid: number | undefined;
  const knownDescendantPids = new Set<number>();

  try {
    await access(paths.executablePath, constants.X_OK);
    const externalProvenance = await readProvenance(
      paths.externalProvenancePath,
    );
    const packagedProvenance = await readProvenance(
      paths.packagedProvenancePath,
    );
    const pendingReceipt = await readReceipt(paths.pendingSmokePath);
    expect(packagedProvenance).toEqual(externalProvenance);
    expect(await pathExists(paths.passedSmokePath)).toBe(false);
    expect(externalProvenance.arch).toBe(process.arch);
    expect(externalProvenance.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const { stdout: currentCommit } = await execFileAsync("git", [
      "rev-parse",
      "HEAD",
    ]);
    expect(externalProvenance.commit).toBe(currentCommit.trim());
    expect(pendingReceipt.provenanceId).toBe(externalProvenance.id);
    expect(pendingReceipt.commit).toBe(externalProvenance.commit);
    expect(pendingReceipt.arch).toBe(externalProvenance.arch);
    expect(pendingReceipt.nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await rm(paths.archivePath, { force: true });
    await expect(
      execFileAsync(process.execPath, [archiveScriptPath]),
    ).rejects.toMatchObject({ code: 1 });
    expect(await pathExists(paths.archivePath)).toBe(false);

    const expectedMachArch = process.arch === "arm64" ? "arm64" : "x86_64";
    await expect(fileDescription(paths.executablePath)).resolves.toContain(
      `Mach-O 64-bit executable ${expectedMachArch}`,
    );
    expect(paths.selectedHelperPath).toContain(
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    expect((await stat(paths.selectedHelperPath)).mode & 0o777).toBe(0o755);
    expect(paths.nativeBindingPath).toContain(
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    await expect(fileDescription(paths.nativeBindingPath)).resolves.toContain(
      `Mach-O 64-bit bundle ${expectedMachArch}`,
    );

    electronApp = await electron.launch({
      executablePath: paths.executablePath,
      env: {
        ...process.env,
        CODRA_PACKAGED_SMOKE: "1",
        CODRA_USER_DATA_DIR: userDataDir,
      },
    });
    electronPid = electronApp.process().pid!;
    const page = await electronApp.firstWindow();
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
    knownDescendantPids.add(shellPid);
    expect(processExists(shellPid)).toBe(true);

    await page.evaluate(async ({ id }) => window.codra.terminal.close(id), {
      id: terminalId!,
    });
    await expect.poll(() => processExists(shellPid!)).toBe(false);
    await electronApp.close();
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

  await rename(paths.pendingSmokePath, paths.passedSmokePath);
});

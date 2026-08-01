import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const desktopDirectory = path.join(repositoryRoot, "apps", "desktop");
const distDirectory = path.join(desktopDirectory, "dist");
const provenancePath = path.join(distDirectory, "package-provenance.json");
const hostArchivePath = path.join(distDirectory, "CODRA-host.app.tar.gz");
const release = process.argv.includes("--release");

if (process.platform !== "darwin") {
  throw new Error("macOS packaging requires darwin");
}
if (!release && process.arch !== "arm64" && process.arch !== "x64") {
  throw new Error(`Unsupported macOS packaging architecture: ${process.arch}`);
}

const hostOutputName = process.arch === "arm64" ? "mac-arm64" : "mac";
const outputPaths = release
  ? [distDirectory]
  : [path.join(distDirectory, hostOutputName), provenancePath, hostArchivePath];

async function cleanOutputs() {
  for (const outputPath of outputPaths) {
    await rm(outputPath, { force: true, recursive: true });
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopDirectory,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
          ),
        );
      }
    });
  });
}

await cleanOutputs();
try {
  await run("pnpm", ["build"]);
  const { stdout: commitOutput } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repositoryRoot },
  );
  const provenance = {
    id: randomUUID(),
    commit: commitOutput.trim(),
    arch: release ? "arm64+x64" : process.arch,
    createdAt: new Date().toISOString(),
  };
  await mkdir(distDirectory, { recursive: true });
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await run("pnpm", [
    "exec",
    "electron-builder",
    ...(release ? [] : ["--dir"]),
    "--mac",
    "--publish",
    "never",
  ]);
} catch (error) {
  await cleanOutputs();
  throw error;
}

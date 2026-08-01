import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDirectory = path.join(repositoryRoot, "apps", "desktop", "dist");
const archivePath = path.join(distDirectory, "CODRA-host.app.tar.gz");
const provenancePath = path.join(distDirectory, "package-provenance.json");
const pendingSmokePath = path.join(distDirectory, "package-smoke.pending.json");
const passedSmokePath = path.join(distDirectory, "package-smoke.passed.json");

if (process.platform !== "darwin") {
  throw new Error("macOS app archiving requires darwin");
}
if (process.arch !== "arm64" && process.arch !== "x64") {
  throw new Error(`Unsupported macOS archive architecture: ${process.arch}`);
}

const hostOutputName = process.arch === "arm64" ? "mac-arm64" : "mac";
const hostOutputPath = path.join(distDirectory, hostOutputName);
const appPath = path.join(hostOutputPath, "CODRA.app");
const executableRelativePath = path.join(
  "CODRA.app",
  "Contents",
  "MacOS",
  "CODRA",
);
const helperRelativePath = path.join(
  "CODRA.app",
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "node_modules",
  "node-pty",
  "build",
  "Release",
  "spawn-helper",
);

async function runTar(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/tar", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `tar exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
          ),
        );
      }
    });
  });
}

async function requireMode0755(filePath) {
  if (((await stat(filePath)).mode & 0o777) !== 0o755) {
    throw new Error(`Archived executable source is not mode 0755: ${filePath}`);
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

await rm(archivePath, { force: true });
if (await pathExists(pendingSmokePath)) {
  throw new Error("Packaged smoke is still pending");
}
const provenance = await readJson(provenancePath);
const passedReceipt = await readJson(passedSmokePath);
if (
  passedReceipt.provenanceId !== provenance.id ||
  passedReceipt.commit !== provenance.commit ||
  passedReceipt.arch !== provenance.arch ||
  typeof passedReceipt.nonce !== "string" ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    passedReceipt.nonce,
  )
) {
  throw new Error("Packaged smoke receipt does not match provenance");
}

if (!(await stat(appPath)).isDirectory()) {
  throw new Error(`Exact host CODRA.app is missing: ${appPath}`);
}
await requireMode0755(path.join(hostOutputPath, executableRelativePath));
await requireMode0755(path.join(hostOutputPath, helperRelativePath));

const extractionPath = await mkdtemp(
  path.join(tmpdir(), "codra-archive-check-"),
);
try {
  await runTar(["-C", hostOutputPath, "-czf", archivePath, "CODRA.app"]);
  await runTar(["-C", extractionPath, "-xzf", archivePath]);
  await requireMode0755(path.join(extractionPath, executableRelativePath));
  await requireMode0755(path.join(extractionPath, helperRelativePath));
  process.stdout.write(`${archivePath}\n`);
} catch (error) {
  await rm(archivePath, { force: true });
  throw error;
} finally {
  await rm(extractionPath, { recursive: true, force: true });
}

import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function hashPackagedResources(resourcesRoot) {
  const hash = createHash("sha256");
  const visit = async (absolute, relative) => {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(
        `Symlinks are not permitted in packaged resources: ${relative}`,
      );
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        await visit(
          join(absolute, name),
          relative ? `${relative}/${name}` : name,
        );
      }
      return;
    }
    if (relative === "remote-test-provenance.json") return;
    hash
      .update(relative)
      .update("\0")
      .update(String(info.mode & 0o777))
      .update("\0")
      .update(await readFile(absolute));
  };
  await visit(resourcesRoot, "");
  return hash.digest("hex");
}

export default async function ensureRemoteTestAfterPack(context) {
  const provenance = join(
    context.appOutDir,
    "CODRA Remote Test.app",
    "Contents",
    "Resources",
    "remote-test-provenance.json",
  );
  await access(provenance);
  const record = JSON.parse(await readFile(provenance, "utf8"));
  if (
    record.testOnly !== true ||
    record.configMode !== "emulator" ||
    !/^[a-f0-9]{64}$/u.test(record.sourceSha256) ||
    !/^[0-9a-f]{40}$/u.test(record.commit)
  ) {
    throw new Error("Remote-test package provenance is invalid.");
  }
  const asar = join(
    context.appOutDir,
    "CODRA Remote Test.app",
    "Contents",
    "Resources",
    "app.asar",
  );
  await access(asar);
  const packagedSha256 = await hashPackagedResources(
    join(context.appOutDir, "CODRA Remote Test.app", "Contents", "Resources"),
  );
  await writeFile(
    provenance,
    `${JSON.stringify({
      ...record,
      architecture:
        context.arch === 3
          ? "arm64"
          : context.arch === 1
            ? "x64"
            : context.arch,
      packagedSha256,
    })}\n`,
    "utf8",
  );
}

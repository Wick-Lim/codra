/* global process */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const desktopRoot = resolve("apps/desktop");
const output = resolve(desktopRoot, "out-remote-test");

if (!existsSync(output)) {
  throw new Error("Build the remote-test flavor before packaging it.");
}

function hashTree(directory) {
  const hash = createHash("sha256");
  const visit = (current, relative = "") => {
    for (const entry of readdirSync(current).sort()) {
      const absolute = resolve(current, entry);
      const name = relative ? `${relative}/${entry}` : entry;
      const info = statSync(absolute);
      if (info.isDirectory()) visit(absolute, name);
      else hash.update(name).update("\0").update(readFileSync(absolute));
    }
  };
  visit(directory);
  return hash.digest("hex");
}

const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
});
const commit =
  commitResult.status === 0
    ? commitResult.stdout.trim()
    : (process.env.GIT_COMMIT ?? "unknown");

writeFileSync(
  resolve(desktopRoot, "remote-test-provenance.json"),
  `${JSON.stringify({ schemaVersion: 1, testOnly: true, configMode: "emulator", commit, sourceSha256: hashTree(output), createdAt: new Date().toISOString() })}\n`,
);

try {
  for (const architecture of ["arm64", "x64"]) {
    const rebuild = spawnSync(
      "pnpm",
      [
        "--filter",
        "@codra/desktop",
        "exec",
        "npm",
        "rebuild",
        "node-datachannel",
        `--arch=${architecture}`,
        "--platform=darwin",
      ],
      { cwd: desktopRoot, stdio: "inherit" },
    );
    if (rebuild.status !== 0) {
      process.exitCode = rebuild.status ?? 1;
      break;
    }
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "@codra/desktop",
        "exec",
        "electron-builder",
        "--config",
        "electron-builder.remote-test.yml",
        `--${architecture}`,
      ],
      { cwd: desktopRoot, stdio: "inherit" },
    );
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  const restore = spawnSync(
    "pnpm",
    [
      "--filter",
      "@codra/desktop",
      "exec",
      "npm",
      "rebuild",
      "node-datachannel",
      `--arch=${process.arch}`,
      "--platform=darwin",
    ],
    { cwd: desktopRoot, stdio: "inherit" },
  );
  if (restore.status !== 0 && process.exitCode === undefined) {
    process.exitCode = restore.status ?? 1;
  }
}

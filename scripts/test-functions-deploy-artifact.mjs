/* global process */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function snapshot(root, current = root, result = []) {
  for (const name of (await readdir(current)).sort()) {
    const absolute = join(current, name);
    const relative = absolute.slice(root.length + 1);
    const info = await lstat(absolute);
    assert.equal(
      info.isSymbolicLink(),
      false,
      `symlink is forbidden: ${relative}`,
    );
    if (info.isDirectory()) {
      await snapshot(root, absolute, result);
      continue;
    }
    const contents = await readFile(absolute);
    result.push({
      path: relative,
      mode: info.mode & 0o777,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return result;
}

async function assertStageShape(root) {
  const manifest = JSON.parse(
    await readFile(join(root, "functions-component-manifest.json"), "utf8"),
  );
  const entries = (await snapshot(root)).map((entry) => entry.path);
  assert.deepEqual(
    entries.filter((entry) => entry !== "functions-component-manifest.json"),
    manifest.files,
  );
  assert.equal(manifest.fixture, true);
  assert.match(manifest.protocolTarballSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.stageSha256, /^[a-f0-9]{64}$/u);
}

const first = await mkdtemp(join(tmpdir(), "codra-functions-a-"));
const second = await mkdtemp(join(tmpdir(), "codra-functions-b-"));
for (const target of [first, second]) {
  const result = spawnSync(
    process.execPath,
    ["scripts/stage-functions-deploy.mjs", "--fixture", "--output", target],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(
    await readFile(join(target, "functions-component-manifest.json"), "utf8"),
  );
  assert.equal(manifest.fixture, true);
  assert.deepEqual(manifest.files, [
    ".npmrc",
    "lib/index.js",
    "package.json",
    "pnpm-lock.yaml",
    "vendor/codra-protocol-0.0.1.tgz",
  ]);
  await assertStageShape(target);
}
assert.deepEqual(await snapshot(first), await snapshot(second));

const installRoot = await mkdtemp(join(tmpdir(), "codra-functions-install-"));
await cp(first, installRoot, { recursive: true });
const install = spawnSync(
  "pnpm",
  [
    "install",
    "--offline",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-workspace",
  ],
  { cwd: installRoot, encoding: "utf8", timeout: 120_000 },
);
assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
const probe = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    "import { REMOTE_PROTOCOL_VERSION } from '@codra/protocol'; if (REMOTE_PROTOCOL_VERSION !== 1) process.exit(1);",
  ],
  { cwd: installRoot, encoding: "utf8" },
);
assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);

const undeclared = join(installRoot, "undeclared.txt");
await writeFile(undeclared, "forbidden\n");
await assert.rejects(
  () => assertStageShape(installRoot),
  /forbidden|symlink|manifest/u,
);

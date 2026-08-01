/* global process */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse, resolve } from "node:path";

const require = createRequire(
  resolve(process.cwd(), "apps/desktop/package.json"),
);
const entry = require.resolve("node-datachannel");
let directory = dirname(entry);
let packagePath = "";
while (directory !== parse(directory).root) {
  const candidate = join(directory, "package.json");
  if (existsSync(candidate)) {
    packagePath = candidate;
    break;
  }
  directory = dirname(directory);
}

assert.ok(packagePath, "node-datachannel package manifest must be installed");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
assert.equal(packageJson.version, "0.32.3");
assert.ok(entry);

const datachannel = require("node-datachannel");
assert.equal(typeof datachannel.PeerConnection, "function");
assert.equal(typeof datachannel.preload, "function");
assert.equal(typeof datachannel.cleanup, "function");
datachannel.preload();
const localProbe = new datachannel.PeerConnection("codra-native-probe", {
  iceServers: [],
});
assert.equal(typeof localProbe.close, "function");
localProbe.close();
datachannel.cleanup();

function hashPackagedResources(resourcesRoot) {
  const hash = createHash("sha256");
  const visit = (absolute, relative) => {
    const info = lstatSync(absolute);
    assert.equal(info.isSymbolicLink(), false, `symlink: ${relative}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        visit(join(absolute, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (relative === "remote-test-provenance.json") return;
    hash
      .update(relative)
      .update("\0")
      .update(String(info.mode & 0o777))
      .update("\0")
      .update(readFileSync(absolute));
  };
  visit(resourcesRoot, "");
  return hash.digest("hex");
}

const packagedRoot = resolve(process.cwd(), "apps/desktop/dist-remote-test");
for (const [directory, architecture] of [
  ["mac-arm64", "arm64"],
  ["mac", "x86_64"],
]) {
  if (!existsSync(packagedRoot)) break;
  const appRoot = resolve(packagedRoot, directory, "CODRA Remote Test.app");
  assert.ok(existsSync(appRoot), `missing packaged ${directory} app`);
  const resourcesRoot = resolve(appRoot, "Contents/Resources");
  const provenancePath = resolve(resourcesRoot, "remote-test-provenance.json");
  assert.ok(existsSync(provenancePath), `missing ${directory} provenance`);
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  assert.equal(provenance.testOnly, true);
  assert.equal(provenance.configMode, "emulator");
  assert.equal(provenance.architecture, directory === "mac" ? "x64" : "arm64");
  assert.match(provenance.packagedSha256, /^[a-f0-9]{64}$/u);
  assert.equal(provenance.packagedSha256, hashPackagedResources(resourcesRoot));
  const binary = resolve(
    resourcesRoot,
    "app.asar.unpacked/node_modules/node-datachannel/build/Release/node_datachannel.node",
  );
  assert.ok(existsSync(binary), `missing ${directory} node-datachannel binary`);
  const result = spawnSync("file", [binary], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`\\b${architecture}\\b`));
}

const electron = resolve(
  process.cwd(),
  "apps/desktop/node_modules/.bin/electron",
);
if (existsSync(electron)) {
  const probe = spawnSync(
    electron,
    [
      "--no-sandbox",
      "--disable-gpu",
      resolve("scripts/node-datachannel-electron-probe.cjs"),
    ],
    { cwd: resolve("apps/desktop"), encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
}

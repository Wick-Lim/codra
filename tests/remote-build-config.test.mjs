/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["scripts/verify-remote-build-config.mjs"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
);

assert.equal(
  result.status,
  0,
  `remote build configuration verifier failed:\n${result.stderr || result.stdout}`,
);

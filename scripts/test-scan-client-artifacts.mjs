/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "codra-scan-artifacts-"));
  const trees = {
    main: join(root, "apps/desktop/out/main"),
    preload: join(root, "apps/desktop/out/preload"),
    renderer: join(root, "apps/desktop/out/renderer/assets"),
    web: join(root, "apps/web/dist/assets"),
  };
  for (const directory of Object.values(trees)) {
    await mkdir(directory, { recursive: true });
  }
  // Desktop main legitimately carries the public browser apiKey and the
  // node-datachannel require, exactly as the real release bundle does.
  await writeFile(
    join(trees.main, "index.js"),
    'const CODRA_PROJECT_ID = "codra-1b3bb";\n' +
      'const apiKey = "AIzaSyDqVsIBxX09Gv3WQJSgvE51uU4DfJU4x2o";\n' +
      'requireFromMain("node-datachannel");\n',
  );
  // Unminified desktop shape, plus the `return:` sequence that a naive
  // substring rule for "turn:" would falsely deny.
  await writeFile(
    join(trees.preload, "index.js"),
    'const BRIDGE_FIREBASE_APP_ID = "1:92715578857:web:6c07f26a4866a1d4d3c778";\n',
  );
  await writeFile(
    join(trees.renderer, "index-clean.js"),
    'const DEMO_PROJECT_ID = "demo-codra";\n' +
      'const AUTH_ORIGIN = "http://127.0.0.1:9099";\n' +
      'const FLAVOR = "remote-test";\n' +
      'const ALIAS = "password-test-only";\n' +
      "const handlers = { return: async () => undefined };\n" +
      'const label = "Cloudflare TURN is used only when required";\n',
  );
  // Minified web shape: the same values with no readable identifiers.
  await writeFile(
    join(trees.web, "index-clean.js"),
    'Fd="demo-codra",Ge="AIzaSyDqVsIBxX09Gv3WQJSgvE51uU4DfJU4x2o",Hj="1:92715578857:web:6c07f26a4866a1d4d3c778";\n',
  );
  return root;
}

function runScanner(root) {
  return spawnSync(
    process.execPath,
    ["scripts/scan-client-artifacts.mjs", "--root", root],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

const cleanRoot = await createFixtureRoot();
const clean = runScanner(cleanRoot);
assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);

const poisonedRoot = await createFixtureRoot();
await writeFile(
  join(poisonedRoot, "apps/desktop/out/renderer/assets/index-poison.js"),
  'Ee="AIzaSyPOISONPOISONPOISON99";\n',
);
await writeFile(
  join(poisonedRoot, "apps/desktop/out/preload/turn.js"),
  'const ice = "turns://relay.example.net:5349";\n',
);
await writeFile(
  join(poisonedRoot, "apps/web/dist/assets/index-poison.js"),
  "const s = process.env.CLOUDFLARE_TURN_CONFIG;\n",
);
const poisoned = runScanner(poisonedRoot);
assert.notEqual(poisoned.status, 0, "poisoned client artifacts must be denied");
assert.match(poisoned.stderr, /firebase-api-key/u);
assert.match(poisoned.stderr, /turn-url/u);
assert.match(poisoned.stderr, /turn-secret-name/u);

const emptyRoot = await mkdtemp(join(tmpdir(), "codra-scan-artifacts-empty-"));
const unbuilt = runScanner(emptyRoot);
assert.notEqual(unbuilt.status, 0, "an unbuilt tree must be denied");
assert.match(unbuilt.stderr, /Run pnpm build first/u);

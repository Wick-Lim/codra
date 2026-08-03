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
  // `keyId` and `kid` are ordinary JWT/JWK/WebAuthn field names. A vendored
  // dependency shipping one is not the Cloudflare TURN credential, so
  // signing-key-id-field must not deny a bare identifier, a property access,
  // or a shorthand property.
  await writeFile(
    join(trees.renderer, "index-jwk.js"),
    "const keyId = header.kid;\n" +
      'const signer = { alg: "RS256", keyId };\n' +
      "export const readKeyId = (jwk) => jwk.keyId ?? jwk.kid;\n",
  );
  // Minified dependency shape: an unquoted object key survives minification
  // as a bare identifier, which is not the serialized form the rule anchors on.
  await writeFile(
    join(trees.web, "index-jwk.js"),
    'Nb=Ob.kid,Pc={alg:"RS256",keyId:Nb};\n',
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
// A future contributor could import the remote-test auto-approve seam's
// implementation file directly from shared main-process code instead of
// only through the Vite alias, or read its env var outside the alias
// swap. Neither mistake would touch electron.vite.config.ts, so
// verify-remote-build-config.mjs would stay green; only the artifact
// scanner would catch it.
await writeFile(
  join(poisonedRoot, "apps/desktop/out/main/session-auto-approve-leak.js"),
  'const alias = "session-auto-approve-test-only";\n' +
    "const flag = process.env.CODRA_REMOTE_TEST_AUTO_APPROVE;\n",
);
// The Cloudflare TURN credential's serialized shape
// (docs/runbooks/cloudflare-turn.md:11), in the two forms it can reach a
// bundle in. Only the keyId key appears in either, so each denial is
// attributable to signing-key-id-field alone rather than to the sibling
// bearerToken rule.
//
// Pretty-printed, as the secret is written by hand.
await writeFile(
  join(poisonedRoot, "apps/desktop/out/renderer/assets/index-turn-config.js"),
  'const turnConfig = { "keyId": "e1b0c44298fc1c14" };\n',
);
// Inlined by the bundler from a JSON-valued env var, which escapes every
// inner quote. This is the likelier leak and the one an unescaped anchor
// would miss.
await writeFile(
  join(poisonedRoot, "apps/web/dist/assets/index-turn-config.js"),
  'const turnConfig = "{\\"keyId\\":\\"e1b0c44298fc1c14\\"}";\n',
);
const poisoned = runScanner(poisonedRoot);
assert.notEqual(poisoned.status, 0, "poisoned client artifacts must be denied");
assert.match(poisoned.stderr, /firebase-api-key/u);
assert.match(poisoned.stderr, /turn-url/u);
assert.match(poisoned.stderr, /turn-secret-name/u);
assert.match(poisoned.stderr, /session-auto-approve-test-alias/u);
assert.match(poisoned.stderr, /remote-test-auto-approve-env/u);
assert.match(
  poisoned.stderr,
  /signing-key-id-field apps\/desktop\/out\/renderer\/assets\/index-turn-config\.js/u,
);
assert.match(
  poisoned.stderr,
  /signing-key-id-field apps\/web\/dist\/assets\/index-turn-config\.js/u,
);
// The same run carries both JWK fixtures. No signing-key-id-field denial may
// name either of them.
assert.doesNotMatch(poisoned.stderr, /signing-key-id-field \S*index-jwk\.js/u);

const emptyRoot = await mkdtemp(join(tmpdir(), "codra-scan-artifacts-empty-"));
const unbuilt = runScanner(emptyRoot);
assert.notEqual(unbuilt.status, 0, "an unbuilt tree must be denied");
assert.match(unbuilt.stderr, /Run pnpm build first/u);

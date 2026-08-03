/* global process */

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

async function read(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

function requireText(text, fragment, source) {
  assert.ok(text.includes(fragment), `${source} must include ${fragment}`);
}

function forbidText(text, fragment, source) {
  assert.ok(!text.includes(fragment), `${source} must not include ${fragment}`);
}

const [
  workspaceYaml,
  rootPackageText,
  desktopPackageText,
  releaseVite,
  remoteVite,
  releaseBuilder,
  remoteBuilder,
  firebaseJsonText,
  firebaseEmulatorJsonText,
  webVite,
  webRemoteVite,
  playwrightConfigText,
] = await Promise.all([
  read("pnpm-workspace.yaml"),
  read("package.json"),
  read("apps/desktop/package.json"),
  read("apps/desktop/electron.vite.config.ts"),
  read("apps/desktop/electron.remote-test.vite.config.ts"),
  read("apps/desktop/electron-builder.yml"),
  read("apps/desktop/electron-builder.remote-test.yml"),
  read("firebase.json"),
  read("firebase.emulator.json"),
  read("apps/web/vite.config.ts"),
  read("apps/web/vite.remote-test.config.ts"),
  read("playwright.config.ts"),
]);

const rootPackage = JSON.parse(rootPackageText);
const desktopPackage = JSON.parse(desktopPackageText);
const firebaseConfig = JSON.parse(firebaseJsonText);
const firebaseEmulatorConfig = JSON.parse(firebaseEmulatorJsonText);

requireText(workspaceYaml, "- functions", "pnpm-workspace.yaml");
requireText(workspaceYaml, "node-datachannel: true", "pnpm-workspace.yaml");
assert.equal(rootPackage.devDependencies["firebase-admin"], "14.2.0");
assert.equal(rootPackage.devDependencies["firebase-tools"], "15.25.1");
assert.equal(
  rootPackage.devDependencies["@firebase/rules-unit-testing"],
  "5.0.1",
);
assert.equal(desktopPackage.dependencies.firebase, "12.17.0");
assert.equal(desktopPackage.dependencies["node-datachannel"], "0.32.3");
assert.equal(desktopPackage.dependencies["@codra/firebase"], "workspace:*");
assert.equal(desktopPackage.dependencies["@codra/webrtc"], "workspace:*");
assert.equal(
  desktopPackage.dependencies["@codra/remote-client"],
  "workspace:*",
);

// Workspace packages ship raw TypeScript, so electron-vite must bundle them
// rather than leave a runtime `require` the packaged app cannot resolve.
for (const [config, source] of [
  [releaseVite, "release Vite config"],
  [remoteVite, "remote-test Vite config"],
]) {
  assert.equal(
    (config.match(/"@codra\/remote-client",/gu) ?? []).length,
    2,
    `${source} must exclude @codra/remote-client from externalizeDepsPlugin in both main and preload`,
  );
}

requireText(releaseVite, "safe-storage-electron.ts", "release Vite config");
requireText(releaseVite, "account-bootstrap-google.ts", "release Vite config");
requireText(releaseVite, "firebase-production.ts", "release Vite config");
requireText(
  releaseVite,
  "session-auto-approve-production.ts",
  "release Vite config",
);
forbidText(releaseVite, "safe-storage-test-only", "release Vite config");
forbidText(releaseVite, "demo-codra", "release Vite config");
forbidText(releaseVite, "signInWithEmailAndPassword", "release Vite config");
forbidText(
  releaseVite,
  "session-auto-approve-test-only",
  "release Vite config",
);
forbidText(
  releaseVite,
  "CODRA_REMOTE_TEST_AUTO_APPROVE",
  "release Vite config",
);

requireText(remoteVite, "safe-storage-test-only.ts", "remote-test Vite config");
requireText(
  remoteVite,
  "account-bootstrap-test-only.ts",
  "remote-test Vite config",
);
requireText(remoteVite, "firebase-emulator.ts", "remote-test Vite config");
requireText(
  remoteVite,
  "session-auto-approve-test-only.ts",
  "remote-test Vite config",
);
requireText(remoteVite, "out-remote-test", "remote-test Vite config");
requireText(webVite, "account-bootstrap-google.ts", "web release Vite config");
requireText(webVite, "firebase-production.ts", "web release Vite config");
forbidText(webVite, "demo-codra", "web release Vite config");
requireText(
  webRemoteVite,
  "account-bootstrap-test-only.ts",
  "web remote-test Vite config",
);
requireText(
  webRemoteVite,
  "firebase-emulator.ts",
  "web remote-test Vite config",
);

requireText(
  releaseBuilder,
  "appId: com.codra.desktop",
  "release builder config",
);
requireText(
  releaseBuilder,
  "node_modules/node-datachannel/**/*",
  "release builder config",
);
requireText(
  remoteBuilder,
  "appId: com.codra.desktop.remote-test",
  "remote-test builder config",
);
requireText(
  remoteBuilder,
  "productName: CODRA Remote Test",
  "remote-test builder config",
);
requireText(
  remoteBuilder,
  "output: dist-remote-test",
  "remote-test builder config",
);
requireText(
  remoteBuilder,
  "node_modules/node-datachannel/**/*",
  "remote-test builder config",
);

assert.deepEqual(firebaseConfig.emulators.auth, {
  host: "127.0.0.1",
  port: 9099,
});
assert.deepEqual(firebaseConfig.emulators.firestore, {
  host: "127.0.0.1",
  port: 8080,
});
assert.deepEqual(firebaseConfig.emulators.functions, {
  host: "127.0.0.1",
  port: 5001,
});
assert.deepEqual(firebaseConfig.emulators.hosting, {
  host: "127.0.0.1",
  port: 5000,
});
assert.deepEqual(firebaseConfig.hosting.rewrites, [
  { source: "/desktop-auth", destination: "/index.html" },
  { source: "/login", destination: "/index.html" },
  { source: "**", destination: "/index.html" },
]);

// The two Hosting flavours must serve different trees. apps/web builds the
// production bundle to dist/ and the emulator bundle to dist-remote-test/
// (apps/web/vite.remote-test.config.ts). Pointing both configs at the same
// directory is the defect this pair of files exists to prevent: the Hosting
// emulator on 127.0.0.1:5000 would serve the production bundle aimed at the
// real project, and a stale emulator build would become deployable.
assert.equal(firebaseConfig.hosting.public, "apps/web/dist");
assert.equal(
  firebaseEmulatorConfig.hosting.public,
  "apps/web/dist-remote-test",
);
forbidText(firebaseJsonText, "dist-remote-test", "firebase.json");
forbidText(firebaseEmulatorJsonText, "codra-1b3bb", "firebase.emulator.json");

// Everything except the served tree and the CSP is shared, so the emulator
// config cannot drift into rewriting differently or binding other ports.
assert.deepEqual(
  firebaseEmulatorConfig.hosting.rewrites,
  firebaseConfig.hosting.rewrites,
  "firebase.emulator.json must carry firebase.json's SPA rewrites verbatim",
);
assert.deepEqual(firebaseEmulatorConfig.emulators, firebaseConfig.emulators);
assert.deepEqual(firebaseEmulatorConfig.firestore, firebaseConfig.firestore);
assert.deepEqual(firebaseEmulatorConfig.functions, firebaseConfig.functions);

function hostingHeaders(config, source) {
  const blocks = config.hosting.headers ?? [];
  assert.deepEqual(
    blocks.map((block) => block.source),
    ["**"],
    `${source} must apply one header block to every hosted path`,
  );
  const applied = new Map();
  for (const block of blocks)
    for (const header of block.headers) applied.set(header.key, header.value);
  return applied;
}

const productionHeaders = hostingHeaders(firebaseConfig, "firebase.json");
const emulatorHeaders = hostingHeaders(
  firebaseEmulatorConfig,
  "firebase.emulator.json",
);
const productionCsp = productionHeaders.get("Content-Security-Policy");
const emulatorCsp = emulatorHeaders.get("Content-Security-Policy");

// A header policy and the meta policy that apps/web/csp-plugin.ts bakes into
// index.html compose by intersection, so serving the production policy over
// the emulator bundle would narrow connect-src to 'self' and block every call
// to the Auth, Firestore, and Functions emulators.
for (const origin of [
  "http://127.0.0.1:9099",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:5001",
])
  requireText(emulatorCsp, origin, "firebase.emulator.json CSP");
for (const productionOnly of [
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firestore.googleapis.com",
  "cloudfunctions.net",
  "apis.google.com",
])
  forbidText(emulatorCsp, productionOnly, "firebase.emulator.json CSP");
forbidText(productionCsp, "127.0.0.1", "firebase.json CSP");
forbidText(productionCsp, "localhost", "firebase.json CSP");
forbidText(productionCsp, "http://", "firebase.json CSP");

// frame-ancestors is ignored inside <meta http-equiv>, so both flavours must
// deliver the clickjacking defence as real response headers.
for (const [csp, source] of [
  [productionCsp, "firebase.json CSP"],
  [emulatorCsp, "firebase.emulator.json CSP"],
])
  requireText(csp, "frame-ancestors 'none'", source);
for (const key of [
  "Referrer-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
])
  assert.equal(
    emulatorHeaders.get(key),
    productionHeaders.get(key),
    `firebase.emulator.json must mirror firebase.json's ${key}`,
  );

assert.equal(
  firebaseEmulatorConfig.auth,
  undefined,
  "firebase.emulator.json must not carry an auth block; the Auth emulator ignores it",
);

// The Hosting emulator can only serve a bundle that exists, and it must read
// the emulator config rather than the production one.
requireText(
  rootPackage.scripts["firebase:emulators"],
  "pnpm --filter @codra/web build:remote-test",
  "firebase:emulators script",
);
requireText(
  rootPackage.scripts["firebase:emulators"],
  "--config firebase.emulator.json",
  "firebase:emulators script",
);
forbidText(
  rootPackage.scripts["firebase:emulators"],
  "--config firebase.json",
  "firebase:emulators script",
);

for (const script of [
  "firebase:emulators",
  "test:firebase-rules",
  "build:remote-test",
  "package:remote-test",
  "verify:native-package",
  "verify:remote-build-config",
  "verify:firebase-indexes",
  "scan:client-artifacts",
  "test:firebase-claim-canary",
  "resume:firebase-claim-canary",
]) {
  assert.equal(
    typeof rootPackage.scripts[script],
    "string",
    `missing ${script} script`,
  );
}

// A Playwright project runs nothing without an explicit testMatch, and a spec
// nobody can invoke is a spec nobody runs, so each of these needs all three of
// a project, a testMatch, and a root script naming that project.
const REMOTE_PLAYWRIGHT_PROJECTS = [
  "remote-harness",
  "remote-direct",
  "remote-reconnect",
  "remote-agent-workspace",
  "web-console",
];
for (const project of REMOTE_PLAYWRIGHT_PROJECTS) {
  requireText(playwrightConfigText, `name: "${project}"`, "Playwright config");
  requireText(
    playwrightConfigText,
    `testMatch: "${project}.spec.ts"`,
    "Playwright config",
  );
  assert.equal(
    rootPackage.scripts[`test:${project}`],
    `playwright test --project=${project}`,
    `test:${project} must select the ${project} project`,
  );
}
assert.equal(
  (playwrightConfigText.match(/^ {6}timeout: /gmu) ?? []).length,
  REMOTE_PLAYWRIGHT_PROJECTS.length,
  "each remote Playwright project must set its own timeout",
);

for (const file of [
  "apps/desktop/src/main/remote/safe-storage-electron.ts",
  "apps/desktop/src/main/remote/safe-storage-test-only.ts",
  "apps/desktop/src/main/remote/account-bootstrap-google.ts",
  "apps/desktop/src/main/remote/account-bootstrap-test-only.ts",
  "apps/desktop/src/main/remote/firebase-production.ts",
  "apps/desktop/src/main/remote/firebase-emulator.ts",
  "apps/desktop/src/main/remote/session-auto-approve-production.ts",
  "apps/desktop/src/main/remote/session-auto-approve-test-only.ts",
  "apps/web/src/remote/account-bootstrap-google.ts",
  "apps/web/src/remote/account-bootstrap-test-only.ts",
  "apps/web/src/remote/firebase-production.ts",
  "apps/web/src/remote/firebase-emulator.ts",
  "scripts/package-remote-test.mjs",
  "scripts/ensure-remote-test-after-pack.mjs",
  "scripts/live-test-guard.mjs",
  "scripts/stage-functions-deploy.mjs",
  "scripts/verify-node-datachannel-package.mjs",
  "functions-deploy/package.json",
  "functions-deploy/pnpm-lock.yaml",
  "functions-deploy/pnpm-lock.fixture.yaml",
  "functions-deploy/.npmrc",
]) {
  await access(resolve(root, file));
}

const [readmeText, remoteRunbook] = await Promise.all([
  read("README.md"),
  read("docs/runbooks/remote-access.md"),
]);

assert.equal(
  firebaseConfig.auth,
  undefined,
  "firebase.json must not carry an auth block; production providers are recorded in docs/runbooks/remote-access.md",
);

forbidText(readmeText, "does not require an account or login", "README.md");
forbidText(readmeText, "deferred to a future phase", "README.md");
requireText(readmeText, "docs/runbooks/remote-access.md", "README.md");

// Production forces `iceTransportPolicy: "relay"` on every session
// (apps/desktop/src/main/remote/native-peer.ts,
// apps/web/src/remote/browser-peer.ts), so there is no direct peer path to
// describe. Both documents claimed one for months; this keeps the claim from
// growing back. The privacy claim they also make — encrypted end to end, never
// through the control plane — is true under either topology and is what the
// two Firestore scans enforce.
for (const [text, source] of [
  [readmeText, "README.md"],
  [remoteRunbook, "remote access runbook"],
]) {
  assert.ok(
    !/direct (peer|WebRTC) connection/iu.test(text),
    `${source} must not use the phrase "direct peer connection": production ` +
      'sets iceTransportPolicy: "relay" on every session, so no session has ' +
      "one. Describe the traffic as relayed and encrypted end to end; if you " +
      'need to deny the topology, write "no direct path".',
  );
}
requireText(readmeText, 'iceTransportPolicy: "relay"', "README.md");
requireText(
  remoteRunbook,
  "## Every production session is relayed",
  "remote access runbook",
);
// The console is the second client the host serves, and the one property a
// reader is most likely to assume wrongly.
requireText(readmeText, "/console", "README.md");
requireText(readmeText, "launches its own agent", "README.md");

requireText(
  remoteRunbook,
  "## Production Identity Platform providers",
  "remote access runbook",
);
requireText(
  remoteRunbook,
  "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
  "remote access runbook",
);
requireText(
  remoteRunbook,
  "firebase deploy --only functions --project codra-1b3bb",
  "remote access runbook",
);
requireText(
  remoteRunbook,
  "firebase deploy --only hosting --project codra-1b3bb",
  "remote access runbook",
);

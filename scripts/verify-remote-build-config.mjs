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
  webVite,
  webRemoteVite,
] = await Promise.all([
  read("pnpm-workspace.yaml"),
  read("package.json"),
  read("apps/desktop/package.json"),
  read("apps/desktop/electron.vite.config.ts"),
  read("apps/desktop/electron.remote-test.vite.config.ts"),
  read("apps/desktop/electron-builder.yml"),
  read("apps/desktop/electron-builder.remote-test.yml"),
  read("firebase.json"),
  read("apps/web/vite.config.ts"),
  read("apps/web/vite.remote-test.config.ts"),
]);

const rootPackage = JSON.parse(rootPackageText);
const desktopPackage = JSON.parse(desktopPackageText);
const firebaseConfig = JSON.parse(firebaseJsonText);

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

requireText(releaseVite, "safe-storage-electron.ts", "release Vite config");
requireText(releaseVite, "account-bootstrap-google.ts", "release Vite config");
requireText(releaseVite, "firebase-production.ts", "release Vite config");
forbidText(releaseVite, "safe-storage-test-only", "release Vite config");
forbidText(releaseVite, "demo-codra", "release Vite config");
forbidText(releaseVite, "signInWithEmailAndPassword", "release Vite config");

requireText(remoteVite, "safe-storage-test-only.ts", "remote-test Vite config");
requireText(
  remoteVite,
  "account-bootstrap-test-only.ts",
  "remote-test Vite config",
);
requireText(remoteVite, "firebase-emulator.ts", "remote-test Vite config");
requireText(remoteVite, '"demo-codra"', "remote-test Vite config");
requireText(remoteVite, '"http://127.0.0.1:5000"', "remote-test Vite config");
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
requireText(webRemoteVite, '"demo-codra"', "web remote-test Vite config");

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
]);

for (const script of [
  "firebase:emulators",
  "test:firebase-rules",
  "build:remote-test",
  "package:remote-test",
  "verify:native-package",
  "verify:remote-build-config",
  "verify:firebase-indexes",
  "test:firebase-claim-canary",
  "resume:firebase-claim-canary",
]) {
  assert.equal(
    typeof rootPackage.scripts[script],
    "string",
    `missing ${script} script`,
  );
}

for (const file of [
  "apps/desktop/src/main/remote/safe-storage-electron.ts",
  "apps/desktop/src/main/remote/safe-storage-test-only.ts",
  "apps/desktop/src/main/remote/account-bootstrap-google.ts",
  "apps/desktop/src/main/remote/account-bootstrap-test-only.ts",
  "apps/desktop/src/main/remote/firebase-production.ts",
  "apps/desktop/src/main/remote/firebase-emulator.ts",
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

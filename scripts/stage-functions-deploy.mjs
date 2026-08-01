/* global Buffer, process */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

if (!process.argv.includes("--fixture")) {
  throw new Error(
    "Actual Functions staging is deferred until Task 4 and Task 5 exports exist.",
  );
}

const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputPath) {
  throw new Error("--output requires a path");
}
const target = resolve(outputPath ?? "functions-deploy-fixture");
await rm(target, { recursive: true, force: true });
await mkdir(resolve(target, "lib"), { recursive: true });
await mkdir(resolve(target, "vendor"), { recursive: true });

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function createDeterministicPackageTarball() {
  const packageFiles = [
    [
      "package/package.json",
      Buffer.from(
        `${JSON.stringify({
          name: "@codra/protocol",
          version: "0.0.1",
          type: "module",
          main: "./index.js",
          exports: { ".": "./index.js" },
        })}\n`,
        "utf8",
      ),
    ],
    [
      "package/index.js",
      Buffer.from("export const REMOTE_PROTOCOL_VERSION = 1;\n", "utf8"),
    ],
  ];
  const chunks = [];
  for (const [name, contents] of packageFiles) {
    chunks.push(tarHeader(name, contents.length), contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

const protocolTarball = createDeterministicPackageTarball();
const functionsSource = Buffer.from(
  'export const fixture = true;\nexport const region = "asia-northeast3";\n',
  "utf8",
);
const deployLock = await readFile(
  resolve("functions-deploy", "pnpm-lock.fixture.yaml"),
);
const deployNpmrc = await readFile(resolve("functions-deploy", ".npmrc"));
const packageJson = Buffer.from(
  `${JSON.stringify({
    name: "@codra/functions-deploy-fixture",
    private: true,
    type: "module",
    dependencies: {
      "@codra/protocol": "file:vendor/codra-protocol-0.0.1.tgz",
    },
  })}\n`,
  "utf8",
);
const files = [
  ["lib/index.js", functionsSource],
  ["vendor/codra-protocol-0.0.1.tgz", protocolTarball],
  ["package.json", packageJson],
  [".npmrc", deployNpmrc],
  ["pnpm-lock.yaml", deployLock],
];
for (const [relative, contents] of files) {
  await writeFile(resolve(target, relative), contents, { mode: 0o644 });
}

const hash = createHash("sha256");
for (const [relative, contents] of files) {
  hash.update(relative).update("\0").update(contents);
}
const manifest = {
  schemaVersion: 1,
  projectId: "codra-1b3bb",
  fixture: true,
  region: "asia-northeast3",
  files: files.map(([relative]) => relative).sort(),
  protocolTarballSha256: createHash("sha256")
    .update(protocolTarball)
    .digest("hex"),
  stageSha256: hash.digest("hex"),
};
await writeFile(
  resolve(target, "functions-component-manifest.json"),
  `${JSON.stringify(manifest)}\n`,
  { mode: 0o644 },
);

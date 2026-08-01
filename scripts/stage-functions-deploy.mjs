/* global Buffer, process */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";

const fixture = process.argv.includes("--fixture");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputPath)
  throw new Error("--output requires a path");
const target = resolve(
  outputPath ??
    (fixture ? "functions-deploy-fixture" : "functions-deploy-build"),
);
const sourceDeployRoot = resolve("functions-deploy");
const sourceNpmrc = await readFile(resolve(sourceDeployRoot, ".npmrc"));
const sourcePackage = await readFile(resolve(sourceDeployRoot, "package.json"));
const sourceLock = await readFile(resolve(sourceDeployRoot, "pnpm-lock.yaml"));
const sourceFixtureLock = await readFile(
  resolve(sourceDeployRoot, "pnpm-lock.fixture.yaml"),
);
await rm(target, { recursive: true, force: true });
await mkdir(resolve(target, "lib"), { recursive: true });
await mkdir(resolve(target, "vendor"), { recursive: true });

function tarHeader(name, size) {
  if (Buffer.byteLength(name) > 100)
    throw new Error(`Tar path is too long: ${name}`);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function createDeterministicPackageTarball(entries) {
  const chunks = [];
  for (const [name, contents] of entries.toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    chunks.push(tarHeader(name, contents.length), contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

async function collectFiles(root, prefix = "") {
  const result = [];
  for (const name of (await readdir(root)).sort()) {
    const absolute = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await stat(absolute);
    if (info.isDirectory())
      result.push(...(await collectFiles(absolute, relative)));
    else result.push([relative, await readFile(absolute)]);
  }
  return result;
}

function addNodeEsmExtensions(contents) {
  const source = contents.toString("utf8");
  return Buffer.from(
    source.replace(
      /(from\s+['"]|import\(\s*['"])(\.[^'"]+)(['"])/g,
      (match, prefix, path, quote) =>
        path.endsWith(".js") ? match : `${prefix}${path}.js${quote}`,
    ),
    "utf8",
  );
}

const deployNpmrc = sourceNpmrc;
let protocolTarball;
let packageJson;
let deployLock;
let functionFiles;
if (fixture) {
  protocolTarball = createDeterministicPackageTarball([
    [
      "package/index.js",
      Buffer.from("export const REMOTE_PROTOCOL_VERSION = 1;\n", "utf8"),
    ],
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
  ]);
  functionFiles = [
    [
      "lib/index.js",
      Buffer.from(
        'export const fixture = true;\nexport const region = "asia-northeast3";\n',
        "utf8",
      ),
    ],
  ];
  deployLock = sourceFixtureLock;
  packageJson = Buffer.from(
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
} else {
  const protocolDist = resolve("packages/protocol/dist");
  const functionsDist = resolve("functions/dist");
  const protocolPackage = resolve("packages/protocol/package.json");
  if (!(await stat(protocolDist).catch(() => false)))
    throw new Error("Build @codra/protocol before staging Functions.");
  if (!(await stat(functionsDist).catch(() => false)))
    throw new Error("Build @codra/functions before staging Functions.");
  const protocolEntries = (await collectFiles(protocolDist, "package")).map(
    ([relative, contents]) => [
      relative,
      relative.endsWith(".js") ? addNodeEsmExtensions(contents) : contents,
    ],
  );
  protocolEntries.push([
    "package/package.json",
    Buffer.from(
      `${JSON.stringify({
        name: "@codra/protocol",
        version: JSON.parse(await readFile(protocolPackage, "utf8")).version,
        type: "module",
        main: "./index.js",
        exports: {
          ".": "./index.js",
          "./production": "./production.js",
          "./emulator": "./emulator.js",
        },
      })}\n`,
      "utf8",
    ),
  ]);
  protocolTarball = createDeterministicPackageTarball(protocolEntries);
  functionFiles = (await collectFiles(functionsDist, "lib")).filter(
    ([relative]) =>
      !relative.endsWith(".map") &&
      !relative.endsWith(".d.ts") &&
      !relative.includes(".test."),
  );
  functionFiles = functionFiles.map(([relative, contents]) => [
    relative,
    addNodeEsmExtensions(contents),
  ]);
  packageJson = sourcePackage;
  deployLock = sourceLock;
}

const files = [
  ...functionFiles,
  ["vendor/codra-protocol-0.0.1.tgz", protocolTarball],
  ["package.json", packageJson],
  [".npmrc", deployNpmrc],
  ["pnpm-lock.yaml", deployLock],
];
for (const [relative, contents] of files) {
  await writeFile(resolve(target, relative), contents, { mode: 0o644 });
}

const hash = createHash("sha256");
for (const [relative, contents] of files)
  hash.update(relative).update("\0").update(contents);
const manifest = {
  schemaVersion: 1,
  projectId: "codra-1b3bb",
  fixture,
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

/* global process */

import assert from "node:assert/strict";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootIndex = process.argv.indexOf("--root");
const rootArgument = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
if (rootIndex >= 0 && !rootArgument) throw new Error("--root requires a path");
const artifactRoot = resolve(rootArgument ?? process.cwd());
const baselinePath = resolve(
  process.cwd(),
  "docs/security/remote-baseline.json",
);

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
assert.equal(
  baseline.schemaVersion,
  2,
  "remote baseline schemaVersion must be 2",
);
assert.match(
  baseline.baselineCommit,
  /^[0-9a-f]{40}$/u,
  "remote baseline baselineCommit must be a 40-hex commit id",
);
assert.equal(
  baseline.purpose,
  "remote-implementation-secret-scan",
  "remote baseline purpose must be remote-implementation-secret-scan",
);

const treeIds = Object.keys(baseline.trees).sort();
assert.deepEqual(
  treeIds,
  ["desktop-main", "desktop-preload", "desktop-renderer", "web"],
  "remote baseline must declare exactly the four client artifact trees",
);
assert.ok(
  Array.isArray(baseline.rules) && baseline.rules.length > 0,
  "remote baseline must declare at least one rule",
);
for (const rule of baseline.rules) {
  assert.match(rule.id, /^[a-z0-9-]{3,60}$/u, "rule id must be kebab-case");
  assert.ok(
    rule.kind === "literal" || rule.kind === "regex",
    `rule ${rule.id} kind must be literal or regex`,
  );
  assert.ok(
    typeof rule.pattern === "string" && rule.pattern.length > 0,
    `rule ${rule.id} must declare a pattern`,
  );
  assert.ok(
    Array.isArray(rule.trees) && rule.trees.length > 0,
    `rule ${rule.id} must declare at least one tree`,
  );
  for (const treeId of rule.trees) {
    assert.ok(
      Object.hasOwn(baseline.trees, treeId),
      `rule ${rule.id} names unknown tree ${treeId}`,
    );
  }
}

async function collectFiles(directory, prefix) {
  const collected = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolute = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(absolute);
    assert.equal(
      info.isSymbolicLink(),
      false,
      `symlink is forbidden: ${relative}`,
    );
    if (info.isDirectory())
      collected.push(...(await collectFiles(absolute, relative)));
    else collected.push([relative, await readFile(absolute, "utf8")]);
  }
  return collected;
}

const trees = new Map();
for (const treeId of treeIds) {
  const relativePath = baseline.trees[treeId];
  const absolute = resolve(artifactRoot, relativePath);
  if (!(await stat(absolute).catch(() => false)))
    throw new Error(`Run pnpm build first: ${relativePath} is missing.`);
  const files = await collectFiles(absolute, "");
  assert.ok(
    files.length > 0,
    `Run pnpm build first: ${relativePath} is empty.`,
  );
  trees.set(treeId, files);
}

const denials = [];
for (const rule of baseline.rules) {
  const expression =
    rule.kind === "regex" ? new RegExp(rule.pattern, "u") : undefined;
  for (const treeId of rule.trees) {
    for (const [relative, text] of trees.get(treeId)) {
      const denied = expression
        ? expression.test(text)
        : text.includes(rule.pattern);
      if (denied)
        denials.push(`${rule.id} ${baseline.trees[treeId]}/${relative}`);
    }
  }
}
denials.sort();
assert.equal(
  denials.length,
  0,
  `client artifact scan denied:\n${denials.join("\n")}`,
);

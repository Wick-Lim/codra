import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const entryModule = join(packageRoot, "src/index.ts");

interface ExternalImport {
  readonly specifier: string;
  readonly importer: string;
}

interface ModuleGraph {
  readonly files: ReadonlySet<string>;
  readonly external: readonly ExternalImport[];
}

function workspacePackageDirectories(): ReadonlyMap<string, string> {
  const directories = new Map<string, string>();
  for (const group of ["packages", "apps"]) {
    const groupDirectory = join(repoRoot, group);
    if (!existsSync(groupDirectory)) continue;
    for (const name of readdirSync(groupDirectory)) {
      const manifestPath = join(groupDirectory, name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: string;
      };
      if (manifest.name) {
        directories.set(manifest.name, join(groupDirectory, name));
      }
    }
  }
  return directories;
}

function packageSubpathEntry(
  packageDirectory: string,
  subpath: string,
): string | undefined {
  const manifest = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  ) as { exports?: Record<string, string> };
  const target = manifest.exports?.[subpath];
  return target === undefined ? undefined : resolve(packageDirectory, target);
}

/**
 * Resolves a specifier to a TypeScript file inside this workspace, or returns
 * `undefined` when it points at an external package the graph must not follow.
 */
function resolveSpecifier(
  specifier: string,
  importer: string,
  packageDirectories: ReadonlyMap<string, string>,
): string | undefined {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(importer), specifier);
    for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
      if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  const packageDirectory = packageDirectories.get(packageName);
  if (packageDirectory === undefined) return undefined;
  const remainder = specifier.slice(packageName.length);
  return packageSubpathEntry(
    packageDirectory,
    remainder === "" ? "." : `.${remainder}`,
  );
}

/**
 * Every specifier a module pulls in at runtime. `import type` and
 * `export type` declarations are excluded because they erase at build.
 */
function valueImports(file: string): readonly string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const record = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isStringLiteral(node)) {
      specifiers.push(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly !== true) record(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) record(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node.arguments[0]);
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return specifiers;
}

function moduleGraph(entry: string): ModuleGraph {
  const packageDirectories = workspacePackageDirectories();
  const files = new Set<string>();
  const external: ExternalImport[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const specifier of valueImports(file)) {
      const resolved = resolveSpecifier(specifier, file, packageDirectories);
      if (resolved === undefined) {
        external.push({ specifier, importer: file });
      } else {
        queue.push(resolved);
      }
    }
  }
  return { files, external };
}

const graph = moduleGraph(entryModule);

describe("@codra/remote-client runtime module graph", () => {
  it("never value-imports node-datachannel", () => {
    const offenders = graph.external
      .filter(
        ({ specifier }) =>
          specifier === "node-datachannel" ||
          specifier.startsWith("node-datachannel/"),
      )
      .map(({ importer }) => relative(repoRoot, importer));
    expect(offenders).toEqual([]);
  });

  it("reaches the one module that names node-datachannel, type-only", () => {
    const channelModule = resolve(repoRoot, "packages/webrtc/src/channel.ts");
    expect(graph.files.has(channelModule)).toBe(true);
    expect(valueImports(channelModule)).not.toContain("node-datachannel");
  });
});

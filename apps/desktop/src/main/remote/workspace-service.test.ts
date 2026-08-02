import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceService,
  WorkspaceServiceError,
  type WorkspaceFileSystem,
} from "./workspace-service";

const temporaryDirectories: string[] = [];

async function makeFixture(): Promise<{
  root: string;
  home: string;
  outside: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codra-workspace-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const outside = join(root, "outside");
  await Promise.all([mkdir(home), mkdir(outside)]);
  return {
    root: await realpath(root),
    home: await realpath(home),
    outside: await realpath(outside),
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof WorkspaceServiceError ? error.code : undefined;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkspaceService", () => {
  it("lists home first, removes duplicate roots, and exposes directories only", async () => {
    const fixture = await makeFixture();
    await Promise.all([
      mkdir(join(fixture.home, "zeta")),
      mkdir(join(fixture.home, "Alpha")),
      writeFile(join(fixture.home, "token.txt"), "must not be listed", "utf8"),
    ]);
    const service = new WorkspaceService({
      homeDirectory: fixture.home,
      rootCandidates: async () => [fixture.home, fixture.root, fixture.home],
    });

    await expect(service.roots()).resolves.toEqual([
      { path: fixture.home, label: "Home" },
      { path: fixture.root, label: fixture.root.split("/").at(-1) },
    ]);
    const page = await service.list(fixture.home);

    expect(page.entries).toEqual([
      { path: join(fixture.home, "Alpha"), name: "Alpha" },
      { path: join(fixture.home, "zeta"), name: "zeta" },
    ]);
    expect(page.breadcrumbs).toEqual([{ path: fixture.home, label: "Home" }]);
    expect(JSON.stringify(page)).not.toContain("must not be listed");
    expect(JSON.stringify(page)).not.toContain("token.txt");
  });

  it("builds breadcrumbs from the most specific advertised root", async () => {
    const fixture = await makeFixture();
    const project = join(fixture.home, "work", "codra");
    await mkdir(project, { recursive: true });
    const service = new WorkspaceService({
      homeDirectory: fixture.home,
      rootCandidates: async () => [fixture.root, fixture.home],
    });

    await expect(service.list(project)).resolves.toMatchObject({
      path: project,
      label: "codra",
      breadcrumbs: [
        { path: fixture.home, label: "Home" },
        { path: join(fixture.home, "work"), label: "work" },
        { path: project, label: "codra" },
      ],
    });
  });

  it("rejects files, missing paths, and symlinks escaping the advertised roots", async () => {
    const fixture = await makeFixture();
    const file = join(fixture.home, "notes.txt");
    const escape = join(fixture.home, "escape");
    await writeFile(file, "notes", "utf8");
    await symlink(fixture.outside, escape, "dir");
    const service = new WorkspaceService({
      homeDirectory: fixture.home,
      rootCandidates: async () => [fixture.home],
    });

    await expect(service.validate(file)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "WORKSPACE_NOT_DIRECTORY",
    );
    await expect(
      service.validate(join(fixture.home, "missing")),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "WORKSPACE_NOT_FOUND",
    );
    await expect(service.validate(escape)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "WORKSPACE_OUTSIDE_ROOTS",
    );
    await expect(service.list(fixture.home)).resolves.toMatchObject({
      entries: [],
    });
  });

  it("translates filesystem permission failures without leaking raw errors", async () => {
    const fixture = await makeFixture();
    const denied = join(fixture.home, "denied");
    await mkdir(denied);
    const realFileSystem: WorkspaceFileSystem = {
      access,
      realpath,
      readdir,
      stat,
    };
    const fileSystem: WorkspaceFileSystem = {
      ...realFileSystem,
      async readdir(path, options) {
        if (path === denied) {
          throw Object.assign(new Error("private operating-system detail"), {
            code: "EACCES",
          });
        }
        return realFileSystem.readdir(path, options);
      },
    };
    const service = new WorkspaceService({
      fileSystem,
      homeDirectory: fixture.home,
      rootCandidates: async () => [fixture.home],
    });

    await expect(service.list(denied)).rejects.toMatchObject({
      code: "WORKSPACE_PERMISSION_DENIED",
      message: "WORKSPACE_PERMISSION_DENIED",
    });
  });

  it("caps directory pages by entry count and encoded metadata size", async () => {
    const fixture = await makeFixture();
    const dense = join(fixture.home, "dense");
    await mkdir(dense);
    await Promise.all(
      Array.from({ length: 260 }, (_, index) =>
        mkdir(
          join(dense, `${String(index).padStart(3, "0")}-${"x".repeat(210)}`),
        ),
      ),
    );
    const service = new WorkspaceService({
      homeDirectory: fixture.home,
      rootCandidates: async () => [fixture.home],
    });

    const page = await service.list(dense);

    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBeLessThanOrEqual(250);
    expect(
      new TextEncoder().encode(JSON.stringify(page)).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
    expect(page.entries[0]?.name.startsWith("000-")).toBe(true);
  });

  it("revalidates canonical directory state and cancels stale requests", async () => {
    const fixture = await makeFixture();
    const project = join(fixture.home, "project");
    await mkdir(project);
    const service = new WorkspaceService({
      homeDirectory: fixture.home,
      rootCandidates: async () => [fixture.home],
    });
    await expect(service.validate(project)).resolves.toEqual({
      path: project,
      label: "project",
    });
    await rm(project, { recursive: true });
    await expect(service.validate(project)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "WORKSPACE_NOT_FOUND",
    );

    const abort = new AbortController();
    abort.abort();
    await expect(service.list(fixture.home, abort.signal)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "WORKSPACE_REQUEST_ABORTED",
    );
  });
});

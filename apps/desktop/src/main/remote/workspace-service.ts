import { constants } from "node:fs";
import {
  access as nodeAccess,
  realpath as nodeRealpath,
  readdir as nodeReaddir,
  stat as nodeStat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse as parsePath, relative, sep } from "node:path";
import {
  TerminalCwdSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceRootSchema,
  WorkspaceSelectionSchema,
  WORKSPACE_DIRECTORY_MAX_ENTRIES,
  workspacePathLabel,
  type WorkspaceDirectoryPage,
  type WorkspaceRoot,
  type WorkspaceSelection,
} from "@codra/protocol";

export type WorkspaceServiceErrorCode =
  | "WORKSPACE_INVALID_PATH"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_DIRECTORY"
  | "WORKSPACE_PERMISSION_DENIED"
  | "WORKSPACE_OUTSIDE_ROOTS"
  | "WORKSPACE_REQUEST_ABORTED"
  | "WORKSPACE_IO_FAILED";

export class WorkspaceServiceError extends Error {
  constructor(readonly code: WorkspaceServiceErrorCode) {
    super(code);
    this.name = "WorkspaceServiceError";
  }
}

export interface WorkspaceDirectoryEntryLike {
  name: string;
  isDirectory(): boolean;
}

export interface WorkspaceStatsLike {
  isDirectory(): boolean;
}

export interface WorkspaceFileSystem {
  access(path: string, mode?: number): Promise<void>;
  realpath(path: string): Promise<string>;
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<WorkspaceDirectoryEntryLike[]>;
  stat(path: string): Promise<WorkspaceStatsLike>;
}

const defaultFileSystem: WorkspaceFileSystem = {
  access: nodeAccess,
  realpath: nodeRealpath,
  readdir: (path, options) => nodeReaddir(path, options),
  stat: nodeStat,
};

export interface WorkspaceServiceOptions {
  fileSystem?: WorkspaceFileSystem;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  rootCandidates?: () => Promise<readonly string[]>;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function translateFileSystemError(error: unknown): WorkspaceServiceError {
  if (error instanceof WorkspaceServiceError) return error;
  switch (nodeErrorCode(error)) {
    case "ENOENT":
      return new WorkspaceServiceError("WORKSPACE_NOT_FOUND");
    case "ENOTDIR":
      return new WorkspaceServiceError("WORKSPACE_NOT_DIRECTORY");
    case "EACCES":
    case "EPERM":
      return new WorkspaceServiceError("WORKSPACE_PERMISSION_DENIED");
    default:
      return new WorkspaceServiceError("WORKSPACE_IO_FAILED");
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorkspaceServiceError("WORKSPACE_REQUEST_ABORTED");
  }
}

function containsPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

async function defaultRootCandidates(
  fileSystem: WorkspaceFileSystem,
  homeDirectory: string,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const filesystemRoot = parsePath(homeDirectory).root;
  if (platform === "win32") {
    return Array.from({ length: 26 }, (_, index) =>
      String.fromCharCode(65 + index).concat(":\\"),
    );
  }
  if (platform !== "darwin") return [filesystemRoot];
  try {
    const volumes = await fileSystem.readdir("/Volumes", {
      withFileTypes: true,
    });
    return [
      filesystemRoot,
      ...volumes
        .filter((entry) => entry.isDirectory())
        .map((entry) => join("/Volumes", entry.name)),
    ];
  } catch {
    return [filesystemRoot];
  }
}

export class WorkspaceService {
  private readonly fileSystem: WorkspaceFileSystem;
  private readonly homeDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly rootCandidates: () => Promise<readonly string[]>;

  constructor(options: WorkspaceServiceOptions = {}) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.platform = options.platform ?? process.platform;
    this.rootCandidates =
      options.rootCandidates ??
      (() =>
        defaultRootCandidates(
          this.fileSystem,
          this.homeDirectory,
          this.platform,
        ));
  }

  async roots(signal?: AbortSignal): Promise<WorkspaceRoot[]> {
    assertNotAborted(signal);
    let candidates: readonly string[];
    try {
      candidates = [this.homeDirectory, ...(await this.rootCandidates())];
    } catch (error) {
      throw translateFileSystemError(error);
    }
    assertNotAborted(signal);

    const roots: WorkspaceRoot[] = [];
    const seen = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      assertNotAborted(signal);
      try {
        const canonical = await this.fileSystem.realpath(candidate);
        const details = await this.fileSystem.stat(canonical);
        if (!details.isDirectory()) {
          if (index === 0) {
            throw new WorkspaceServiceError("WORKSPACE_NOT_DIRECTORY");
          }
          continue;
        }
        await this.fileSystem.access(
          canonical,
          constants.R_OK | constants.X_OK,
        );
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        roots.push(
          WorkspaceRootSchema.parse({
            path: canonical,
            label: index === 0 ? "Home" : workspacePathLabel(canonical),
          }),
        );
        if (roots.length === 32) break;
      } catch (error) {
        if (index === 0) throw translateFileSystemError(error);
      }
    }
    assertNotAborted(signal);
    if (roots.length === 0) {
      throw new WorkspaceServiceError("WORKSPACE_NOT_FOUND");
    }
    return roots;
  }

  async validate(
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSelection> {
    assertNotAborted(signal);
    let requested: string;
    try {
      requested = TerminalCwdSchema.parse(path);
    } catch {
      throw new WorkspaceServiceError("WORKSPACE_INVALID_PATH");
    }
    if (!isAbsolute(requested)) {
      throw new WorkspaceServiceError("WORKSPACE_INVALID_PATH");
    }

    try {
      const canonical = await this.fileSystem.realpath(requested);
      assertNotAborted(signal);
      const details = await this.fileSystem.stat(canonical);
      if (!details.isDirectory()) {
        throw new WorkspaceServiceError("WORKSPACE_NOT_DIRECTORY");
      }
      await this.fileSystem.access(canonical, constants.R_OK | constants.X_OK);
      const roots = await this.roots(signal);
      if (!roots.some((root) => containsPath(root.path, canonical))) {
        throw new WorkspaceServiceError("WORKSPACE_OUTSIDE_ROOTS");
      }
      assertNotAborted(signal);
      return WorkspaceSelectionSchema.parse({
        path: canonical,
        label: workspacePathLabel(canonical),
      });
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  async list(
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectoryPage> {
    const workspace = await this.validate(path, signal);
    assertNotAborted(signal);
    let children: WorkspaceDirectoryEntryLike[];
    try {
      children = await this.fileSystem.readdir(workspace.path, {
        withFileTypes: true,
      });
    } catch (error) {
      throw translateFileSystemError(error);
    }
    assertNotAborted(signal);

    const roots = await this.roots(signal);
    const containingRoot = roots
      .filter((root) => containsPath(root.path, workspace.path))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!containingRoot) {
      throw new WorkspaceServiceError("WORKSPACE_OUTSIDE_ROOTS");
    }

    const breadcrumbs = [containingRoot];
    const relativePath = relative(containingRoot.path, workspace.path);
    let breadcrumbPath = containingRoot.path;
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      breadcrumbPath = join(breadcrumbPath, segment);
      breadcrumbs.push({ path: breadcrumbPath, label: segment });
    }

    const base = {
      path: workspace.path,
      label: workspace.label,
      breadcrumbs,
    };
    const entries: Array<{ path: string; name: string }> = [];
    const sortedDirectories = children
      .filter((entry) => entry.isDirectory())
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .slice(0, WORKSPACE_DIRECTORY_MAX_ENTRIES);

    for (const child of sortedDirectories) {
      const entry = {
        path: join(workspace.path, child.name),
        name: child.name,
      };
      const candidate = WorkspaceDirectoryPageSchema.safeParse({
        ...base,
        entries: [...entries, entry],
      });
      if (!candidate.success) break;
      entries.push(entry);
    }
    assertNotAborted(signal);
    return WorkspaceDirectoryPageSchema.parse({ ...base, entries });
  }
}

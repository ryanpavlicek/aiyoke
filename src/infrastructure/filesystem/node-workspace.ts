import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspacePort } from "../../application/index.js";
import { AiyokeError, compareCodePoints, safeRelativePath } from "../../core/index.js";

const EXCLUDED_ROOT_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export type AtomicWriteCheckpoint = "directories-verified" | "temporary-staged";

export interface NodeWorkspaceOptions {
  readonly onReadCheckpoint?: (
    checkpoint: "target-verified",
    context: { readonly path: string; readonly target: string }
  ) => Promise<void>;
  readonly onAtomicWriteCheckpoint?: (
    checkpoint: AtomicWriteCheckpoint,
    context: { readonly path: string; readonly parent: string; readonly temporary?: string }
  ) => Promise<void>;
}

export class NodeWorkspace implements WorkspacePort {
  readonly root: string;
  readonly files: readonly string[];

  private constructor(
    root: string,
    files: readonly string[],
    private readonly options: NodeWorkspaceOptions
  ) {
    this.root = root;
    this.files = files;
  }

  static async open(root: string, options: NodeWorkspaceOptions = {}): Promise<NodeWorkspace> {
    const absoluteRoot = resolve(root);
    await mkdir(absoluteRoot, { recursive: true });
    const rootMetadata = await lstat(absoluteRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new AiyokeError("INVALID_PATH", "Workspace root must be a real directory.");
    }
    const canonicalRoot = await realpath(absoluteRoot);
    const files = await NodeWorkspace.#listFiles(canonicalRoot);
    return new NodeWorkspace(canonicalRoot, files, options);
  }

  async read(path: string): Promise<string | undefined> {
    const target = await this.#safeTarget(path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.options.onReadCheckpoint?.("target-verified", { path, target });
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      handle = await open(target, constants.O_RDONLY | noFollow);
      const openedMetadata = await handle.stat();
      const initialMetadata = await lstat(target);
      await this.#verifiedDirectory(dirname(target), path);
      if (
        !openedMetadata.isFile() ||
        initialMetadata.isSymbolicLink() ||
        !initialMetadata.isFile() ||
        !sameFile(openedMetadata, initialMetadata)
      ) {
        throw new AiyokeError("INVALID_PATH", `Refusing to read non-regular file ${path}.`, {
          path
        });
      }
      const currentMetadata = await lstat(target);
      await this.#verifiedDirectory(dirname(target), path);
      if (
        currentMetadata.isSymbolicLink() ||
        !currentMetadata.isFile() ||
        !sameFile(openedMetadata, currentMetadata)
      ) {
        throw new AiyokeError("INVALID_PATH", `Refusing read substitution for ${path}.`, { path });
      }
      const content = await handle.readFile("utf8");
      const afterMetadata = await lstat(target);
      await this.#verifiedDirectory(dirname(target), path);
      if (
        afterMetadata.isSymbolicLink() ||
        !afterMetadata.isFile() ||
        !sameFile(openedMetadata, afterMetadata)
      ) {
        throw new AiyokeError("INVALID_PATH", `Refusing read substitution for ${path}.`, { path });
      }
      return content;
    } catch (error) {
      if (error instanceof AiyokeError) throw error;
      try {
        await this.#safeTarget(path);
      } catch (validationError) {
        if (validationError instanceof AiyokeError) throw validationError;
      }
      if (isMissing(error)) return undefined;
      if (error instanceof Error && "code" in error && error.code === "ELOOP") {
        throw new AiyokeError("INVALID_PATH", `Refusing read substitution for ${path}.`, { path });
      }
      throw new AiyokeError("WORKSPACE_IO", `Could not read ${path}.`, {
        path,
        cause: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async exists(path: string): Promise<boolean> {
    const target = await this.#safeTarget(path);
    try {
      const metadata = await lstat(target);
      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async writeAtomic(path: string, content: string, executable: boolean): Promise<void> {
    const target = await this.#safeTarget(path);
    const parent = dirname(target);
    await this.#ensureDirectories(parent);
    const verifiedParent = await this.#verifiedDirectory(parent, path);
    await this.options.onAtomicWriteCheckpoint?.("directories-verified", { path, parent });
    const temporary = join(parent, `.aiyoke-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      if (executable) await chmod(temporary, 0o755);
      const stagedPath = await realpath(temporary);
      if (!inside(this.root, stagedPath) || !samePath(dirname(stagedPath), verifiedParent)) {
        throw new AiyokeError(
          "INVALID_PATH",
          `Refusing atomic write after directory substitution for ${path}.`,
          { path }
        );
      }
      await this.options.onAtomicWriteCheckpoint?.("temporary-staged", {
        path,
        parent,
        temporary
      });
      const currentParent = await this.#verifiedDirectory(parent, path);
      if (!samePath(currentParent, verifiedParent)) {
        throw new AiyokeError(
          "INVALID_PATH",
          `Refusing atomic write after directory substitution for ${path}.`,
          { path }
        );
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof AiyokeError) throw error;
      throw new AiyokeError("WORKSPACE_IO", `Could not write ${path} atomically.`, {
        path,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #safeTarget(path: string): Promise<string> {
    const normalized = safeRelativePath(path);
    const target = resolve(this.root, ...normalized.split("/"));
    if (!inside(this.root, target) || samePath(target, this.root)) {
      throw new AiyokeError("INVALID_PATH", `Path ${path} escapes the workspace.`, { path });
    }

    let current = this.root;
    for (const segment of normalized.split("/").slice(0, -1)) {
      current = join(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          throw new AiyokeError("INVALID_PATH", `Path ${path} traverses a symbolic link.`, {
            path
          });
        }
        if (!metadata.isDirectory()) {
          throw new AiyokeError("INVALID_PATH", `Path ${path} traverses a non-directory.`, {
            path
          });
        }
      } catch (error) {
        if (isMissing(error)) break;
        throw error;
      }
    }
    return target;
  }

  async #verifiedDirectory(directory: string, path: string): Promise<string> {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new AiyokeError("INVALID_PATH", `Path ${path} traverses a non-directory.`, { path });
    }
    const canonical = await realpath(directory);
    if (!inside(this.root, canonical)) {
      throw new AiyokeError("INVALID_PATH", `Path ${path} escapes the workspace.`, { path });
    }
    return canonical;
  }

  async #ensureDirectories(parent: string): Promise<void> {
    const relativeParent = relative(this.root, parent);
    let current = this.root;
    for (const segment of relativeParent.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new AiyokeError(
            "INVALID_PATH",
            `Refusing to write through non-directory ${relative(this.root, current)}.`
          );
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        await mkdir(current);
      }
    }
  }

  static async #listFiles(root: string): Promise<readonly string[]> {
    const result: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => compareCodePoints(left.name, right.name))) {
        const absolute = join(directory, entry.name);
        const relativePath = relative(root, absolute).replaceAll(sep, "/");
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const isRootDirectory = !relativePath.includes("/");
          if (
            (isRootDirectory && EXCLUDED_ROOT_DIRECTORIES.has(entry.name)) ||
            relativePath === ".aiyoke/cache"
          ) {
            continue;
          }
          await visit(absolute);
        } else if (entry.isFile()) {
          result.push(relativePath);
        }
      }
    };
    await visit(root);
    return result;
  }
}

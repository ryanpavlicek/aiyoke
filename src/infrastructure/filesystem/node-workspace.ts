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
import type { WorkspacePort, WorkspaceWrite } from "../../application/index.js";
import { isShareableWorkspacePath } from "../../application/workspace-snapshot-policy.js";
import { AiyokeError, compareCodePoints, safeRelativePath } from "../../core/index.js";

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

interface StagedWrite {
  readonly write: WorkspaceWrite;
  readonly target: string;
  readonly parent: string;
  readonly verifiedParent: string;
  readonly temporary: string;
}

interface CommitRecord extends StagedWrite {
  readonly backup?: string;
  backedUp: boolean;
  installed: boolean;
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
    const staged = await this.#stageWrite({ path, content, executable, previous: undefined });
    try {
      const currentParent = await this.#verifiedDirectory(staged.parent, path);
      if (!samePath(currentParent, staged.verifiedParent)) {
        throw new AiyokeError(
          "INVALID_PATH",
          `Refusing atomic write after directory substitution for ${path}.`,
          { path }
        );
      }
      await rename(staged.temporary, staged.target);
    } catch (error) {
      await rm(staged.temporary, { force: true }).catch(() => undefined);
      if (error instanceof AiyokeError) throw error;
      throw new AiyokeError("WORKSPACE_IO", `Could not write ${path} atomically.`, {
        path,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async writeBatchAtomic(writes: readonly WorkspaceWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const staged: StagedWrite[] = [];
    const committed: CommitRecord[] = [];
    try {
      for (const write of writes) staged.push(await this.#stageWrite(write));
      for (const write of writes) {
        const current = await this.read(write.path);
        if (current !== write.previous) {
          throw new AiyokeError(
            "PLAN_CONFLICT",
            `${write.path} changed while the plan transaction was staged; create a new plan before applying.`,
            { path: write.path }
          );
        }
      }
      for (const item of staged) {
        const currentParent = await this.#verifiedDirectory(item.parent, item.write.path);
        if (!samePath(currentParent, item.verifiedParent)) {
          throw new AiyokeError(
            "INVALID_PATH",
            `Refusing plan transaction after directory substitution for ${item.write.path}.`,
            { path: item.write.path }
          );
        }
        const backup =
          item.write.previous === undefined
            ? undefined
            : join(item.parent, `.aiyoke-${randomUUID()}.rollback`);
        const record: CommitRecord = {
          ...item,
          ...(backup === undefined ? {} : { backup }),
          backedUp: false,
          installed: false
        };
        committed.push(record);
        if (backup !== undefined) {
          await rename(item.target, backup);
          record.backedUp = true;
        }
        await rename(item.temporary, item.target);
        record.installed = true;
      }
      await Promise.all(
        committed.flatMap((record) =>
          record.backup === undefined
            ? []
            : [rm(record.backup, { force: true }).catch(() => undefined)]
        )
      );
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const record of [...committed].reverse()) {
        try {
          const currentParent = await this.#verifiedDirectory(record.parent, record.write.path);
          if (!samePath(currentParent, record.verifiedParent)) {
            throw new Error("parent directory changed during rollback");
          }
          if (record.installed) await rm(record.target, { force: true });
          if (record.backedUp && record.backup !== undefined) {
            await rename(record.backup, record.target);
          }
        } catch (rollbackError) {
          rollbackFailures.push(
            `${record.write.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      await Promise.all(
        staged.map((item) => rm(item.temporary, { force: true }).catch(() => undefined))
      );
      if (rollbackFailures.length > 0) {
        throw new AiyokeError("WORKSPACE_IO", "Could not roll back a failed plan transaction.", {
          rollbackFailures
        });
      }
      if (error instanceof AiyokeError) throw error;
      throw new AiyokeError("WORKSPACE_IO", "Could not commit the plan transaction.", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #stageWrite(write: WorkspaceWrite): Promise<StagedWrite> {
    const target = await this.#safeTarget(write.path);
    const parent = dirname(target);
    await this.#ensureDirectories(parent);
    const verifiedParent = await this.#verifiedDirectory(parent, write.path);
    await this.options.onAtomicWriteCheckpoint?.("directories-verified", {
      path: write.path,
      parent
    });
    const temporary = join(parent, `.aiyoke-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, write.content, { encoding: "utf8", flag: "wx" });
      if (write.executable) await chmod(temporary, 0o755);
      const stagedPath = await realpath(temporary);
      if (!inside(this.root, stagedPath) || !samePath(dirname(stagedPath), verifiedParent)) {
        throw new AiyokeError(
          "INVALID_PATH",
          `Refusing atomic write after directory substitution for ${write.path}.`,
          { path: write.path }
        );
      }
      await this.options.onAtomicWriteCheckpoint?.("temporary-staged", {
        path: write.path,
        parent,
        temporary
      });
      return { write, target, parent, verifiedParent, temporary };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof AiyokeError) throw error;
      throw new AiyokeError("WORKSPACE_IO", `Could not stage ${write.path} atomically.`, {
        path: write.path,
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
          if (!isShareableWorkspacePath(relativePath)) {
            continue;
          }
          await visit(absolute);
        } else if (entry.isFile() && isShareableWorkspacePath(relativePath)) {
          result.push(relativePath);
        }
      }
    };
    await visit(root);
    return result;
  }
}

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { WorkspacePort } from "../../application/index.js";
import { AiyokeError, compareCodePoints, safeRelativePath } from "../../core/index.js";

const EXCLUDED_ROOT_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class NodeWorkspace implements WorkspacePort {
  readonly root: string;
  readonly files: readonly string[];

  private constructor(root: string, files: readonly string[]) {
    this.root = root;
    this.files = files;
  }

  static async open(root: string): Promise<NodeWorkspace> {
    const absoluteRoot = resolve(root);
    await mkdir(absoluteRoot, { recursive: true });
    const files = await NodeWorkspace.#listFiles(absoluteRoot);
    return new NodeWorkspace(absoluteRoot, files);
  }

  async read(path: string): Promise<string | undefined> {
    const target = await this.#safeTarget(path);
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new AiyokeError("INVALID_PATH", `Refusing to read non-regular file ${path}.`, {
          path
        });
      }
      return await readFile(target, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof AiyokeError) throw error;
      throw new AiyokeError("WORKSPACE_IO", `Could not read ${path}.`, {
        path,
        cause: error instanceof Error ? error.message : String(error)
      });
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
    const temporary = join(parent, `.aiyoke-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      if (executable) await chmod(temporary, 0o755);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new AiyokeError("WORKSPACE_IO", `Could not write ${path} atomically.`, {
        path,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #safeTarget(path: string): Promise<string> {
    const normalized = safeRelativePath(path);
    const target = resolve(this.root, ...normalized.split("/"));
    const rootPrefix = `${this.root}${sep}`.toLocaleLowerCase();
    if (!target.toLocaleLowerCase().startsWith(rootPrefix)) {
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

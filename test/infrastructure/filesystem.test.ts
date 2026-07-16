import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeWorkspace } from "../../src/infrastructure/filesystem/index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("NodeWorkspace", () => {
  it("discovers deterministically, excludes tool output, and performs atomic reads and writes", async () => {
    const root = await temporaryRoot("aiyoke-workspace-");
    await mkdir(join(root, "source", "cache"), { recursive: true });
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await mkdir(join(root, ".aiyoke", "cache"), { recursive: true });
    await writeFile(join(root, "source", "cache", "included.ts"), "export {};\n");
    await writeFile(join(root, "node_modules", "ignored", "file.js"), "ignored\n");
    await writeFile(join(root, ".aiyoke", "cache", "ignored.json"), "{}\n");

    const workspace = await NodeWorkspace.open(root);
    expect(workspace.files).toEqual(["source/cache/included.ts"]);
    expect(await workspace.read("missing.txt")).toBeUndefined();
    expect(await workspace.exists("missing.txt")).toBe(false);

    await workspace.writeAtomic("generated/nested.txt", "first\n", false);
    expect(await workspace.exists("generated/nested.txt")).toBe(true);
    expect(await workspace.read("generated/nested.txt")).toBe("first\n");
    await workspace.writeAtomic("generated/nested.txt", "second\n", true);
    expect(await workspace.read("generated/nested.txt")).toBe("second\n");
    expect(await workspace.exists("generated")).toBe(false);
    await expect(workspace.read("generated")).rejects.toThrow(/non-regular/);
  });

  it("rejects traversal and non-directory ancestors", async () => {
    const root = await temporaryRoot("aiyoke-containment-");
    await writeFile(join(root, "blocked"), "file\n");
    const workspace = await NodeWorkspace.open(root);
    await expect(workspace.writeAtomic("../outside", "unsafe", false)).rejects.toThrow(
      /Unsafe generated path/
    );
    await expect(workspace.writeAtomic("blocked/child", "unsafe", false)).rejects.toThrow(
      /non-directory/
    );
  });

  it("refuses writes through symbolic-link ancestors", async () => {
    const root = await temporaryRoot("aiyoke-symlink-");
    const outside = await temporaryRoot("aiyoke-outside-");
    try {
      await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") return;
      throw error;
    }
    const workspace = await NodeWorkspace.open(root);
    await expect(workspace.writeAtomic("link/escaped.txt", "unsafe", false)).rejects.toThrow(
      /symbolic link/
    );
  });

  it.each(["directories-verified", "temporary-staged"] as const)(
    "fails closed when an ancestor becomes a symlink after %s",
    async (raceCheckpoint) => {
      const root = await temporaryRoot("aiyoke-symlink-race-");
      const outside = await temporaryRoot("aiyoke-race-outside-");
      await mkdir(join(root, "generated"));
      let swapped = false;
      const workspace = await NodeWorkspace.open(root, {
        async onAtomicWriteCheckpoint(checkpoint, context) {
          if (swapped || checkpoint !== raceCheckpoint) return;
          swapped = true;
          await rename(context.parent, join(root, `original-${checkpoint}`));
          await symlink(outside, context.parent, process.platform === "win32" ? "junction" : "dir");
        }
      });
      await expect(workspace.writeAtomic("generated/escaped.txt", "unsafe", false)).rejects.toThrow(
        /directory substitution|non-directory/
      );
      expect(swapped).toBe(true);
      await expect(readFile(join(outside, "escaped.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );
});

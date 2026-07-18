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
    await mkdir(join(root, "packages", "app", "node_modules", "ignored"), { recursive: true });
    await mkdir(join(root, ".aiyoke", "cache"), { recursive: true });
    await writeFile(join(root, "source", "cache", "included.ts"), "export {};\n");
    await writeFile(join(root, "node_modules", "ignored", "file.js"), "ignored\n");
    await writeFile(
      join(root, "packages", "app", "node_modules", "ignored", "file.js"),
      "ignored\n"
    );
    await writeFile(join(root, ".aiyoke", "cache", "ignored.json"), "{}\n");
    await writeFile(join(root, ".env"), "SECRET=hidden\n");
    await writeFile(join(root, ".env.local"), "SECRET=hidden\n");
    await writeFile(join(root, ".env.example"), "SECRET=replace-me\n");

    const workspace = await NodeWorkspace.open(root);
    expect(workspace.files).toEqual([".env.example", "source/cache/included.ts"]);
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

  it("stages and commits a multi-file plan transaction as one batch", async () => {
    const root = await temporaryRoot("aiyoke-batch-");
    await writeFile(join(root, "existing.txt"), "before\n");
    const workspace = await NodeWorkspace.open(root);

    await workspace.writeBatchAtomic([
      { path: "created.txt", content: "created\n", executable: false, previous: undefined },
      {
        path: "existing.txt",
        content: "after\n",
        executable: false,
        previous: "before\n"
      }
    ]);

    expect(await workspace.read("created.txt")).toBe("created\n");
    expect(await workspace.read("existing.txt")).toBe("after\n");
  });

  it("does not commit any plan output when batch staging fails", async () => {
    const root = await temporaryRoot("aiyoke-batch-stage-failure-");
    const workspace = await NodeWorkspace.open(root, {
      async onAtomicWriteCheckpoint(checkpoint, context) {
        if (checkpoint === "temporary-staged" && context.path === "second.txt") {
          throw new Error("injected staging failure");
        }
      }
    });

    await expect(
      workspace.writeBatchAtomic([
        { path: "first.txt", content: "first\n", executable: false, previous: undefined },
        { path: "second.txt", content: "second\n", executable: false, previous: undefined }
      ])
    ).rejects.toThrow(/stage second/);
    await expect(readFile(join(root, "first.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(root, "second.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects a stale batch before replacing any file", async () => {
    const root = await temporaryRoot("aiyoke-batch-stale-");
    await writeFile(join(root, "first.txt"), "current\n");
    const workspace = await NodeWorkspace.open(root);

    await expect(
      workspace.writeBatchAtomic([
        { path: "created.txt", content: "created\n", executable: false, previous: undefined },
        { path: "first.txt", content: "next\n", executable: false, previous: "stale\n" }
      ])
    ).rejects.toMatchObject({ code: "PLAN_CONFLICT" });
    expect(await workspace.read("first.txt")).toBe("current\n");
    expect(await workspace.read("created.txt")).toBeUndefined();
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

  it("fails closed when a verified read ancestor is substituted", async () => {
    const root = await temporaryRoot("aiyoke-read-race-");
    const outside = await temporaryRoot("aiyoke-read-outside-");
    await mkdir(join(root, "source"));
    await writeFile(join(root, "source", "value.txt"), "inside\n");
    await writeFile(join(outside, "value.txt"), "outside secret\n");
    let swapped = false;
    const workspace = await NodeWorkspace.open(root, {
      async onReadCheckpoint(_checkpoint, context) {
        swapped = true;
        const parent = join(root, "source");
        await rename(parent, join(root, "original-source"));
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
        expect(context.target).toBe(join(parent, "value.txt"));
      }
    });

    await expect(workspace.read("source/value.txt")).rejects.toMatchObject({
      code: "INVALID_PATH"
    });
    expect(swapped).toBe(true);
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

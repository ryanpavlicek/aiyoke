#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2];
const versionPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (tag === undefined || !versionPattern.test(tag)) {
  throw new Error("Release tag must be an exact v-prefixed semantic version.");
}
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = tag.slice(1);
if (packageJson.version !== version) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}.`);
}
if (
  packageJson.name !== "aiyoke" ||
  packageJson.repository?.url !== "git+https://github.com/ryanpavlicek/aiyoke.git"
) {
  throw new Error("Release package identity or provenance repository is invalid.");
}
const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m");
if (!heading.test(changelog)) {
  throw new Error(`CHANGELOG.md has no release heading for ${version}.`);
}
console.log(`Release version ${version} matches its tag, package, repository, and changelog.`);

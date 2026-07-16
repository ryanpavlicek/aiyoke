#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"];

async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(absolute);
  }
  return result;
}

files.push(
  ...(await markdownFiles(path.join(root, "docs"))).map((file) => path.relative(root, file)),
  ...(await markdownFiles(path.join(root, "examples"))).map((file) => path.relative(root, file))
);

const failures = [];
for (const relativeFile of files.sort()) {
  const absoluteFile = path.resolve(root, relativeFile);
  const source = await readFile(absoluteFile, "utf8");
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1]?.trim();
    if (
      rawTarget === undefined ||
      rawTarget.startsWith("#") ||
      /^(?:https?:|mailto:)/.test(rawTarget)
    ) {
      continue;
    }
    const withoutTitle = rawTarget.replace(/\s+"[^"]*"$/, "");
    const fileTarget = decodeURIComponent(withoutTitle.split("#", 1)[0] ?? "");
    if (fileTarget.length === 0) continue;
    const resolved = path.resolve(path.dirname(absoluteFile), fileTarget);
    const relative = path.relative(root, resolved);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      failures.push(`${relativeFile}: link escapes repository: ${rawTarget}`);
      continue;
    }
    try {
      await access(resolved);
    } catch {
      failures.push(`${relativeFile}: missing local link target: ${rawTarget}`);
    }
  }
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
for (const heading of [
  "## Install",
  "## Five-minute setup",
  "## Supported surface",
  "## Extensions",
  "## Architecture",
  "## Troubleshooting",
  "## Development",
  "## License"
]) {
  if (!readme.includes(heading)) failures.push(`README.md: missing required section ${heading}`);
}

if (failures.length > 0)
  throw new Error(`Documentation validation failed:\n${failures.join("\n")}`);
console.log(`Documentation validation passed for ${files.length} Markdown files.`);

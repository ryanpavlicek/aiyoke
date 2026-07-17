#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkExternal = process.argv.includes("--external");
const files = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md"];
const failures = [];
const externalTargets = new Set();

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

function githubSlug(value) {
  return value
    .replace(/`([^`]*)`/g, "$1")
    .replaceAll("&amp;", "&")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function markdownStructure(source, relativeFile) {
  const lines = source.split(/\r?\n/);
  const visible = [];
  const anchors = new Set();
  const slugCounts = new Map();
  let fence;
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (marker !== undefined) {
      const kind = marker[0];
      if (fence === undefined) fence = { kind, line: index + 1 };
      else if (fence.kind === kind) fence = undefined;
      visible.push("");
      continue;
    }
    if (fence !== undefined) {
      visible.push("");
      continue;
    }
    visible.push(line);
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1];
    if (heading === undefined) continue;
    if (/[<>]/u.test(heading)) {
      failures.push(`${relativeFile}:${index + 1}: raw HTML is not supported in headings`);
      continue;
    }
    const base = githubSlug(heading);
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  if (fence !== undefined) {
    failures.push(`${relativeFile}:${fence.line}: unclosed ${fence.kind} code fence`);
  }
  return { visibleSource: visible.join("\n"), anchors };
}

function linkTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  const match = trimmed.match(/^(\S+?)(?:\s+["'(].*)?$/u);
  return match?.[1] ?? trimmed;
}

function collectLinks(source, relativeFile) {
  const linkSource = source.replace(/`[^`\n]*`/gu, "");
  const definitions = new Map();
  for (const match of linkSource.matchAll(/^\s*\[([^\]]+)\]:[ \t]*(\S+)(?:[ \t]+.*)?$/gmu)) {
    const label = match[1]?.trim().toLowerCase();
    const target = match[2];
    if (label !== undefined && target !== undefined) definitions.set(label, target);
  }

  const targets = [];
  for (const match of linkSource.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (target !== undefined) targets.push(linkTarget(target));
  }
  for (const match of linkSource.matchAll(/!?\[([^\]]*)\]\[([^\]]*)\]/gu)) {
    const text = match[1]?.trim().toLowerCase() ?? "";
    const explicit = match[2]?.trim().toLowerCase() ?? "";
    const label = explicit.length > 0 ? explicit : text;
    const target = definitions.get(label);
    if (target === undefined) failures.push(`${relativeFile}: missing link definition [${label}]`);
    else targets.push(linkTarget(target));
  }
  for (const match of linkSource.matchAll(/<(https?:\/\/[^>]+)>/gu)) {
    const target = match[1];
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

function validateExternalTarget(target, relativeFile) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    failures.push(`${relativeFile}: invalid external URL: ${target}`);
    return;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    failures.push(`${relativeFile}: unsafe external URL: ${target}`);
    return;
  }
  externalTargets.add(parsed.href);
}

const documents = new Map();
for (const relativeFile of files.sort()) {
  const absoluteFile = path.resolve(root, relativeFile);
  const source = await readFile(absoluteFile, "utf8");
  documents.set(absoluteFile, { source, ...markdownStructure(source, relativeFile) });
}

for (const relativeFile of files.sort()) {
  const absoluteFile = path.resolve(root, relativeFile);
  const document = documents.get(absoluteFile);
  if (document === undefined) continue;
  for (const rawTarget of collectLinks(document.visibleSource, relativeFile)) {
    if (rawTarget.startsWith("#")) {
      const anchor = decodeURIComponent(rawTarget.slice(1));
      if (!document.anchors.has(anchor)) {
        failures.push(`${relativeFile}: missing local anchor: ${rawTarget}`);
      }
      continue;
    }
    if (/^https?:/u.test(rawTarget)) {
      validateExternalTarget(rawTarget, relativeFile);
      continue;
    }
    if (rawTarget.startsWith("mailto:")) continue;

    const [encodedFile = "", encodedAnchor] = rawTarget.split("#", 2);
    const fileTarget = decodeURIComponent(encodedFile);
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
      continue;
    }
    if (encodedAnchor === undefined || path.extname(resolved).toLowerCase() !== ".md") continue;
    const targetDocument = documents.get(resolved);
    const anchor = decodeURIComponent(encodedAnchor);
    if (targetDocument === undefined || !targetDocument.anchors.has(anchor)) {
      failures.push(`${relativeFile}: missing anchor in ${relative}: #${anchor}`);
    }
  }
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
for (const heading of [
  "## Install",
  "## Five-minute setup",
  "## Supported surface",
  "## Documentation map",
  "## Extensions",
  "## Architecture",
  "## Troubleshooting",
  "## Development",
  "## License"
]) {
  if (!readme.includes(heading)) failures.push(`README.md: missing required section ${heading}`);
}

async function externalStatus(target) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const response = await fetch(target, {
        method,
        redirect: "follow",
        headers: {
          "user-agent": "aiyoke-documentation-validator/1",
          ...(method === "GET" ? { range: "bytes=0-0" } : {})
        },
        signal: AbortSignal.timeout(10_000)
      });
      if (response.ok || [401, 403, 429].includes(response.status)) return undefined;
      if (method === "HEAD" && [405, 501].includes(response.status)) continue;
      return `HTTP ${response.status}`;
    } catch (error) {
      if (method === "HEAD") continue;
      return error instanceof Error ? error.message : String(error);
    }
  }
  return "no response";
}

if (checkExternal) {
  const targets = [...externalTargets].sort();
  const concurrency = 6;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const index = cursor;
        cursor += 1;
        const target = targets[index];
        if (target === undefined) continue;
        const failure = await externalStatus(target);
        if (failure !== undefined) failures.push(`external link failed (${failure}): ${target}`);
      }
    })
  );
}

if (failures.length > 0) {
  throw new Error(`Documentation validation failed:\n${failures.sort().join("\n")}`);
}
console.log(
  `Documentation validation passed for ${files.length} Markdown files${
    checkExternal ? ` and ${externalTargets.size} external URLs` : ""
  }.`
);

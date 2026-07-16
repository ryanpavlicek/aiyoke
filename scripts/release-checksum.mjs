#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [operation, input] = process.argv.slice(2);
if (!new Set(["create", "verify"]).has(operation) || input === undefined) {
  throw new Error("Usage: release-checksum.mjs <create|verify> <archive-or-checksum>.");
}

if (operation === "create") {
  const archive = path.resolve(input);
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const checksum = `${archive}.sha256`;
  await writeFile(checksum, `${digest}  ${path.basename(archive)}\n`, "utf8");
  console.log(checksum);
} else {
  const checksum = path.resolve(input);
  const source = (await readFile(checksum, "utf8")).trim();
  const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(source);
  if (match === null) throw new Error("Checksum file is invalid.");
  const archive = path.join(path.dirname(checksum), match[2]);
  const actual = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  if (actual !== match[1]) throw new Error(`Checksum verification failed for ${match[2]}.`);
  console.log(`Checksum verified for ${match[2]}.`);
}

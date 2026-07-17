import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly packageManager: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
};
const githubRefVersion = ["$", "{GITHUB_REF_NAME#v}"].join("");
const shellVersion = ["$", "{version}"].join("");

describe("release workflow", () => {
  it("pins every third-party workflow action to an immutable commit", () => {
    for (const source of [ciWorkflow, workflow]) {
      const actions = [...source.matchAll(/^\s*uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
      }
    }
  });

  it("keeps workflow YAML structurally valid with unique keys", () => {
    for (const source of [ciWorkflow, workflow]) {
      const document = parseDocument(source, { uniqueKeys: true });
      expect(document.errors).toEqual([]);
    }
  });

  it("pins native fixture toolchains exactly", () => {
    const combined = `${ciWorkflow}\n${workflow}`;
    expect(combined.match(/python-version: "3\.14\.6"/g)).toHaveLength(3);
    expect(combined.match(/go-version: "1\.26\.5"/g)).toHaveLength(3);
    expect(combined.match(/toolchain: "1\.97\.1"/g)).toHaveLength(3);
    expect(combined.match(/components: rustfmt/g)).toHaveLength(3);
  });

  it("pins direct npm and package-manager versions exactly", () => {
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    for (const version of [
      ...Object.values(packageJson.dependencies),
      ...Object.values(packageJson.devDependencies)
    ]) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    }
  });

  it("publishes the attested tarball through an unambiguous local path", () => {
    expect(workflow).toContain(
      `npm publish "./release/aiyoke-${githubRefVersion}.tgz" --access public`
    );
    expect(workflow).not.toContain('npm publish "release/');
  });

  it("keeps publishing behind the npm environment and OIDC permission", () => {
    expect(workflow).toContain("    environment: npm");
    expect(workflow).toContain("      id-token: write");
  });

  it("allows the published version to propagate before creating the release", () => {
    expect(workflow).toContain("for attempt in {1..12}; do");
    expect(workflow).toContain(`npm view "aiyoke@${shellVersion}" version 2>/dev/null || true`);
    expect(workflow).toContain("sleep 10");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const githubRefVersion = ["$", "{GITHUB_REF_NAME#v}"].join("");
const shellVersion = ["$", "{version}"].join("");

describe("release workflow", () => {
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

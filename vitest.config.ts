import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        branches: 76,
        functions: 90,
        lines: 88,
        statements: 86
      }
    },
    include: ["test/**/*.test.ts"]
  }
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["server/**/*.ts", "shared/**/*.ts"],
      exclude: ["server/index.ts", "server/**/*.test.ts"],
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80
      }
    }
  }
});

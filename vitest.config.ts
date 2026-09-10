import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify("test") },
  test: {
    // The browser walk-through under e2e/ is Playwright's, not Vitest's.
    exclude: [...configDefaults.exclude, "e2e/**"],
    // A test's placements are not sightings: nothing a suite places may land on the
    // site-code candidate list in the working tree. The recording tests point it at a
    // scratch file themselves.
    env: { SITE_CODE_CANDIDATES_FILE: "off" },
    coverage: {
      provider: "v8",
      // lcov is what SonarQube reads; without it the quality gate sees no coverage at all.
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["server/**/*.ts", "shared/**/*.ts"],
      exclude: ["server/index.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
      thresholds: {
        branches: 75,
        statements: 80,
        functions: 80,
        lines: 80
      }
    }
  }
});

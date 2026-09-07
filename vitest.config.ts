import { configDefaults, defineConfig } from "vitest/config";

// The browser walk-through under e2e/ is Playwright's, not Vitest's.
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify("test") },
  test: { exclude: [...configDefaults.exclude, "e2e/**"] }
});

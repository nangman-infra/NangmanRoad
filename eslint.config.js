import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "dist/", "dist-server/", "coverage/", "public/data/", "server/data/",
    "state/", ".cache/", "**/node_modules/", "test-results/", "playwright-report/"
  ]),
  {
    files: ["**/*.{ts,mts,tsx,js,mjs}"],
    extends: [js.configs.recommended, sonarjs.configs.recommended],
    // Counts are the existing violations when lint was introduced.
    rules: {
      "no-control-regex": "warn", // 1
      "require-yield": "warn", // 3
      "sonarjs/array-callback-without-return": "warn", // 1
      "sonarjs/cognitive-complexity": "warn", // 14
      "sonarjs/different-types-comparison": "warn", // 2
      "sonarjs/generator-without-yield": "warn", // 3
      "sonarjs/no-clear-text-protocols": "warn", // 1
      "sonarjs/no-dead-store": "warn", // 1
      "sonarjs/no-floating-point-equality": "warn", // 3
      "sonarjs/no-hardcoded-ip": "warn", // 129
      "sonarjs/no-identical-functions": "warn", // 2
      "sonarjs/no-nested-assignment": "warn", // 1
      "sonarjs/no-nested-conditional": "warn", // 15
      "sonarjs/no-nested-template-literals": "warn", // 11
      "sonarjs/no-os-command-from-path": "warn", // 5
      "sonarjs/no-undefined-argument": "warn", // 1
      "sonarjs/no-unused-vars": "warn", // 1
      "sonarjs/prefer-read-only-props": "warn", // 2
      "sonarjs/use-type-alias": "warn" // 1
    }
  },
  {
    files: ["**/*.{ts,mts,tsx}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn", // 5
      "prefer-const": "warn" // 1
    }
  },
  {
    // Give SonarJS type information for the files covered by tsconfig.json.
    files: ["{src,server,shared}/**/*.{ts,mts,tsx}", "vite.config.ts", "tailwind.config.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } }
  },
  {
    files: ["src/**/*.{ts,mts,tsx,js,mjs}", "*.tsx"],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      "react-hooks/exhaustive-deps": "warn", // 3
      "react-hooks/set-state-in-effect": "warn", // 5
      "react-hooks/incompatible-library": "error",
      "react-hooks/unsupported-syntax": "error"
    }
  },
  {
    files: ["**/*.tsx"],
    extends: [jsxA11y.flatConfigs.strict],
    rules: {
      "jsx-a11y/prefer-tag-over-role": "warn" // 10
    }
  },
  {
    files: ["src/**/*.{ts,mts,tsx,js,mjs}"],
    ignores: ["src/**/*.test.*", "src/lib/routeWorker.ts"],
    languageOptions: { globals: globals.browser }
  },
  {
    files: ["src/lib/routeWorker.ts"],
    languageOptions: { globals: globals.worker }
  },
  {
    files: ["{server,scripts,e2e,bench}/**/*", "**/*.test.*", "*.{ts,mts,tsx,js,mjs}"],
    languageOptions: { globals: globals.nodeBuiltin }
  }
]);

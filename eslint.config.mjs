import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-test/**", // test builds (SUNDAY_DIST_DIR)
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Third-party skill scripts, not SUNDAY's code.
    ".claude/**",
    ".aider-desk/**",
  ]),
  // Electron's main process is CommonJS: require() is how those files load modules.
  { files: ["**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
]);

export default eslintConfig;

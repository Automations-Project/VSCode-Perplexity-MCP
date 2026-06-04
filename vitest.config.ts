import { defineConfig } from "vitest/config";

// CI sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 to avoid pulling Chromium on
// every job. Integration tests that fork manual-login-runner / health-check
// (and therefore launch a real Patchright browser) cannot run in that mode
// and must be excluded from the test set entirely; otherwise they fail with
// "browser executable doesn't exist" assertion errors after consuming
// minutes per matrix cell. Skipping in CI is the standard pattern; locally
// the env-var is unset so integration tests run normally.
const skipBrowserBackedTests =
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1";

export default defineConfig({
  test: {
    include: [
      "packages/extension/tests/**/*.test.ts",
      "packages/webview/tests/**/*.test.{ts,tsx}",
      "packages/mcp-server/test/**/*.test.{js,ts}",
      "packages/shared/tests/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      ...(skipBrowserBackedTests
        ? ["packages/mcp-server/test/integration/**"]
        : []),
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: [
        "packages/extension/src/**/*.ts",
        "packages/mcp-server/src/**/*.{js,ts}",
      ],
      exclude: [
        "packages/**/*.d.ts",
        "packages/**/dist/**",
        "packages/**/node_modules/**",
        "packages/mcp-server/dev-tools/**",
      ],
      all: true,
      // Per-file thresholds — security-critical modules must clear ≥95%.
      // Build fails if any listed module drops below its floor.
      thresholds: {
        "packages/mcp-server/src/redact.js": {
          lines: 95,
          functions: 95,
          branches: 90,
          statements: 95,
        },
        "packages/mcp-server/src/vault.js": {
          lines: 95,
          functions: 95,
          branches: 90,
          statements: 95,
        },
        "packages/mcp-server/src/profiles.js": {
          lines: 85,
          functions: 85,
          branches: 80,
          statements: 85,
        },
      },
    },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/extension/tests/**/*.test.ts",
      "packages/webview/tests/**/*.test.{ts,tsx}",
      "packages/mcp-server/test/**/*.test.{js,ts}",
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
        "packages/mcp-server/src/cli.js": {
          lines: 85,
          functions: 85,
          branches: 80,
          statements: 85,
        },
      },
    },
  },
});

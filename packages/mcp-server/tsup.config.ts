import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    config: "src/config.ts",
    refresh: "src/refresh.ts",
    "research-store": "src/research-store.ts",
    cli: "src/cli.js",
    profiles: "src/profiles.js",
    vault: "src/vault.js",
    redact: "src/redact.js",
    "health-check": "src/health-check.js",
    "manual-login-runner": "src/manual-login-runner.js",
    "login-runner": "src/login-runner.js",
    logout: "src/logout.js",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,
  // got-scraping and its transitive data-bearing deps must resolve at runtime
  // from node_modules (they load JSON data files via fs.readFileSync that tsup
  // can't inline). Same story for patchright (native Chromium).
  external: [
    "patchright",
    "patchright-core",
    "got-scraping",
    "got",
    "tough-cookie",
    "header-generator",
    "fingerprint-generator",
    "keytar",
  ],
  // Shebang is NOT emitted into source files — it tripped vitest/esbuild
  // during test imports of cli.js. npm's `bin` linker wraps the entry with
  // its own node invocation on install, so the shebang isn't required for
  // `npx perplexity-user-mcp` to work. If direct execution (`./dist/cli.mjs`)
  // ever needs to work without npm, re-add via a post-build script that
  // targets cli.mjs specifically.
  outExtension: () => ({ js: ".mjs" }),
});

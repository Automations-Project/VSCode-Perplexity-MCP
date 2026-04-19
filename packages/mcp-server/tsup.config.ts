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
  outExtension: () => ({ js: ".mjs" }),
});

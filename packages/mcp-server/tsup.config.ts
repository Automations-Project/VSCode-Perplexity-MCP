import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    config: "src/config.ts",
    refresh: "src/refresh.ts",
    "history-store": "src/history-store.js",
    "cloud-sync": "src/cloud-sync.js",
    attachments: "src/attachments.js",
    export: "src/export.js",
    viewers: "src/viewers.js",
    "viewer-detect": "src/viewer-detect.js",
    cli: "src/cli.js",
    profiles: "src/profiles.js",
    vault: "src/vault.js",
    redact: "src/redact.js",
    "health-check": "src/health-check.js",
    "manual-login-runner": "src/manual-login-runner.js",
    "login-runner": "src/login-runner.js",
    "impit-login-runner": "src/impit-login-runner.js",
    logout: "src/logout.js",
    "reinit-watcher": "src/reinit-watcher.js",
    "tty-prompt": "src/tty-prompt.js",
    doctor: "src/doctor.js",
    "doctor-report": "src/doctor-report.js",
    "daemon/index": "src/daemon/index.ts",
    "daemon/attach": "src/daemon/attach.ts",
    "daemon/audit": "src/daemon/audit.ts",
    "daemon/client-http": "src/daemon/client-http.ts",
    "daemon/install-tunnel": "src/daemon/install-tunnel.ts",
    "daemon/launcher": "src/daemon/launcher.ts",
    "daemon/lockfile": "src/daemon/lockfile.ts",
    "daemon/server": "src/daemon/server.ts",
    "daemon/token": "src/daemon/token.ts",
    "daemon/tunnel": "src/daemon/tunnel.ts",
    "daemon/tunnel-providers/index": "src/daemon/tunnel-providers/index.ts",
    "checks/runtime": "src/checks/runtime.js",
    "checks/config": "src/checks/config.js",
    "checks/profiles": "src/checks/profiles.js",
    "checks/vault": "src/checks/vault.js",
    "checks/browser": "src/checks/browser.js",
    "checks/native-deps": "src/checks/native-deps.js",
    "checks/network": "src/checks/network.js",
    "checks/ide": "src/checks/ide.js",
    "checks/mcp": "src/checks/mcp.js",
    "checks/probe": "src/checks/probe.js",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // tsup's rollup-dts worker thread OOMs on this package's 47 entry points
  // under Node 22 / Windows (pre-existing; fails even on commits before 0.8.43).
  // Declarations are generated separately with tsc --allowJs --emitDeclarationOnly
  // in the package.json build script, which is faster and avoids the worker heap.
  dts: false,
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
    // gray-matter is CommonJS (uses top-level `require("fs")`). Inlining into
    // an ESM bundle crashes at server startup because tsup's __require shim
    // throws "Dynamic require of fs is not supported". Load it from
    // node_modules instead so Node's native CJS interop handles it.
    "gray-matter",
    // express and its CJS transitive deps (body-parser, depd, ...) use
    // top-level `require("path")` / `require("fs")`. Same __require shim
    // failure as gray-matter above — must resolve from node_modules at runtime.
    "express",
    // @ngrok/ngrok is a NAPI native-addon binding; can't be bundled into ESM.
    "@ngrok/ngrok",
    // helmet is CJS with setter-based exports that tsup's __require shim
    // handles poorly under ESM; external is the standard pattern.
    "helmet",
  ],
  // Shebang is NOT emitted into source files — it tripped vitest/esbuild
  // during test imports of cli.js.  A post-build script (see package.json
  // `build` and scripts/post-build-shebang.mjs) prepends the shebang to
  // `dist/cli.mjs` and chmods it to 755 so that direct execution works
  // on POSIX where npm creates symlinks rather than wrapper scripts.
  outExtension: () => ({ js: ".mjs" }),
});

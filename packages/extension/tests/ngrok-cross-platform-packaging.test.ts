import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression tests for the 0.8.5 Linux activation crash:
//
//   Cannot find module '@ngrok/ngrok-linux-x64-gnu'
//
// Root causes:
//   1. `@ngrok/ngrok/index.js` eagerly requires a platform-specific subpackage
//      at require-time and throws if it is missing.
//   2. Extension 0.8.5 bundles a top-level `require("@ngrok/ngrok")` chain that
//      fires when the extension module is loaded by VS Code.
//   3. The VSIX was packaged on Windows and only shipped
//      `@ngrok/ngrok-win32-x64-msvc` — every non-Windows user hit (1) via (2).
//
// These tests land alongside two fixes:
//   - Agent A: make `@ngrok/ngrok` lazy-loaded so activation no longer triggers
//     the native-binding require eagerly. Test 1 below proves this: after the
//     fix, loading `dist/extension.js` with every `@ngrok/ngrok-*` subpackage
//     stubbed as MODULE_NOT_FOUND must succeed.
//   - Agent B: ship the SUPPORTED matrix of @ngrok/ngrok-* native variants in
//     the VSIX (not all 13 — see scripts/prepare-package-deps.mjs for why)
//     so a VSIX packed on one smoke-test platform still works on the others.
//     Test 2 below verifies `dist/node_modules/@ngrok/` contains exactly the
//     SUPPORTED_NGROK_VARIANTS matrix entries with matching os/cpu.

// tests/ → extension package root. `__dirname` is used by sibling tests in
// this directory (see auth-manager.*.test.ts) — vitest compiles to CJS.
const extensionRoot = join(__dirname, "..");
const distExtension = join(extensionRoot, "dist", "extension.js");
const distNodeModulesNgrok = join(extensionRoot, "dist", "node_modules", "@ngrok");
const ngrokRootManifest = join(distNodeModulesNgrok, "ngrok", "package.json");
const prepareDepsScript = join(
  extensionRoot,
  "scripts",
  "prepare-package-deps.mjs",
);

/**
 * Source-of-truth matrix — must match SUPPORTED_NGROK_VARIANTS in
 * scripts/prepare-package-deps.mjs exactly. If the packaging script's matrix
 * changes, update this duplicate too (and vice versa). A test below enforces
 * that every entry here is materialized under dist/node_modules/@ngrok/ with
 * matching os/cpu fields.
 */
const SUPPORTED_NGROK_VARIANTS: ReadonlyArray<{
  name: string;
  os: string;
  cpu: string;
}> = [
  { name: "@ngrok/ngrok-linux-x64-gnu", os: "linux", cpu: "x64" },
  { name: "@ngrok/ngrok-darwin-x64", os: "darwin", cpu: "x64" },
  { name: "@ngrok/ngrok-darwin-arm64", os: "darwin", cpu: "arm64" },
  { name: "@ngrok/ngrok-win32-x64-msvc", os: "win32", cpu: "x64" },
];

function hasBuiltBundle(): boolean {
  return existsSync(distExtension);
}

function hasPreparedDeps(): boolean {
  return existsSync(ngrokRootManifest);
}

describe("extension bundle survives a missing @ngrok/ngrok-* native binding", () => {
  it.skipIf(!hasBuiltBundle())(
    "loads dist/extension.js without triggering MODULE_NOT_FOUND for any @ngrok/ngrok-* subpackage",
    () => {
      // Child-process harness that:
      //   - hooks Module._resolveFilename to simulate every Linux/macOS/ARM
      //     user (no native subpackage present),
      //   - stubs `vscode` so the CJS bundle can require it,
      //   - requires the bundle and reports success via exit code.
      //
      // Against 0.8.5 this fails: the bundle's __esm chain eagerly evaluates
      // `require("@ngrok/ngrok")`, which throws at require-time because
      // @ngrok/ngrok itself throws when no platform subpackage resolves.
      // After Agent A's lazy-load fix, loading the bundle must not crash.
      const harness = `
        const Module = require('module');
        const origResolve = Module._resolveFilename;
        Module._resolveFilename = function (request, parent, ...rest) {
          if (/^@ngrok\\/ngrok-/.test(request)) {
            const err = new Error("Cannot find module '" + request + "'");
            err.code = 'MODULE_NOT_FOUND';
            throw err;
          }
          return origResolve.call(this, request, parent, ...rest);
        };
        const origLoad = Module._load;
        Module._load = function (request, parent, ...rest) {
          if (request === 'vscode') return {};
          return origLoad.call(this, request, parent, ...rest);
        };
        try {
          require(${JSON.stringify(distExtension)});
          process.exit(0);
        } catch (err) {
          process.stderr.write(String(err && err.stack || err));
          process.exit(1);
        }
      `;

      const result = spawnSync(process.execPath, ["-e", harness], {
        cwd: extensionRoot,
        encoding: "utf8",
        timeout: 30_000,
      });

      const stderr = result.stderr ?? "";
      // Assert on stderr first so the failure message is actionable.
      expect(stderr).not.toMatch(/Cannot find module '@ngrok\/ngrok/);
      expect(stderr).not.toMatch(/MODULE_NOT_FOUND/);
      expect(result.status).toBe(0);
    },
    45_000,
  );

  it.skipIf(hasBuiltBundle())(
    "skipped: run `npm run build -w perplexity-vscode` first to enable the activation-health test",
    () => {
      // Informational placeholder when the dist bundle isn't built. CI must
      // build before running this suite or this regression test silently
      // drops out of the matrix.
      expect(true).toBe(true);
    },
  );
});

describe("packaged VSIX ships each supported @ngrok/ngrok-* platform variant", () => {
  it.skipIf(!hasPreparedDeps())(
    "dist/node_modules/@ngrok/ contains each supported platform variant with matching os/cpu",
    () => {
      // Sanity: we explicitly chose 4 variants for the smoke-test matrix;
      // if a future agent drops this test back to enumerating
      // optionalDependencies, catch it here.
      expect(SUPPORTED_NGROK_VARIANTS.length).toBe(4);

      const missing: string[] = [];
      const mismatches: string[] = [];
      for (const { name, os: expectedOs, cpu: expectedCpu } of SUPPORTED_NGROK_VARIANTS) {
        const manifestPath = join(extensionRoot, "dist", "node_modules", name, "package.json");
        if (!existsSync(manifestPath)) {
          missing.push(name);
          continue;
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: string;
          os?: string[];
          cpu?: string[];
        };
        const osOk = Array.isArray(manifest.os) ? manifest.os.includes(expectedOs) : false;
        const cpuOk = Array.isArray(manifest.cpu) ? manifest.cpu.includes(expectedCpu) : false;
        if (!osOk || !cpuOk) {
          mismatches.push(
            `${name}: manifest os=${JSON.stringify(manifest.os)} cpu=${JSON.stringify(manifest.cpu)} ` +
              `vs expected os=${expectedOs} cpu=${expectedCpu}`,
          );
        }
      }

      expect(
        missing,
        `Missing supported @ngrok/ngrok platform variants in dist/node_modules — ` +
          `these smoke-matrix platforms would crash at activation:\n  ${missing.join("\n  ")}`,
      ).toEqual([]);
      expect(
        mismatches,
        `Platform variant manifests have os/cpu that do not match the SUPPORTED_NGROK_VARIANTS ` +
          `matrix — napi-rs loader cannot find them:\n  ${mismatches.join("\n  ")}`,
      ).toEqual([]);
    },
  );

  it.skipIf(hasPreparedDeps())(
    "skipped: run `node packages/extension/scripts/prepare-package-deps.mjs` first to enable the packaging smoke",
    () => {
      expect(true).toBe(true);
    },
  );
});

describe("prepare-package-deps.mjs script is textual (no literal NUL bytes)", () => {
  // Regression guard for the 0.8.5 maintenance window: the script briefly
  // contained a literal 0x00 byte inside `typeflag === "\0"`, which makes
  // ripgrep treat the whole file as binary and hides it from default search.
  // The fix is to use the JS string escape `"\0"` instead. Reading the file
  // as bytes and asserting no NUL keeps that fix locked in.
  it("contains no 0x00 byte", () => {
    expect(existsSync(prepareDepsScript)).toBe(true);
    const bytes = readFileSync(prepareDepsScript);
    const nulIndex = bytes.indexOf(0);
    expect(
      nulIndex,
      `Found literal NUL (0x00) at byte offset ${nulIndex} of ` +
        `${prepareDepsScript}. Replace it with the JS escape "\\0".`,
    ).toBe(-1);
  });
});

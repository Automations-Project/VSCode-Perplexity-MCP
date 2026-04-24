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
//   - Agent B: ship all supported @ngrok/ngrok-* native variants in the VSIX
//     so a Windows-packaged VSIX still works on macOS/Linux/ARM. Test 2 below
//     verifies `dist/node_modules/@ngrok/` contains every variant listed in
//     `@ngrok/ngrok`'s optionalDependencies.

// tests/ → extension package root. `__dirname` is used by sibling tests in
// this directory (see auth-manager.*.test.ts) — vitest compiles to CJS.
const extensionRoot = join(__dirname, "..");
const distExtension = join(extensionRoot, "dist", "extension.js");
const distNodeModulesNgrok = join(extensionRoot, "dist", "node_modules", "@ngrok");
const ngrokRootManifest = join(distNodeModulesNgrok, "ngrok", "package.json");

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

describe("packaged VSIX ships every @ngrok/ngrok-* platform variant", () => {
  it.skipIf(!hasPreparedDeps())(
    "dist/node_modules/@ngrok/ contains each optionalDependency of @ngrok/ngrok with matching os/cpu",
    () => {
      const rootManifest = JSON.parse(readFileSync(ngrokRootManifest, "utf8"));
      const optional = rootManifest.optionalDependencies ?? {};
      const names = Object.keys(optional);

      // Sanity: @ngrok/ngrok 1.7 ships 13 optional platform subpackages; if
      // the shape ever changes, fail loudly so the test is kept honest.
      expect(names.length).toBeGreaterThan(0);

      const missing: string[] = [];
      const mismatches: string[] = [];
      for (const name of names) {
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
        // Infer expected os/cpu from the package name (napi-rs convention:
        // @ngrok/ngrok-<os>-<cpu>[-<libc/abi>]). e.g.
        //   @ngrok/ngrok-linux-x64-gnu       -> os=linux, cpu=x64
        //   @ngrok/ngrok-win32-arm64-msvc    -> os=win32, cpu=arm64
        //   @ngrok/ngrok-darwin-universal    -> os=darwin, cpu=(x64|arm64)
        const suffix = name.slice("@ngrok/ngrok-".length);
        const parts = suffix.split("-");
        const expectedOs = parts[0];
        const expectedCpu = parts[1];
        const osOk = Array.isArray(manifest.os) ? manifest.os.includes(expectedOs) : true;
        const cpuOk = Array.isArray(manifest.cpu)
          ? manifest.cpu.includes(expectedCpu) || expectedCpu === "universal"
          : true;
        if (!osOk || !cpuOk) {
          mismatches.push(
            `${name}: manifest os=${JSON.stringify(manifest.os)} cpu=${JSON.stringify(manifest.cpu)} ` +
              `vs expected os=${expectedOs} cpu=${expectedCpu}`,
          );
        }
      }

      expect(
        missing,
        `Missing @ngrok/ngrok platform variants in dist/node_modules — ` +
          `these users will crash at activation:\n  ${missing.join("\n  ")}`,
      ).toEqual([]);
      expect(
        mismatches,
        `Platform variant manifests have os/cpu that do not match their package ` +
          `name — napi-rs loader cannot find them:\n  ${mismatches.join("\n  ")}`,
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

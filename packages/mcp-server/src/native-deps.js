// Speed Boost (impit) install / uninstall helpers shared by the CLI and
// the VS Code extension. Mirrors the behavior of
// packages/extension/src/native-deps.ts but lives in the npm package so
// `npx perplexity-user-mcp install-speed-boost` doesn't require the
// extension to be installed.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getImpitRuntimeDir } from "./refresh.js";

const STATE_MARKER = "native-deps-state.json";

function stateFile() {
  return join(getImpitRuntimeDir(), STATE_MARKER);
}

function writeState(state) {
  const dir = getImpitRuntimeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

function readState() {
  const f = stateFile();
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Ensure a minimal package.json exists in the runtime dir so `npm install`
 * lands there cleanly (prevents npm walking up to the user's home and
 * polluting a parent package.json). Mirrors the extension's helper.
 */
function ensureRuntimePackageJson() {
  const dir = getImpitRuntimeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify(
        {
          name: "perplexity-native-deps",
          version: "1.0.0",
          private: true,
          description: "Runtime native dependencies for the Perplexity MCP CLI/extension.",
        },
        null,
        2,
      ),
    );
  }
  return dir;
}

/**
 * @returns {{ installed: boolean; version: string | null; installedAt: string | null; runtimeDir: string }}
 */
export function getImpitStatus() {
  const dir = getImpitRuntimeDir();
  const marker = join(dir, "node_modules", "impit", "package.json");
  if (!existsSync(marker)) {
    return { installed: false, version: null, installedAt: null, runtimeDir: dir };
  }
  let version = null;
  try {
    version = JSON.parse(readFileSync(marker, "utf8")).version ?? null;
  } catch {
    // marker exists but unreadable — still count as installed
  }
  const state = readState();
  return {
    installed: true,
    version,
    installedAt: state?.installedAt ?? null,
    runtimeDir: dir,
  };
}

/**
 * Install impit into ~/.perplexity-mcp/native-deps/ via `npm install`.
 * Does NOT depend on the user's project — uses --prefix into our own
 * runtime dir and ensures a package.json exists there.
 *
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<{ ok: boolean; version?: string; error?: string }>}
 */
export async function installImpit(opts = {}) {
  const log = opts.log ?? (() => undefined);
  const dir = ensureRuntimePackageJson();
  log(`Installing impit into ${dir} via npm...`);

  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "impit@latest", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: dir,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";

    child.stdout?.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(`npm: ${line}`);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(`npm: ${line}`);
    });

    child.on("error", (err) => {
      log(`npm spawn error: ${err.message}`);
      resolve({
        ok: false,
        error:
          err.message.includes("ENOENT")
            ? "`npm` not found on PATH. Install Node.js (which ships with npm) and try again."
            : err.message,
      });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          error: `npm exited with code ${code}. stderr: ${stderrBuf.slice(0, 400) || "(empty)"}`,
        });
        return;
      }
      const status = getImpitStatus();
      if (!status.installed) {
        resolve({
          ok: false,
          error: "npm reported success but impit package.json not found in node_modules. Check npm output above.",
        });
        return;
      }
      writeState({
        version: status.version ?? "unknown",
        installedAt: new Date().toISOString(),
      });
      log(`impit ${status.version ?? ""} installed successfully.`);
      resolve({ ok: true, version: status.version ?? undefined });
    });
  });
}

/**
 * Remove the entire native-deps runtime directory.
 *
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {{ ok: boolean; error?: string }}
 */
export function uninstallImpit(opts = {}) {
  const log = opts.log ?? (() => undefined);
  const dir = getImpitRuntimeDir();
  if (!existsSync(dir)) return { ok: true };
  try {
    rmSync(dir, { recursive: true, force: true });
    log(`Removed ${dir}.`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

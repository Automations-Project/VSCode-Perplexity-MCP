/**
 * On-demand installer for optional native dependencies.
 *
 * Currently manages `impit` — a Rust-backed TLS impersonation library that
 * speeds up the dashboard's refresh path when it's installed. Not bundled in
 * the VSIX (would bloat the install to ~80 MB across all platforms); instead
 * the user clicks "Install Speed Boost" in the dashboard and we fetch it into
 * `~/.perplexity-mcp/native-deps/` at runtime. npm's own platform-gated
 * optionalDependencies then pull only the binary that matches the user's arch.
 *
 * Requires `npm` on PATH. If npm isn't available the install fails with a
 * guidance message that the user can follow manually.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getImpitRuntimeDir } from "perplexity-user-mcp";

export interface NativeDepStatus {
  installed: boolean;
  version: string | null;
  installedAt: string | null;
  runtimeDir: string;
}

const STATE_MARKER = "native-deps-state.json";

function stateFile(): string {
  return join(getImpitRuntimeDir(), STATE_MARKER);
}

function writeState(state: { version: string; installedAt: string }): void {
  const dir = getImpitRuntimeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

function readState(): { version: string; installedAt: string } | null {
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
 * polluting a parent package.json).
 */
function ensureRuntimePackageJson(): string {
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
          description: "Runtime native dependencies for the Perplexity MCP extension.",
        },
        null,
        2
      )
    );
  }
  return dir;
}

export function getImpitStatus(): NativeDepStatus {
  const dir = getImpitRuntimeDir();
  const marker = join(dir, "node_modules", "impit", "package.json");
  if (!existsSync(marker)) {
    return { installed: false, version: null, installedAt: null, runtimeDir: dir };
  }

  let version: string | null = null;
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

export async function installImpit(opts: { log?: (line: string) => void } = {}): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> {
  const log = opts.log ?? (() => undefined);
  const dir = ensureRuntimePackageJson();

  log(`Installing impit into ${dir} via npm...`);

  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "impit@latest", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: dir,
      shell: process.platform === "win32", // npm on Windows is npm.cmd
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuf += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(`npm: ${line}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
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
            ? "`npm` not found on PATH. Install Node.js (which ships with npm) and try again, or manually run: npm install --prefix ~/.perplexity-mcp/native-deps impit"
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

export function uninstallImpit(opts: { log?: (line: string) => void } = {}): { ok: boolean; error?: string } {
  const log = opts.log ?? (() => undefined);
  const dir = getImpitRuntimeDir();
  if (!existsSync(dir)) {
    return { ok: true };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    log(`Removed ${dir}.`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

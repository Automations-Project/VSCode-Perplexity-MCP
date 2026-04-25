import { spawn } from "node:child_process";

const CATEGORY = "browser";

/**
 * Read the Chrome-family browser's version string without launching the
 * browser GUI.
 *
 * Why this is non-trivial: on Windows, `chrome.exe --version` invoked from a
 * non-console parent (the VS Code extension host) forks the browser process —
 * the original exits with code 0 and empty stdout (which is why the doctor
 * report's `chrome-family` message was blank), and the forked children stay
 * alive as visible Chrome windows. Every `runDoctor()` call (Run, Deep check,
 * Capture diagnostics, Export) was therefore spawning a permanent visible
 * window.
 *
 * Fix: on Windows, query the PE header's ProductVersion via PowerShell's
 * `Get-Item ... .VersionInfo.ProductVersion` — no browser launch, returns
 * the same string the user sees in File Properties → Details. On macOS /
 * Linux, `--version` is a true CLI app contract and remains safe.
 */
function probeVersion(path) {
  if (process.platform === "win32") {
    return new Promise((resolve, reject) => {
      // Single-quote escape: PowerShell single-quoted strings need '' to
      // represent a literal '. -LiteralPath bypasses wildcard expansion so
      // bracketed install paths (e.g. Program Files (x86)) are safe.
      const escaped = path.replace(/'/g, "''");
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
        ],
        { timeout: 3000, windowsHide: true },
      );
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => { out += d.toString(); });
      child.stderr?.on("data", (d) => { err += d.toString(); });
      child.on("close", (code) => {
        const trimmed = out.trim();
        if (code === 0 && trimmed) resolve(trimmed);
        else reject(new Error(err.trim() || `version probe exited ${code}`));
      });
      child.on("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(path, ["--version"], { timeout: 2000 });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim() || err.trim());
      else reject(new Error(err.trim() || `version probe exited ${code}`));
    });
    child.on("error", reject);
  });
}

export async function run(opts = {}) {
  const results = [];
  const findChrome = opts.findChromeOverride ?? (await import("../config.js")).findChromeExecutable;
  const versionProbe = opts.versionProbeOverride ?? probeVersion;

  let chromePath = null;
  try { chromePath = findChrome(); } catch { chromePath = null; }

  if (!chromePath) {
    results.push({
      category: CATEGORY,
      name: "chrome-family",
      status: "fail",
      message: "No Chrome / Edge / Chromium binary found on PATH or in standard locations.",
      hint: "Run `npx perplexity-user-mcp install-browser` (Phase 4) or install Chrome/Edge manually.",
    });
    return results;
  }

  try {
    const v = await versionProbe(chromePath);
    results.push({ category: CATEGORY, name: "chrome-family", status: "pass", message: v });
  } catch (err) {
    results.push({ category: CATEGORY, name: "chrome-family", status: "pass", message: chromePath });
    results.push({
      category: CATEGORY,
      name: "chrome-version",
      status: "warn",
      message: `version probe failed: ${err.message}`,
    });
  }

  return results;
}

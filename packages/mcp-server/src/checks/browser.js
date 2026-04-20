import { spawn } from "node:child_process";

const CATEGORY = "browser";

function probeVersion(path) {
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

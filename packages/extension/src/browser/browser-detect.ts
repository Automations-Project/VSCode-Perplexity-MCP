import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Result of probing the system for a Chromium-family browser usable by
 * Patchright. The auth stack launches Patchright with an explicit `channel`
 * plus an optional `executablePath`.
 *
 * Legacy note: `channel: 'chromium'` also covers Brave (which is Chromium
 * under the hood) via an explicit `executablePath` — Patchright supports
 * this pattern natively.
 */
export type BrowserChannel = "chrome" | "msedge" | "chromium";

export type BrowserKind = "system" | "downloaded";

export interface BrowserProbe {
  /** True if a usable browser runtime was found. */
  found: boolean;
  /** Channel passed to Patchright. */
  channel?: BrowserChannel;
  /** Absolute path to the browser executable (system or bundled). */
  executablePath?: string;
  /** Human-readable name shown in the dashboard browser picker. */
  label?: string;
  /** Category of runtime — determines whether to launch vs connect. */
  kind?: BrowserKind;
  /** True when the browser is a Chromium we downloaded into globalStorage. */
  downloaded?: boolean;
}

function existsSafe(p: string | undefined): boolean {
  if (!p) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function probeChrome(): string | undefined {
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
    candidates.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/local/bin/google-chrome",
      "/snap/bin/google-chrome",
      "/opt/google/chrome/chrome",
    );
  }

  return candidates.find(existsSafe);
}

function probeEdge(): string | undefined {
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    candidates.push(
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  } else if (platform === "darwin") {
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    candidates.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/opt/microsoft/msedge/msedge",
    );
  }

  return candidates.find(existsSafe);
}

function probeChromium(): string | undefined {
  if (process.platform === "win32") return undefined;
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  return candidates.find(existsSafe);
}

function probeBrave(): string | undefined {
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
    candidates.push(
      path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      path.join(os.homedir(), "Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
    );
  } else {
    candidates.push(
      "/usr/bin/brave-browser",
      "/usr/bin/brave",
      "/snap/bin/brave",
      "/opt/brave.com/brave/brave-browser",
    );
  }

  return candidates.find(existsSafe);
}

/**
 * Detect every available browser runtime in preferred order:
 *   1. Google Chrome        — highest-fidelity Cloudflare fingerprint
 *   2. Microsoft Edge       — preinstalled on Windows 10/11, identical DOM
 *   3. System Chromium      — Linux fallback
 *   4. Brave Browser        — Chromium-based, works unchanged
 *   5. Downloaded Chromium  — patchright-installed bundle in globalStorage
 *
 * The caller decides which option to use via `BrowserChoice` in settings;
 * this function returns every viable option so the dashboard can render a
 * picker.
 *
 * Result is NOT cached — a user may install Chrome between calls.
 */
export function detectAllBrowsers(opts: {
  downloadedChromiumPath?: string;
} = {}): BrowserProbe[] {
  const results: BrowserProbe[] = [];

  const chrome = probeChrome();
  if (chrome) {
    results.push({ found: true, channel: "chrome", executablePath: chrome, label: "Google Chrome", kind: "system" });
  }

  const edge = probeEdge();
  if (edge) {
    results.push({ found: true, channel: "msedge", executablePath: edge, label: "Microsoft Edge", kind: "system" });
  }

  const chromium = probeChromium();
  if (chromium) {
    results.push({ found: true, channel: "chromium", executablePath: chromium, label: "Chromium", kind: "system" });
  }

  const brave = probeBrave();
  if (brave) {
    // Brave uses the 'chromium' channel + explicit executablePath — Patchright
    // treats it as generic Chromium because it doesn't ship a 'brave' channel.
    results.push({ found: true, channel: "chromium", executablePath: brave, label: "Brave Browser", kind: "system" });
  }

  if (opts.downloadedChromiumPath && existsSafe(opts.downloadedChromiumPath)) {
    results.push({
      found: true,
      channel: "chromium",
      executablePath: opts.downloadedChromiumPath,
      label: "Bundled Chromium",
      kind: "downloaded",
      downloaded: true,
    });
  }

  return results;
}

/**
 * Detect the first usable browser in preferred order. See `detectAllBrowsers`
 * for the ordering. Returns a sentinel `{ found: false }` when no option
 * is available.
 */
export function detectBrowser(opts: {
  downloadedChromiumPath?: string;
} = {}): BrowserProbe {
  const all = detectAllBrowsers(opts);
  return all[0] ?? { found: false };
}

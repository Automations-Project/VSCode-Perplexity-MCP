import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * On-demand bundled Chromium download.
 *
 * When the system has no Chrome / Edge / Chromium / Brave installed, the
 * extension can download Patchright's bundled Chromium (~170 MB) into
 * VS Code's per-extension globalStorage directory. This is a true
 * zero-system-browser fallback: the binary is fully isolated to the
 * extension, survives VS Code updates, and can be removed via the dashboard.
 *
 * We drive the vendored `patchright-core/cli.js install chromium` command and
 * point `PLAYWRIGHT_BROWSERS_PATH` at our storage directory. Progress is
 * parsed from the CLI's stderr (Playwright's install command writes its
 * progress bar there).
 */

export type DownloadStatus = "idle" | "downloading" | "done" | "error";

export interface DownloadState {
  status: DownloadStatus;
  progress?: number; // 0-100
  error?: string;
}

/**
 * Recursively walk a directory looking for the Chromium executable produced
 * by `patchright install chromium`. Layout differs per platform:
 *
 *   Windows: <storage>/chromium-<rev>/chrome-win/chrome.exe
 *   macOS:   <storage>/chromium-<rev>/chrome-mac/Chromium.app/Contents/MacOS/Chromium
 *   Linux:   <storage>/chromium-<rev>/chrome-linux/chrome
 *
 * We don't care about the exact revision — we just find the newest
 * `chromium-*` directory and resolve the platform-specific executable inside.
 */
function findDownloadedChromium(storageDir: string): string | undefined {
  if (!fs.existsSync(storageDir)) return undefined;

  let entries: string[];
  try {
    entries = fs.readdirSync(storageDir);
  } catch {
    return undefined;
  }

  const chromiumDirs = entries
    .filter(e => /^chromium-\d+$/.test(e))
    .map(e => {
      const full = path.join(storageDir, e);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
      return { name: e, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const dir of chromiumDirs) {
    const candidate = resolvePlatformExecutable(dir.full);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolvePlatformExecutable(chromiumDir: string): string | undefined {
  // Patchright/Playwright moved the per-arch suffix into the directory name in
  // late-2025 builds: `chrome-win` → `chrome-win64`, `chrome-linux` →
  // `chrome-linux64`, etc. Hardcoding the unsuffixed names broke the
  // post-install probe (install exited 0 but isDownloaded() always returned
  // false). Try the suffixed and unsuffixed variants in order, preferring
  // whichever actually has the executable on disk.
  const tryAll = (subdirs: string[], rel: string[]): string | undefined => {
    for (const sub of subdirs) {
      const candidate = path.join(chromiumDir, sub, ...rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  };

  if (process.platform === "win32") {
    return tryAll(["chrome-win64", "chrome-win"], ["chrome.exe"]);
  }
  if (process.platform === "darwin") {
    const macSubdirs = process.arch === "arm64"
      ? ["chrome-mac-arm64", "chrome-mac"]
      : ["chrome-mac", "chrome-mac-x64"];
    return (
      tryAll(macSubdirs, ["Chromium.app", "Contents", "MacOS", "Chromium"]) ??
      // Chrome for Testing variant (newer Playwright builds)
      tryAll(macSubdirs, ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"])
    );
  }
  // Linux: x64 → "chrome-linux" or "chrome-linux64"; arm64 → "chrome-linux-arm64".
  const linuxSubdirs = process.arch === "arm64"
    ? ["chrome-linux-arm64", "chrome-linux"]
    : ["chrome-linux64", "chrome-linux"];
  return tryAll(linuxSubdirs, ["chrome"]);
}

export class BrowserDownloadManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<DownloadState>();
  public readonly onDidChange = this._onDidChange.event;

  private _state: DownloadState = { status: "idle" };
  private _inFlight = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionPath: string,
  ) {}

  get state(): DownloadState { return this._state; }

  /** Absolute path to PLAYWRIGHT_BROWSERS_PATH for this extension. */
  getStorageDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "browsers");
  }

  /** Returns the path to a downloaded Chromium executable, or undefined. */
  getExecutablePath(): string | undefined {
    return findDownloadedChromium(this.getStorageDir());
  }

  isDownloaded(): boolean {
    return this.getExecutablePath() !== undefined;
  }

  /**
   * Remove any downloaded browsers. Safe to call while the extension is
   * running — we just delete the storage directory; on next download we'll
   * repopulate it.
   */
  async remove(): Promise<boolean> {
    try {
      const dir = this.getStorageDir();
      await fs.promises.rm(dir, { recursive: true, force: true });
      this._setState({ status: "idle", progress: undefined, error: undefined });
      return true;
    } catch (err) {
      this._setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * Run `patchright-core install chromium` with PLAYWRIGHT_BROWSERS_PATH
   * pointing at our global storage dir. Parses progress from the CLI output
   * and emits state changes via `onDidChange`.
   */
  async download(): Promise<DownloadState> {
    if (this._inFlight) return this._state;
    this._inFlight = true;

    const cliPath = path.join(this.extensionPath, "dist", "node_modules", "patchright-core", "cli.js");
    const nodeModulesPath = path.join(this.extensionPath, "dist", "node_modules");
    const storageDir = this.getStorageDir();

    if (!fs.existsSync(cliPath)) {
      this._inFlight = false;
      const err = `patchright-core CLI not found at ${cliPath}`;
      this._setState({ status: "error", error: err });
      return this._state;
    }

    try {
      await fs.promises.mkdir(storageDir, { recursive: true });
    } catch (err) {
      this._inFlight = false;
      this._setState({ status: "error", error: `Failed to create storage dir: ${err instanceof Error ? err.message : String(err)}` });
      return this._state;
    }

    this._setState({ status: "downloading", progress: 0, error: undefined });

    return new Promise<DownloadState>(resolve => {
      const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
        cwd: path.dirname(cliPath),
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: storageDir,
          NODE_PATH: nodeModulesPath,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const stderrChunks: string[] = [];

      const handleLine = (line: string) => {
        const m = line.match(/(\d{1,3})%/);
        if (m) {
          const n = Number(m[1]);
          if (n >= 0 && n <= 100 && n !== this._state.progress) {
            this._setState({ status: "downloading", progress: n });
          }
        }
      };

      let stderrBuf = "";
      child.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        stderrChunks.push(text);
        stderrBuf += text;
        const parts = stderrBuf.split(/[\r\n]/);
        stderrBuf = parts.pop() || "";
        for (const line of parts) handleLine(line);
        if (stderrBuf) handleLine(stderrBuf);
      });

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        stderrChunks.push(text);
        for (const line of text.split(/[\r\n]/)) handleLine(line);
      });

      const timeoutMs = 10 * 60 * 1000; // 10 min hard cap
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        // Escalate to SIGKILL after 5s. Windows ignores SIGTERM for most
        // processes and the install can hang on a stuck zip download.
        sigkillTimer = setTimeout(() => {
          try {
            if (!child.killed) child.kill("SIGKILL");
          } catch { /* already gone */ }
        }, 5_000);
      }, timeoutMs);

      child.on("error", err => {
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        this._inFlight = false;
        this._setState({ status: "error", error: err.message });
        resolve(this._state);
      });

      child.on("close", code => {
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        this._inFlight = false;

        if (code === 0 && this.isDownloaded()) {
          this._setState({ status: "done", progress: 100, error: undefined });
          resolve(this._state);
          return;
        }

        const tail = stderrChunks.join("").split("\n").filter(l => l.trim()).slice(-3).join(" | ");
        this._setState({
          status: "error",
          error: `patchright install exited with code ${code}${tail ? `: ${tail.substring(0, 300)}` : ""}`,
        });
        resolve(this._state);
      });
    });
  }

  private _setState(partial: Partial<DownloadState>): void {
    this._state = { ...this._state, ...partial };
    this._onDidChange.fire(this._state);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

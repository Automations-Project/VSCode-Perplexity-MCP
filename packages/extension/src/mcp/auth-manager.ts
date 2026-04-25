import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import * as vscode from "vscode";
import { softLogout, hardLogout } from "perplexity-user-mcp/logout";
import type {
  BrowserInfo as SharedBrowserInfo,
  BrowserChoice,
  BrowserDownloadState,
} from "@perplexity-user-mcp/shared";
import {
  detectAllBrowsers,
  type BrowserProbe,
} from "../browser/browser-detect.js";
import type { BrowserDownloadManager } from "../browser/browser-download.js";

export type AuthStatus =
  | "unknown" | "checking" | "valid" | "expired" | "error"
  | "logging-in" | "awaiting_otp" | "chrome_missing" | "sso_required";

export interface AuthState {
  profile: string;
  status: AuthStatus;
  tier?: "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous";
  lastLogin?: string;
  lastChecked?: string;
  error?: string;
  /** Full error detail (e.g. "Vault locked: ..."). Included when the runner
   * crashed with a recoverable message. Not redacted beyond what the runner
   * already did. */
  errorDetail?: string;
  /** Currently-selected browser runtime (from auto-detect or user pick). */
  browser?: SharedBrowserInfo;
  /** Every detected browser runtime, in preferred order. */
  availableBrowsers?: SharedBrowserInfo[];
  /** Live bundled-Chromium download state. */
  browserDownload?: BrowserDownloadState;
  /** Persisted user pick. */
  browserChoice?: BrowserChoice;
}

export interface AuthLoginResult {
  ok: boolean;
  reason?: string;
  tier?: string;
  /** Human-readable error string from the runner or exception, when ok=false. */
  error?: string;
  /** Extra detail/stack from the runner, when available. Truncated to ~400 chars for UI. */
  detail?: string;
}

export interface LoginOptions {
  profile: string;
  mode: "auto" | "manual";
  email?: string;
  runnerPath?: string;
  onOtpPrompt?: () => Promise<string | null>;
  onProgress?: (phase: string, detail?: unknown) => void;
  plainCookies?: boolean;
  /**
   * Optional provider that returns a passphrase to inject as
   * `PERPLEXITY_VAULT_PASSPHRASE` in the runner's environment. Called once per
   * login attempt, before the runner is spawned. Returning
   * `{ source: "cancelled" }` aborts the login with reason
   * `"passphrase_cancelled"` and the runner is never spawned. Returning
   * `{ passphrase: undefined, source: "keytar" }` is treated as "no env var
   * needed — keychain handles it."
   */
  passphraseProvider?: () => Promise<{
    passphrase: string | undefined;
    source: "keytar" | "stored" | "prompted" | "cancelled";
  }>;
}

export interface LogoutOptions { profile: string; purge?: boolean }
export interface CheckSessionOptions { profile: string }

export interface AuthManagerOptions {
  extensionUri: vscode.Uri;
}

/** Upper bound on how many chars of `error`/`detail` we keep when pushing to
 * the dashboard notice UI. Keeps the toast readable; the full string is still
 * available in the output channel. */
const ERROR_UI_MAX = 400;

function truncate(s: string | undefined, max = ERROR_UI_MAX): string | undefined {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Map an internal BrowserProbe (used in the extension runtime) to the
 * wire-format BrowserInfo shared with the webview. The shapes are nearly
 * identical but we drop the runtime `kind` field which the UI doesn't need
 * and strip any fields that are undefined to keep the postMessage payload
 * minimal.
 */
function toShared(probe: BrowserProbe): SharedBrowserInfo {
  const out: SharedBrowserInfo = { found: probe.found };
  if (probe.channel) out.channel = probe.channel;
  if (probe.executablePath) out.executablePath = probe.executablePath;
  if (probe.label) out.label = probe.label;
  if (probe.downloaded) out.downloaded = probe.downloaded;
  return out;
}

/**
 * Spawn a bundled runner script (login-runner / manual-login-runner /
 * health-check / doctor) as a child process and resolve with the last
 * line of stdout parsed as JSON. Runners in Phase 2 onward emit one JSON
 * line per invocation; this harness is the shared plumbing.
 */
export async function spawnRunner(
  scriptPath: string,
  env: Record<string, string> = {},
  opts: {
    timeoutMs?: number;
    onMessage?: (msg: unknown) => void;
    onSend?: (child: ChildProcess) => void;
  } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(scriptPath, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => {
      if (process.env.PERPLEXITY_DEBUG === "1") process.stderr.write(`[runner] ${d}`);
    });

    if (opts.onMessage) child.on("message", opts.onMessage);
    opts.onSend?.(child);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Runner timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.on("close", () => {
      if (timer) clearTimeout(timer);
      const lines = stdout.trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last) return reject(new Error("Runner produced no output"));
      try {
        resolve(JSON.parse(last) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`Bad runner output: ${(err as Error).message}`));
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

export class AuthManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<AuthState>();
  public readonly onDidChange = this._onDidChange.event;
  private _state: AuthState = { profile: "default", status: "unknown" };
  private inflight = new Map<string, Promise<unknown>>();
  private readonly extensionUri: vscode.Uri;
  /** Optional logger; extension.ts injects one so runner errors land in the
   *  Perplexity output channel alongside activation/daemon logs. */
  private logger?: (line: string) => void;

  /**
   * Cached result of the most recent browser probe. Auto-detected unless the
   * user pinned a specific channel via `setBrowserChoice`. Consumed by
   * `_browserEnv()` to tell runners + the MCP server which browser to use.
   */
  private _browser: BrowserProbe = { found: false };
  private _availableBrowsers: BrowserProbe[] = [];
  private _downloadManager?: BrowserDownloadManager;
  private _downloadListener?: vscode.Disposable;

  constructor(opts: AuthManagerOptions) {
    this.extensionUri = opts.extensionUri;
  }

  get state(): AuthState { return this._state; }

  get browser(): BrowserProbe { return this._browser; }

  /**
   * Attach a BrowserDownloadManager so AuthManager can:
   *   - include any downloaded Chromium in browser probes
   *   - forward download state into AuthState for the dashboard
   */
  attachDownloadManager(mgr: BrowserDownloadManager): void {
    this._downloadManager = mgr;
    this._downloadListener?.dispose();
    this._downloadListener = mgr.onDidChange((state) => {
      this.setState({ browserDownload: state });
      // When a download finishes, re-probe so the UI flips from
      // "chrome_missing" to the newly-bundled Chromium.
      if (state.status === "done") {
        this.refreshBrowserDetection();
        if (this._state.status === "chrome_missing") {
          this.setState({ status: "unknown", error: undefined });
        }
      }
    });
    this.setState({ browserDownload: mgr.state });
  }

  /** Download bundled Chromium on demand. */
  async downloadBundledChromium(): Promise<BrowserDownloadState> {
    if (!this._downloadManager) {
      const err: BrowserDownloadState = { status: "error", error: "Download manager not attached" };
      this.setState({ browserDownload: err });
      return err;
    }
    return this._downloadManager.download();
  }

  /** Remove the downloaded bundled Chromium. */
  async removeBundledChromium(): Promise<boolean> {
    if (!this._downloadManager) return false;
    const ok = await this._downloadManager.remove();
    this.refreshBrowserDetection();
    return ok;
  }

  /**
   * Re-run browser detection and update cached state. Called at init, before
   * login, before health checks, and after bundled-Chromium download
   * transitions.
   */
  refreshBrowserDetection(): BrowserProbe {
    const downloadedChromiumPath = this._downloadManager?.getExecutablePath();

    const all = detectAllBrowsers({ downloadedChromiumPath });

    const choice = this._state.browserChoice;
    let selected: BrowserProbe;

    if (choice?.mode === "custom" && choice.executablePath) {
      selected = {
        found: true,
        channel: (choice.channel as BrowserProbe["channel"]) ?? "chromium",
        executablePath: choice.executablePath,
        label: choice.label ?? "Custom browser",
        kind: "system",
      };
    } else if (choice?.mode === "auto" && choice.executablePath) {
      // User pinned a specific entry from the detected list
      const match = all.find((b) => b.executablePath === choice.executablePath);
      selected = match ?? all[0] ?? { found: false };
    } else {
      selected = all[0] ?? { found: false };
    }

    this._browser = selected;
    this._availableBrowsers = all;
    this.setState({
      browser: toShared(selected),
      availableBrowsers: all.map(toShared),
    });
    this.syncProcessEnv();
    return selected;
  }

  /**
   * Persist the user's browser choice and re-run detection so downstream
   * runners see the new selection. The choice is stored in AuthState only;
   * persistence to VS Code's workspace settings is the extension.ts layer's
   * job (see DashboardProvider message handlers).
   */
  setBrowserChoice(choice: BrowserChoice | undefined): void {
    this.setState({ browserChoice: choice });
    this.refreshBrowserDetection();
  }

  /**
   * Sync the currently-selected browser onto `process.env` so any child
   * process spawned by the extension host (most importantly the detached
   * MCP daemon in `daemon/runtime.ts::spawnBundledDaemon`) inherits the
   * same browser selection. The daemon reads `findBrowser()` from
   * mcp-server's `config.ts`, which honors the env vars we set here.
   *
   * Called after each `refreshBrowserDetection()` so the extension host's
   * env mirrors the active selection.
   */
  private syncProcessEnv(): void {
    const b = this._browser;
    if (b.channel) {
      process.env.PERPLEXITY_BROWSER_CHANNEL = b.channel;
    } else {
      delete process.env.PERPLEXITY_BROWSER_CHANNEL;
    }
    if (b.executablePath) {
      process.env.PERPLEXITY_BROWSER_PATH = b.executablePath;
    } else {
      delete process.env.PERPLEXITY_BROWSER_PATH;
    }
    // v0.8.5 cleanup: clear any stale PERPLEXITY_OBSCURA_ENDPOINT inherited
    // from an older extension host that briefly supported the (removed)
    // Obscura channel — leaves the env clean for child runners.
    delete process.env.PERPLEXITY_OBSCURA_ENDPOINT;
  }

  /**
   * Env vars forwarded to spawned runners and the MCP server so they launch
   * with the selected browser.
   */
  private async resolveBrowserEnv(): Promise<Record<string, string>> {
    if (!this._browser.found) this.refreshBrowserDetection();
    const env: Record<string, string> = {};
    const b = this._browser;
    if (b.channel) env.PERPLEXITY_BROWSER_CHANNEL = b.channel;
    if (b.executablePath) env.PERPLEXITY_BROWSER_PATH = b.executablePath;
    return env;
  }

  dispose(): void {
    this._downloadListener?.dispose();
    this._onDidChange.dispose();
  }

  /** Inject a logger so diagnostics from login runners flow into the main
   *  Perplexity output channel. Safe to call multiple times; last wins. */
  setLogger(fn: (line: string) => void): void {
    this.logger = fn;
  }

  private log(line: string): void {
    try { this.logger?.(line); } catch { /* logger must never throw */ }
  }

  private setState(s: Partial<AuthState>): void {
    this._state = { ...this._state, ...s };
    this._onDidChange.fire(this._state);
  }

  async login(opts: LoginOptions): Promise<AuthLoginResult> {
    const key = `login:${opts.profile}`;
    if (this.inflight.has(key)) {
      throw new Error(`Login already in progress for '${opts.profile}'`);
    }
    const promise = this.runLogin(opts);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async runLogin(opts: LoginOptions): Promise<AuthLoginResult> {
    this.setState({ profile: opts.profile, status: "logging-in", error: undefined, errorDetail: undefined });
    const runnerPath = opts.runnerPath ?? this.defaultRunnerPath(opts.mode);

    // Forward the detected browser to the runner so the spawned login
    // process inherits the same browser selection (Chrome > Edge > Brave >
    // bundled). Custom-path picks pass through via PERPLEXITY_BROWSER_PATH.
    const browserEnv = await this.resolveBrowserEnv();

    const env: Record<string, string> = { ...browserEnv, PERPLEXITY_PROFILE: opts.profile };
    if (opts.mode === "auto") env.PERPLEXITY_EMAIL = opts.email ?? "";

    // v0.8.6: resolve a vault passphrase BEFORE spawning the runner. On
    // macOS/Windows and on Linux boxes with a working keychain this is a
    // no-op: the provider returns source="keytar" and we don't set the env
    // var (keychain wins in vault.js). On headless Linux without libsecret
    // the provider prompts the user once and stores the passphrase in VS
    // Code SecretStorage so the runner can decrypt/encrypt vault.enc.
    if (opts.passphraseProvider) {
      try {
        const res = await opts.passphraseProvider();
        if (res.source === "cancelled") {
          const msg = "Login cancelled — no passphrase provided. Set PERPLEXITY_VAULT_PASSPHRASE or enter a passphrase when prompted.";
          this.log(`[login:${opts.profile}] passphrase_cancelled`);
          this.setState({ status: "error", error: msg, errorDetail: msg });
          return { ok: false, reason: "passphrase_cancelled", error: msg, detail: msg };
        }
        if (res.passphrase) {
          env.PERPLEXITY_VAULT_PASSPHRASE = res.passphrase;
        }
      } catch (err) {
        const msg = `Passphrase provider failed: ${(err as Error).message}`;
        this.log(`[login:${opts.profile}] ${msg}`);
        this.setState({ status: "error", error: msg, errorDetail: msg });
        return { ok: false, reason: "passphrase_error", error: msg, detail: msg };
      }
    }

    try {
      const result = await spawnRunner(runnerPath, env, {
        onSend: (child) => {
          child.on("message", async (msg: unknown) => {
            const m = msg as { phase?: string };
            if (m?.phase === "awaiting_otp" && opts.onOtpPrompt) {
              this.setState({ status: "awaiting_otp" });
              const otp = await opts.onOtpPrompt();
              if (otp) child.send({ otp });
            }
            if (m?.phase === "awaiting_user") {
              opts.onProgress?.("awaiting_user");
            }
          });
        },
      });
      const ok = !!result.ok;
      if (ok) {
        this.setState({
          status: "valid",
          tier: result.tier as AuthState["tier"],
          lastLogin: new Date().toISOString(),
          error: undefined,
          errorDetail: undefined,
        });
        return { ok: true, tier: result.tier as string };
      }
      // v0.8.6: preserve the runner's `error` / `detail` / `stack` fields
      // alongside `reason`. Without this the dashboard was rendering only the
      // `reason` enum ("crash") and the root cause was invisible to users.
      const reason = String(result.reason ?? "login_failed");
      const error = typeof result.error === "string" ? result.error : undefined;
      const detailRaw = typeof result.detail === "string"
        ? result.detail
        : typeof result.stack === "string"
          ? result.stack
          : error;
      const detail = detailRaw ? truncate(detailRaw) : undefined;
      this.log(`[login:${opts.profile}] runner failed reason=${reason}${error ? ` error=${error}` : ""}${detail && detail !== error ? ` detail=${detail}` : ""}`);
      this.setState({
        status: "error",
        error: error ?? reason,
        errorDetail: detail ?? error ?? reason,
      });
      return { ok: false, reason, error, detail };
    } catch (err) {
      const e = err as Error;
      const msg = e.message;
      const detail = e.stack ? truncate(e.stack) : undefined;
      this.log(`[login:${opts.profile}] spawn/exception: ${msg}`);
      this.setState({ status: "error", error: msg, errorDetail: detail ?? msg });
      return { ok: false, reason: msg, error: msg, detail };
    }
  }

  async logout(opts: LogoutOptions): Promise<void> {
    const key = `logout:${opts.profile}`;
    if (this.inflight.has(key)) return;
    const promise = (async () => {
      if (opts.purge) await hardLogout(opts.profile);
      else await softLogout(opts.profile);
      this.setState({
        profile: opts.profile,
        status: "unknown",
        tier: undefined,
        lastLogin: undefined,
      });
    })();
    this.inflight.set(key, promise);
    try {
      await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  checkSession(opts: CheckSessionOptions): Promise<AuthState> {
    const key = `check:${opts.profile}`;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<AuthState>;
    const promise = (async () => {
      this.setState({ profile: opts.profile, status: "checking" });
      const runnerPath = this.defaultRunnerPath("health");
      // Forward the full browser selection so health-check launches with the
      // same Chrome-family runtime AuthManager resolved.
      const browserEnv = await this.resolveBrowserEnv();
      try {
        const result = await spawnRunner(runnerPath, { ...browserEnv, PERPLEXITY_PROFILE: opts.profile }, { timeoutMs: 20_000 });
        if (result.valid) {
          this.setState({
            status: "valid",
            tier: result.tier as AuthState["tier"],
            lastChecked: new Date().toISOString(),
            error: undefined,
          });
        } else {
          const reason = String(result.reason ?? "unknown");
          this.setState({
            status: reason === "no_cookies" ? "unknown" : "expired",
            error: reason,
            lastChecked: new Date().toISOString(),
          });
        }
      } catch (err) {
        this.setState({
          status: "error",
          error: (err as Error).message,
          lastChecked: new Date().toISOString(),
        });
      }
      return this._state;
    })().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise as Promise<AuthState>;
  }

  private defaultRunnerPath(mode: "auto" | "manual" | "health"): string {
    const map = {
      auto: "login-runner.mjs",
      manual: "manual-login-runner.mjs",
      health: "health-check.mjs",
    } as const;
    return join(this.extensionUri.fsPath, "dist", "mcp", map[mode]);
  }
}

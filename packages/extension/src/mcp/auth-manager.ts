import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import * as vscode from "vscode";
import { softLogout, hardLogout } from "perplexity-user-mcp/logout";

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
}

export interface LoginOptions {
  profile: string;
  mode: "auto" | "manual";
  email?: string;
  runnerPath?: string;
  onOtpPrompt?: () => Promise<string | null>;
  onProgress?: (phase: string, detail?: unknown) => void;
  plainCookies?: boolean;
}

export interface LogoutOptions { profile: string; purge?: boolean }
export interface CheckSessionOptions { profile: string }

export interface AuthManagerOptions {
  extensionUri: vscode.Uri;
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

  constructor(opts: AuthManagerOptions) {
    this.extensionUri = opts.extensionUri;
  }

  get state(): AuthState { return this._state; }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private setState(s: Partial<AuthState>): void {
    this._state = { ...this._state, ...s };
    this._onDidChange.fire(this._state);
  }

  async login(opts: LoginOptions): Promise<{ ok: boolean; reason?: string; tier?: string }> {
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

  private async runLogin(opts: LoginOptions): Promise<{ ok: boolean; reason?: string; tier?: string }> {
    this.setState({ profile: opts.profile, status: "logging-in", error: undefined });
    const runnerPath = opts.runnerPath ?? this.defaultRunnerPath(opts.mode);
    const env: Record<string, string> = { PERPLEXITY_PROFILE: opts.profile };
    if (opts.mode === "auto") env.PERPLEXITY_EMAIL = opts.email ?? "";
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
        });
        return { ok: true, tier: result.tier as string };
      }
      this.setState({ status: "error", error: String(result.reason ?? "login_failed") });
      return { ok: false, reason: String(result.reason ?? "login_failed") };
    } catch (err) {
      this.setState({ status: "error", error: (err as Error).message });
      return { ok: false, reason: (err as Error).message };
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
      try {
        const result = await spawnRunner(runnerPath, { PERPLEXITY_PROFILE: opts.profile }, { timeoutMs: 20_000 });
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

import { fork, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";

/**
 * Spawn a bundled runner script (login-runner / manual-login-runner /
 * health-check / doctor) as a child process and resolve with the last
 * line of stdout parsed as JSON. Runners in Phase 2 onward will emit
 * one JSON line per invocation; this harness is the shared plumbing.
 */
export async function spawnRunner(
  scriptPath: string,
  env: Record<string, string> = {},
  opts: { timeoutMs?: number; onMessage?: (msg: unknown) => void } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(scriptPath, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => {
      // Debug channel; stderr is for human-readable logs, stdout for JSON.
      if (process.env.PERPLEXITY_DEBUG === "1") process.stderr.write(`[runner] ${d}`);
    });

    if (opts.onMessage) child.on("message", opts.onMessage);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Runner timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.on("close", () => {
      if (timer) clearTimeout(timer);
      try {
        const lines = stdout.trim().split("\n").filter(Boolean);
        const last = lines[lines.length - 1];
        if (!last) return reject(new Error("Runner produced no output"));
        resolve(JSON.parse(last) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`Failed to parse runner output: ${(err as Error).message}`));
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

export interface AuthState {
  profile: string;
  status: "unknown" | "checking" | "valid" | "expired" | "error" | "logging-in" | "awaiting_otp" | "chrome_missing" | "sso_required";
  tier?: "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous";
  lastLogin?: string;
  lastChecked?: string;
  error?: string;
}

export class AuthManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<AuthState>();
  public readonly onDidChange = this._onDidChange.event;
  private _state: AuthState = { profile: "default", status: "unknown" };

  get state(): AuthState { return this._state; }

  dispose(): void {
    this._onDidChange.dispose();
  }

  // Phase 2 fills in login(), logout(), checkSession(), etc.
}

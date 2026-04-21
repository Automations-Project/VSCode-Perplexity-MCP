import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface TunnelState {
  status: "starting" | "enabled" | "disabled" | "crashed";
  url: string | null;
  pid: number | null;
  error?: string | null;
}

export interface StartTunnelOptions {
  command: string;
  args?: string[];
  port: number;
  env?: NodeJS.ProcessEnv;
  onStateChange?: (state: TunnelState) => void;
}

export interface StartedTunnel {
  pid: number;
  waitUntilReady: Promise<string>;
  stop: () => Promise<void>;
  getState: () => TunnelState;
}

export function startTunnel(options: StartTunnelOptions): StartedTunnel {
  const child = spawn(
    options.command,
    [...(options.args ?? []), "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${options.port}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      env: options.env,
    },
  );

  let stopping = false;
  let settled = false;
  let resolveExited: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  let state: TunnelState = {
    status: "starting",
    url: null,
    pid: child.pid ?? null,
    error: null,
  };

  const updateState = (next: TunnelState) => {
    state = next;
    options.onStateChange?.(state);
  };

  updateState(state);

  let resolveReady: (url: string) => void;
  let rejectReady: (error: Error) => void;
  const waitUntilReady = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const handleLine = (line: string) => {
    const url = extractTunnelUrl(line);
    if (!url || settled) {
      return;
    }
    settled = true;
    updateState({
      status: "enabled",
      url,
      pid: child.pid ?? null,
      error: null,
    });
    resolveReady(url);
  };

  createInterface({ input: child.stderr! }).on("line", handleLine);
  createInterface({ input: child.stdout! }).on("line", handleLine);

  child.on("error", (error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
    updateState({
      status: stopping ? "disabled" : "crashed",
      url: null,
      pid: child.pid ?? null,
      error: error.message,
    });
  });

  child.on("exit", (code, signal) => {
    if (!settled) {
      settled = true;
      rejectReady(new Error(`cloudflared exited before publishing a tunnel URL (code=${code ?? "null"} signal=${signal ?? "null"}).`));
    }
    updateState({
      status: stopping ? "disabled" : "crashed",
      url: stopping ? null : state.url,
      pid: null,
      error: stopping ? null : `cloudflared exited (code=${code ?? "null"} signal=${signal ?? "null"}).`,
    });
    resolveExited();
  });

  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;

    if (child.exitCode !== null || child.killed) {
      updateState({
        status: "disabled",
        url: null,
        pid: null,
        error: null,
      });
      return;
    }

    if (process.platform === "win32") {
      await execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => undefined);
      await exited;
      return;
    }

    child.kill("SIGTERM");
    await exited;
  };

  return {
    pid: child.pid ?? 0,
    waitUntilReady,
    stop,
    getState: () => state,
  };
}

export function extractTunnelUrl(line: string): string | null {
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
  return match?.[0] ?? null;
}

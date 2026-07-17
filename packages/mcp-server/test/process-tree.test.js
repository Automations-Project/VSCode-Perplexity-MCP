import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  terminateProcessTree,
  findProfileBrowserPids,
  evictProfileSquatters,
} from "../src/process-tree.ts";

// Orphan-browser lifecycle (issues #15 + the "loops of tabs" report).
//
// A Chromium that outlives its daemon keeps the profile ProcessSingleton;
// every later launchPersistentContext is FORWARDED to it ("Opening in
// existing browser session") and fails — while each retry opens another tab
// in the orphan. These helpers are the cure: tree-kill so daemon reclaims
// stop creating orphans (Windows TerminateProcess never ran the daemon's
// cleanup), and eviction so an existing orphan is removed by the rightful
// profile owner instead of tab-spammed.

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitGone = async (pid, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
};

const children = [];
const tempDirs = [];
afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone — the expected case
    }
  }
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** Spawn a live sleeper whose argv carries `extraArg` (visible in its cmdline). */
function spawnSleeper(extraArg) {
  // The `--` matters: without it node parses a `--user-data-dir=…` marker as
  // an (unknown) NODE option and dies at spawn — an instantly-dead sleeper
  // made this whole suite pass/fail for the wrong reasons.
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "--", ...(extraArg ? [extraArg] : [])],
    { stdio: "ignore" },
  );
  children.push(child.pid);
  return child.pid;
}

describe("terminateProcessTree", () => {
  it("kills the root process", async () => {
    const pid = spawnSleeper();
    await terminateProcessTree(pid);
    expect(await waitGone(pid)).toBe(true);
  }, 15_000);

  it("on Windows, kills the CHILD too — the whole point (TerminateProcess orphans children)", async () => {
    if (process.platform !== "win32") return; // POSIX: the root's own SIGTERM handler owns child cleanup
    // Parent that spawns a child sleeper and prints its pid.
    const dir = mkdtempSync(join(tmpdir(), "px-tree-"));
    tempDirs.push(dir);
    const parentScript = join(dir, "parent.mjs");
    writeFileSync(
      parentScript,
      [
        'import { spawn } from "node:child_process";',
        'const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "process.stdout.write(String(c.pid) + \"\\n\");",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const parent = spawn(process.execPath, [parentScript], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(parent.pid);
    const childPid = await new Promise((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("no child pid")), 10_000);
      parent.stdout.on("data", (d) => {
        buf += String(d);
        const n = Number.parseInt(buf, 10);
        if (Number.isInteger(n) && n > 0) {
          clearTimeout(t);
          resolve(n);
        }
      });
    });
    children.push(childPid);

    await terminateProcessTree(parent.pid);
    expect(await waitGone(parent.pid)).toBe(true);
    expect(await waitGone(childPid)).toBe(true);
  }, 20_000);

  it("never signals our own pid and tolerates dead/invalid pids", async () => {
    await expect(terminateProcessTree(process.pid)).resolves.toBeUndefined();
    await expect(terminateProcessTree(0)).resolves.toBeUndefined();
    await expect(terminateProcessTree(0x7fffffff)).resolves.toBeUndefined();
  }, 15_000);
});

describe("findProfileBrowserPids", () => {
  it("finds a process whose command line carries --user-data-dir=<dir>, and only that one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-find-"));
    tempDirs.push(dir);
    const squatter = spawnSleeper(`--user-data-dir=${dir}`);
    const bystander = spawnSleeper(); // no marker — must never be matched
    await new Promise((r) => setTimeout(r, 300)); // let cmdlines register

    const pids = await findProfileBrowserPids(dir);
    expect(pids).toContain(squatter);
    expect(pids).not.toContain(bystander);
    expect(pids).not.toContain(process.pid);
  }, 20_000);

  it("returns [] when nothing squats the profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-find-empty-"));
    tempDirs.push(dir);
    expect(await findProfileBrowserPids(dir)).toEqual([]);
  }, 20_000);
});

describe("evictProfileSquatters", () => {
  it("kills the squatter when nobody owns the profile", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "px-evict-"));
    tempDirs.push(configDir);
    const browserData = join(configDir, "profiles", "default", "browser-data");
    mkdirSync(browserData, { recursive: true });
    const squatter = spawnSleeper(`--user-data-dir=${browserData}`);
    await new Promise((r) => setTimeout(r, 300));

    const result = await evictProfileSquatters(browserData, configDir);
    expect(result.refusedReason).toBeNull();
    expect(result.evicted).toContain(squatter);
    expect(await waitGone(squatter)).toBe(true);
  }, 20_000);

  it("REFUSES when a live foreign daemon owns the profile — we would be the trespasser", async () => {
    // browser-data is daemon-single-owner (issue #8). If a live daemon other
    // than us holds daemon.lock, the "squatter" is probably ITS browser —
    // killing it would sabotage every attached client (e.g. from an
    // in-process stdio fallback).
    const configDir = mkdtempSync(join(tmpdir(), "px-evict-owned-"));
    tempDirs.push(configDir);
    const browserData = join(configDir, "profiles", "default", "browser-data");
    mkdirSync(browserData, { recursive: true });

    const foreignDaemon = spawnSleeper();
    writeFileSync(
      join(configDir, "daemon.lock"),
      JSON.stringify({ pid: foreignDaemon, uuid: "u", port: 1, bearerToken: "t", version: "0", startedAt: "x" }),
    );
    const itsBrowser = spawnSleeper(`--user-data-dir=${browserData}`);
    await new Promise((r) => setTimeout(r, 300));

    const result = await evictProfileSquatters(browserData, configDir);
    expect(result.refusedReason).toBe("foreign-daemon-owns-profile");
    expect(result.evicted).toEqual([]);
    expect(alive(itsBrowser)).toBe(true);
    expect(alive(foreignDaemon)).toBe(true);
  }, 20_000);

  it("evicts when the lock holder is DEAD (that is exactly the orphan case)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "px-evict-deadlock-"));
    tempDirs.push(configDir);
    const browserData = join(configDir, "profiles", "default", "browser-data");
    mkdirSync(browserData, { recursive: true });
    writeFileSync(
      join(configDir, "daemon.lock"),
      JSON.stringify({ pid: 0x7fffffff, uuid: "u", port: 1, bearerToken: "t", version: "0", startedAt: "x" }),
    );
    const orphan = spawnSleeper(`--user-data-dir=${browserData}`);
    await new Promise((r) => setTimeout(r, 300));

    const result = await evictProfileSquatters(browserData, configDir);
    expect(result.refusedReason).toBeNull();
    expect(result.evicted).toContain(orphan);
    expect(await waitGone(orphan)).toBe(true);
  }, 20_000);
});

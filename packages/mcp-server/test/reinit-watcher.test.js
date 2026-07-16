import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { watchActiveProfile, watchReinit } from "../src/reinit-watcher.js";
import { createProfile, getProfilePaths, setActive } from "../src/profiles.js";

describe("reinit-watcher", () => {
  let configDir, watcher;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-watch-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    createProfile("default");
  });
  afterEach(() => { watcher?.dispose(); });

  it("fires callback when .reinit appears", async () => {
    const cb = vi.fn();
    watcher = watchReinit("default", cb);
    writeFileSync(getProfilePaths("default").reinit, "x");
    await new Promise((r) => setTimeout(r, 300));
    expect(cb).toHaveBeenCalled();
  });

  it("debounces rapid writes to a single invocation", async () => {
    const cb = vi.fn();
    watcher = watchReinit("default", cb, { debounceMs: 150 });
    for (let i = 0; i < 5; i++) writeFileSync(getProfilePaths("default").reinit, String(i));
    await new Promise((r) => setTimeout(r, 400));
    expect(cb.mock.calls.length).toBe(1);
  });

  it("dispose stops firing", async () => {
    const cb = vi.fn();
    watcher = watchReinit("default", cb);
    watcher.dispose();
    writeFileSync(getProfilePaths("default").reinit, "x");
    await new Promise((r) => setTimeout(r, 200));
    expect(cb).not.toHaveBeenCalled();
  });

  it("survives a callback that throws synchronously", async () => {
    const cb = vi.fn(() => {
      throw new Error("sync boom");
    });
    watcher = watchReinit("default", cb);
    writeFileSync(getProfilePaths("default").reinit, "x");
    await new Promise((r) => setTimeout(r, 300));
    expect(cb).toHaveBeenCalled();
  });

  // The daemon-killer behind the ECONNREFUSED reports on issue #10.
  //
  // The watcher used to run its callback as `try { callback(); } catch {}`.
  // launcher.ts hands it `async () => { await client.reinit(); }` — an async
  // fn returns a promise WITHOUT throwing, so the sync catch never fired and
  // the promise was dropped. A rejecting reinit (Cloudflare block, profile
  // lock, no browser) then became an unhandled rejection, and Node >=15's
  // default --unhandled-rejections=throw HARD-EXITED the daemon. A healthy,
  // listening HTTP server died because a background refresh failed; VS Code
  // kept its cached http://127.0.0.1:<port>/mcp and every call got
  // ECONNREFUSED.
  //
  // This must run in a real subprocess: vitest installs its own rejection
  // handler, so an in-process test cannot observe the exit that defines the bug.
  it("survives a rejecting async callback instead of hard-exiting the process", () => {
    // Dynamic import() needs a file:// URL — a bare Windows `c:\...` path is
    // rejected by the ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME).
    const watcherModule = new URL("../src/reinit-watcher.js", import.meta.url).href;
    const profilesModule = new URL("../src/profiles.js", import.meta.url).href;
    const harness = `
      import { mkdtempSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const dir = mkdtempSync(join(tmpdir(), "px-reject-"));
      process.env.PERPLEXITY_CONFIG_DIR = dir;
      const { createProfile, getProfilePaths } = await import(${JSON.stringify(profilesModule)});
      const { watchReinit } = await import(${JSON.stringify(watcherModule)});
      createProfile("default");
      let fired = false;
      const w = watchReinit("default", async () => {
        fired = true;
        throw new Error("reinit failed (simulates CF block / profile lock)");
      });
      writeFileSync(getProfilePaths("default").reinit, "x");
      // Long enough for the debounce to fire and any unhandled rejection to
      // tear the process down before we report success.
      setTimeout(() => {
        w.dispose();
        if (!fired) { console.error("callback never fired"); process.exit(2); }
        console.log("SURVIVED");
        process.exit(0);
      }, 800);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", harness], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(
      result.stdout,
      `Daemon process did not survive a rejecting reinit callback.\n` +
        `exit=${result.status}\nstderr=${result.stderr}`,
    ).toContain("SURVIVED");
    expect(result.status).toBe(0);
  }, 20_000);
});

describe("watchActiveProfile", () => {
  let configDir, watcher;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-active-watch-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    createProfile("default");
    createProfile("pro");
    setActive("default");
  });
  afterEach(() => { watcher?.dispose(); });

  it("fires when setActive switches the active profile", async () => {
    const cb = vi.fn();
    watcher = watchActiveProfile(configDir, cb, { debounceMs: 100 });
    setActive("pro");
    await new Promise((r) => setTimeout(r, 300));
    expect(cb).toHaveBeenCalled();
  });

  it("dispose stops firing on subsequent profile switches", async () => {
    const cb = vi.fn();
    watcher = watchActiveProfile(configDir, cb, { debounceMs: 50 });
    watcher.dispose();
    setActive("pro");
    await new Promise((r) => setTimeout(r, 200));
    expect(cb).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

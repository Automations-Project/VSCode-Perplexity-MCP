import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// write-launcher.ts computes CONFIG_DIR at module load from os.homedir(). We
// hoist a fresh tmpdir per test and stub os.homedir() so the module writes
// into the tmpdir instead of the user's real home. Each test uses
// vi.resetModules() + dynamic import so the module re-evaluates against the
// current stub.

const tempHomes: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "perplexity-launcher-test-"));
  tempHomes.push(dir);
  return dir;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("os");
  while (tempHomes.length > 0) {
    const dir = tempHomes.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function loadWriteLauncher(home: string) {
  vi.doMock("os", async () => {
    const actual = await vi.importActual<typeof import("os")>("os");
    return {
      ...actual,
      default: { ...actual, homedir: () => home },
      homedir: () => home,
    };
  });
  return await import("../src/launcher/write-launcher.js");
}

describe("write-launcher (Task 8.3.3: daemon-proxy)", () => {
  it("writes start.mjs with all required daemon-proxy substrings", async () => {
    const home = freshHome();
    const mod = await loadWriteLauncher(home);
    const serverPath = join(home, "fake-server.mjs");

    const { launcherPath, configDir } = mod.ensureLauncher(serverPath);

    expect(configDir).toBe(join(home, ".perplexity-mcp"));
    expect(launcherPath).toBe(join(home, ".perplexity-mcp", "start.mjs"));
    expect(existsSync(launcherPath)).toBe(true);

    const content = readFileSync(launcherPath, "utf8");

    // Required substrings per Task 8.3.3 spec.
    expect(content).toContain("attachToDaemon");
    expect(content).toContain("fallbackStdio: true");
    expect(content).toContain("PERPLEXITY_NO_DAEMON");
    expect(content).toContain("runStdioMain");

    // server.main() must appear at least twice (opt-out branch + DI shim).
    const mainCalls = content.match(/server\.main\(\)/g) ?? [];
    expect(mainCalls.length).toBeGreaterThanOrEqual(2);

    // Literal backtick template literal for clientId (not a JS escape — the
    // generated file must contain real backtick characters).
    expect(content).toContain("`perplexity-launcher-${process.pid}`");
  });

  it("generated start.mjs does not write to stdout (no console.log / console.info)", async () => {
    const home = freshHome();
    const mod = await loadWriteLauncher(home);
    const { launcherPath } = mod.ensureLauncher(join(home, "fake-server.mjs"));

    const content = readFileSync(launcherPath, "utf8");

    // stdout is the JSON-RPC framing channel — any byte there corrupts it.
    expect(content).not.toContain("console.log");
    expect(content).not.toContain("console.info");
  });

  it("is idempotent: second ensureLauncher call does not rewrite when content matches", async () => {
    const home = freshHome();
    const mod = await loadWriteLauncher(home);
    const serverPath = join(home, "fake-server.mjs");

    mod.ensureLauncher(serverPath);
    const launcherPath = join(home, ".perplexity-mcp", "start.mjs");
    const firstContent = readFileSync(launcherPath, "utf8");
    const firstMtime = statSync(launcherPath).mtimeMs;

    // Second call with identical serverPath → content matches → no rewrite.
    mod.ensureLauncher(serverPath);
    const secondContent = readFileSync(launcherPath, "utf8");
    const secondMtime = statSync(launcherPath).mtimeMs;

    expect(secondContent).toBe(firstContent);
    // mtime should be unchanged (no rewrite happened). This is a loose check:
    // on some filesystems mtime granularity is coarse (up to 2s on FAT), so
    // we only assert that it did NOT move forward past the first mtime.
    expect(secondMtime).toBeLessThanOrEqual(firstMtime + 5);
  });

  it("migrates the stale pre-8.3.3 in-process launcher to the daemon-proxy launcher", async () => {
    const home = freshHome();
    const mod = await loadWriteLauncher(home);
    const serverPath = join(home, "fake-server.mjs");

    // Pre-seed the OLD pre-8.3.3 launcher content. Users upgrading from
    // 0.7.x must have this force-rewritten.
    const oldContent = `#!/usr/bin/env node
// Stable launcher -- never moves. Reads actual server path dynamically.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "bundled-path.json"), "utf8"));
await import(config.serverPath);
`;
    const configDir = join(home, ".perplexity-mcp");
    // mkdirSync via the module's own ensureLauncher call below will create
    // this dir — but we need the file to exist BEFORE the call, so create
    // the dir ourselves.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(configDir, { recursive: true });
    const launcherPath = join(configDir, "start.mjs");
    writeFileSync(launcherPath, oldContent);

    mod.ensureLauncher(serverPath);

    const newContent = readFileSync(launcherPath, "utf8");
    expect(newContent).not.toBe(oldContent);
    // New launcher has the daemon-proxy markers.
    expect(newContent).toContain("attachToDaemon");
    expect(newContent).toContain("PERPLEXITY_NO_DAEMON");
    expect(newContent).toContain("runStdioMain");
  });

  it("writes bundled-path.json with serverPath (file URL) and fsPath", async () => {
    const home = freshHome();
    const mod = await loadWriteLauncher(home);
    const serverPath = join(home, "nested", "fake-server.mjs");

    mod.ensureLauncher(serverPath);

    const bundledPath = join(home, ".perplexity-mcp", "bundled-path.json");
    expect(existsSync(bundledPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(bundledPath, "utf8"));

    expect(parsed.fsPath).toBe(serverPath);
    expect(typeof parsed.serverPath).toBe("string");
    expect(parsed.serverPath.startsWith("file:")).toBe(true);
    // serverPath is the file:// URL form of fsPath. Decoded basename must
    // match the tail segment.
    expect(decodeURIComponent(parsed.serverPath)).toContain("fake-server.mjs");
  });

  it("checkLauncherHealth returns 'configured' for the canonical launcher path", async () => {
    const home = freshHome();
    const mod = await loadWriteLauncher(home);
    const serverPath = join(home, "fake-server.mjs");

    const { launcherPath } = mod.ensureLauncher(serverPath);

    expect(mod.checkLauncherHealth([launcherPath])).toBe("configured");
    expect(mod.checkLauncherHealth([])).toBe("stale");
  });
});

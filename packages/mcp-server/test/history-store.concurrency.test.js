import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cross-process history integrity.
//
// Two processes appending concurrently used to lose 19-23 of 50 entries, every
// run, via two independent bugs:
//   1. lost update — both read the same base index, last writeIndex wins;
//   2. a FIXED `index.json.tmp` shared by every writer — A renames it away and
//      B's renameSync throws ENOENT on its own vanished temp.
// The .md file always survived, but loadIndexedEntries only rebuilds when the
// index is unparseable — a short-but-valid index never triggers it, so the
// entries stayed invisible until a manual rebuild.
//
// This MUST spawn real processes: history-store.js is fully synchronous, so an
// in-process test cannot interleave two appends and would pass against the bug.

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    } catch {
      // Windows can hold a handle briefly; the OS temp dir gets cleaned anyway.
    }
  }
});

const APPENDS_PER_WORKER = 25;

function workerSource(storeUrl) {
  return `
    import { append } from ${JSON.stringify(storeUrl)};
    const tag = process.argv[2];
    for (let i = 0; i < ${APPENDS_PER_WORKER}; i++) {
      append({
        tool: "perplexity_search",
        query: \`\${tag}-\${i}\`,
        body: "body",
        model: "pplx_pro",
        tier: "Pro",
      });
    }
    process.exit(0);
  `;
}

function runWorker(workerPath, configDir, tag) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, tag], {
      env: { ...process.env, PERPLEXITY_CONFIG_DIR: configDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

describe("history-store cross-process concurrency", () => {
  it("two processes appending concurrently lose no index entries", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "px-hist-race-"));
    tempDirs.push(configDir);

    const storeUrl = new URL("../src/history-store.js", import.meta.url).href;
    const workerPath = join(configDir, "worker.mjs");
    writeFileSync(workerPath, workerSource(storeUrl));

    const [a, b] = await Promise.all([
      runWorker(workerPath, configDir, "alpha"),
      runWorker(workerPath, configDir, "beta"),
    ]);

    expect(a.code, `worker A failed: ${a.stderr}`).toBe(0);
    expect(b.code, `worker B failed: ${b.stderr}`).toBe(0);

    const historyDir = join(configDir, "profiles", "default", "history");
    const mdFiles = readdirSync(historyDir).filter((f) => f.endsWith(".md"));
    const index = JSON.parse(readFileSync(join(historyDir, "index.json"), "utf8"));

    const expected = APPENDS_PER_WORKER * 2;
    expect(mdFiles.length).toBe(expected);
    // The bug: this was 27-31 of 50 while the .md count was already correct.
    expect(index.items.length).toBe(expected);

    // Every append must be addressable, not merely on disk.
    const queries = new Set(index.items.map((i) => i.query));
    expect(queries.size).toBe(expected);

    // No temp files leaked, and the lock was released.
    expect(readdirSync(historyDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(historyDir).includes("index.lock")).toBe(false);
  }, 30_000);

  it("stages temp files under a unique name per writer and leaves none behind", async () => {
    // Regression for the fixed `${path}.tmp` collision: two writers must never
    // share a staging path.
    const configDir = mkdtempSync(join(tmpdir(), "px-hist-tmp-"));
    tempDirs.push(configDir);
    process.env.PERPLEXITY_CONFIG_DIR = configDir;

    const { append, getHistoryDir } = await import("../src/history-store.js");
    append({ tool: "perplexity_search", query: "tmp-check", body: "b", model: "m", tier: "Pro" });

    expect(readdirSync(getHistoryDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // Assert the assignment itself, not any mention of the old shape — the
    // comment above it legitimately quotes the bug being fixed.
    const src = readFileSync(new URL("../src/history-store.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/const tempPath = `\$\{path}\.tmp`/);
    expect(src).toMatch(/const tempPath = `\$\{path}\.\$\{process\.pid}\./);
  });
});

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// First-run regression (broke CI, not the dev box).
//
// The Phase A index lock is opened with openSync(path, "wx"), which fails
// ENOENT when the PARENT directory does not exist. On a fresh machine there is
// no ~/.perplexity-mcp/profiles/<name>/history yet, and rebuildIndex creates
// the store dirs *inside* its own locked section — so it took the lock before
// anything had made the directory and threw ENOENT straight out of
// `rebuild-history-index`.
//
// This only shows up on a profile that has never been touched, which is why
// every local run passed and three CI matrix cells failed. Each case runs in a
// child process against a pristine PERPLEXITY_CONFIG_DIR — importing the store
// in-process would inherit whatever profile state this suite already created.

const tempDirs = [];
let workerPath;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "px-firstrun-"));
  tempDirs.push(dir);
  workerPath = join(dir, "worker.mjs");
});

afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    } catch {
      // Windows may hold a handle briefly; the OS temp dir gets cleaned anyway.
    }
  }
});

/** Run `body` in a child process against a config dir that does not exist yet. */
function runFresh(body) {
  const storeUrl = new URL("../src/history-store.js", import.meta.url).href;
  const configDir = join(tempDirs[tempDirs.length - 1], "never-created");
  writeFileSync(
    workerPath,
    [
      `process.env.PERPLEXITY_CONFIG_DIR = ${JSON.stringify(configDir)};`,
      `const store = await import(${JSON.stringify(storeUrl)});`,
      `try { ${body} process.stdout.write("OK"); }`,
      `catch (e) { process.stdout.write("THREW:" + e.code + ":" + e.message); }`,
    ].join("\n"),
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

describe("history-store on a profile that has never existed", () => {
  it("rebuildIndex does not throw ENOENT taking the lock before the dir exists", async () => {
    const r = await runFresh("store.rebuildIndex();");
    expect(r.out, `stderr: ${r.err}`).toBe("OK");
    expect(r.code).toBe(0);
  }, 20_000);

  it("append works on a first-run profile", async () => {
    const r = await runFresh(
      'store.append({ tool: "perplexity_search", query: "q", body: "b", model: "m", tier: "Pro" });',
    );
    expect(r.out, `stderr: ${r.err}`).toBe("OK");
  }, 20_000);

  it("list works on a first-run profile", async () => {
    const r = await runFresh("store.list();");
    expect(r.out, `stderr: ${r.err}`).toBe("OK");
  }, 20_000);
});

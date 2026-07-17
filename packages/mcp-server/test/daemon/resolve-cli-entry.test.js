import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolveCliEntry } from "../../src/daemon/launcher.ts";

// spawnDetachedDaemon (the default spawner ensureDaemon uses when no
// spawnDaemon is injected) resolves its entry via resolveCliEntry.
//
// In the source/test layout, launcher.ts sits at src/daemon/, so `../cli.js`
// resolves to src/cli.js which exists — that path must keep working.
//
// The regression this guards: in the EXTENSION-BUNDLED layout, attach.ts +
// launcher.ts are inlined into dist/mcp/server.mjs with NO cli.* sibling, so
// the old code returned a nonexistent path and spawn silently failed. An
// external stdio client (Grok, Cursor, …) that found no daemon then could not
// start the shared one. The fix falls back to the module's OWN file, which in
// the bundle is server.mjs — itself a valid `daemon start` entry.
describe("resolveCliEntry", () => {
  it("resolves to a real, existing file in the source layout", () => {
    const entry = resolveCliEntry();
    expect(entry).toBeTruthy();
    // Must point at something on disk — the whole bug was pointing at a file
    // that did not exist, so spawn ENOENT'd silently.
    expect(() => readFileSync(entry, "utf8")).not.toThrow();
  });

  it("resolves to a cli entry (source layout has src/cli.js)", () => {
    const entry = resolveCliEntry().replace(/\\/g, "/");
    expect(entry).toMatch(/\/cli\.(mjs|js)$/);
  });
});

describe("attach path is a guest, not the daemon owner (regression lock)", () => {
  // attach.ts must NOT pass expectedMcpVersion to ensureDaemon. It once did
  // (0.8.59), and on a version mismatch the gate killed the running daemon and
  // then could not respawn from the bundled layout — leaving every client's
  // handshake failing after an in-place update (Grok "Timed out waiting for
  // daemon startup"). A guest attaches to whatever healthy daemon exists;
  // version reconciliation is the extension host's job.
  it("attach.ts does not gate ensureDaemon on expectedMcpVersion", () => {
    const src = readFileSync(new URL("../../src/daemon/attach.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/expectedMcpVersion\s*:/);
  });
});

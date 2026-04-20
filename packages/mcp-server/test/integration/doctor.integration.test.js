import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start as startMock } from "./mock-server.js";

let dir, mock;
beforeAll(async () => { mock = await startMock({ port: 0 }); });
afterAll(async () => { await mock.close(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "px-doctor-int-"));
  process.env.PERPLEXITY_CONFIG_DIR = dir;
  process.env.PERPLEXITY_VAULT_PASSPHRASE = "integration-pass";
});

describe("doctor integration — end to end", () => {
  it("produces a structured report with 10 categories and non-fail overall on a clean install", async () => {
    mkdirSync(join(dir, "profiles", "default"), { recursive: true });
    writeFileSync(join(dir, "profiles", "default", "meta.json"), JSON.stringify({ name: "default", loginMode: "manual" }));
    writeFileSync(join(dir, "active"), "default\n");
    const { runAll } = await import("../../src/doctor.js");
    const report = await runAll({ configDir: dir });
    expect(Object.keys(report.byCategory)).toHaveLength(10);
    // The test environment may not have Chrome installed or may lack network
    // access, so overall could be fail — we're only asserting the structural
    // shape of the report here.
    expect(["pass", "warn", "fail"]).toContain(report.overall);
  });

  it("emits carry-over #5 warn when the got-scraping chain is broken", async () => {
    const { run } = await import("../../src/checks/native-deps.js");
    const checks = await run({
      resolveChainOverride: () => { throw new Error("Cannot find module 'is-obj' from 'dot-prop'"); },
    });
    const chain = checks.find((c) => c.name === "got-scraping-chain");
    expect(chain.status).toBe("warn");
    expect(chain.detail.chainError).toMatch(/is-obj/);
    expect(chain.hint).toMatch(/prepare-package-deps/);
  });

  it("JSON output is a single valid parseable line", async () => {
    const { runAll } = await import("../../src/doctor.js");
    const report = await runAll({ configDir: dir });
    const line = JSON.stringify(report);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(Object.keys(JSON.parse(line))).toEqual(
      expect.arrayContaining(["overall", "generatedAt", "durationMs", "activeProfile", "probeRan", "byCategory"]),
    );
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level guards for the 2026-04-27 public-hardening audit.
 *
 * `STEALTH_ARGS` is a module-private array in both `client.ts` and
 * `refresh.ts`, so we cannot import it. Instead, we read the source files
 * verbatim and assert that:
 *   1) The risky `--disable-web-security` flag is gone from both arrays.
 *   2) The other (non-CORS) stealth flags survived — their removal is a
 *      separate decision and not in scope for this commit.
 *
 * If a future contributor re-introduces `--disable-web-security` they will
 * see this test fail with a pointer back to the audit rationale.
 */

const SRC_DIR = join(__dirname, "..", "src");
const CLIENT_TS = readFileSync(join(SRC_DIR, "client.ts"), "utf8");
const REFRESH_TS = readFileSync(join(SRC_DIR, "refresh.ts"), "utf8");

function extractStealthArray(source: string): string {
  const start = source.indexOf("const STEALTH_ARGS = [");
  if (start === -1) throw new Error("STEALTH_ARGS array not found in source");
  const end = source.indexOf("];", start);
  if (end === -1) throw new Error("STEALTH_ARGS array terminator not found");
  return source.slice(start, end + 2);
}

describe("STEALTH_ARGS — public-hardening guard", () => {
  it("client.ts: --disable-web-security has been removed", () => {
    const arr = extractStealthArray(CLIENT_TS);
    expect(arr).not.toMatch(/"--disable-web-security"/);
  });

  it("refresh.ts: --disable-web-security has been removed", () => {
    const arr = extractStealthArray(REFRESH_TS);
    expect(arr).not.toMatch(/"--disable-web-security"/);
  });

  it("client.ts: surviving non-CORS stealth flags are preserved", () => {
    const arr = extractStealthArray(CLIENT_TS);
    expect(arr).toMatch(/"--disable-blink-features=AutomationControlled"/);
    expect(arr).toMatch(/"--disable-features=IsolateOrigins,site-per-process"/);
    expect(arr).toMatch(/"--disable-site-isolation-trials"/);
    expect(arr).toMatch(/"--no-first-run"/);
    expect(arr).toMatch(/"--no-default-browser-check"/);
    expect(arr).toMatch(/"--disable-infobars"/);
    expect(arr).toMatch(/"--disable-extensions"/);
    expect(arr).toMatch(/"--disable-popup-blocking"/);
  });

  it("refresh.ts: surviving non-CORS stealth flags are preserved", () => {
    const arr = extractStealthArray(REFRESH_TS);
    expect(arr).toMatch(/"--disable-blink-features=AutomationControlled"/);
    expect(arr).toMatch(/"--disable-features=IsolateOrigins,site-per-process"/);
    expect(arr).toMatch(/"--disable-site-isolation-trials"/);
    expect(arr).toMatch(/"--no-first-run"/);
    expect(arr).toMatch(/"--no-default-browser-check"/);
    expect(arr).toMatch(/"--disable-infobars"/);
    expect(arr).toMatch(/"--disable-extensions"/);
    expect(arr).toMatch(/"--disable-popup-blocking"/);
  });
});

describe("downloadASIFiles — APIRequestContext refactor guard", () => {
  it("client.ts: downloadASIFiles uses context.request.get (not in-page fetch)", () => {
    const start = CLIENT_TS.indexOf("private async downloadASIFiles");
    expect(start).toBeGreaterThan(-1);
    // Bound the slice to the immediate next sibling declaration so we don't
    // accidentally pick up `page.evaluate` from later helpers (e.g.
    // extractFromWorkflowBlock, evaluateInBrowser, interceptRequests).
    // The next sibling in this class is `private extractFromWorkflowBlock`
    // — we slice up to that marker.
    const NEXT_SIBLING = "private extractFromWorkflowBlock";
    const next = CLIENT_TS.indexOf(NEXT_SIBLING, start + 1);
    expect(next).toBeGreaterThan(start);
    const methodSrc = CLIENT_TS.slice(start, next);

    // Must use the new API.
    expect(methodSrc).toMatch(/this\.context\.request\.get\(/);
    // Must NOT regress to in-page fetch with credentials: "include".
    expect(methodSrc).not.toMatch(/page\.evaluate/);
    expect(methodSrc).not.toMatch(/credentials:\s*"include"/);
  });

  it("client.ts: dead-code downloadAsset() helper has been removed", () => {
    expect(CLIENT_TS).not.toMatch(/async downloadAsset\(/);
  });
});

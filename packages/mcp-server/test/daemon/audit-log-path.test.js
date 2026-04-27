import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonServer } from "../../src/daemon/server.ts";

function createMockClient() {
  return {
    authenticated: true,
    userId: "user-test",
    accountInfo: null,
    init: async () => undefined,
    shutdown: async () => undefined,
  };
}

// 0.6.1 regression: the audit middleware records `req.originalUrl` (never
// the sub-router-stripped `req.path`) so paths like /authorize served by
// mcpAuthRouter don't get logged as "/". Also verifies query stripping.
describe("audit-log path uses req.originalUrl after sub-router mount-strip", () => {
  let configDir;
  let daemon;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-audit-path-"));
    daemon = await startDaemonServer({
      configDir,
      version: "0.7.4-test",
      bearerToken: "TEST_STATIC_BEARER_0123456789012345678901234",
      createClient: () => createMockClient(),
    });
  });

  afterEach(async () => {
    await daemon?.close?.();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function settle() {
    // res.on("finish") + appendAuditEntry are sync but happen after fetch
    // resolves; one macrotask is enough on every supported runtime.
    await new Promise((r) => setTimeout(r, 25));
  }

  it("records /authorize (not '/') for requests handled by mcpAuthRouter sub-router", async () => {
    // Malformed authorize is fine — we only need the request to flow through
    // mcpAuthRouter's mounted handler so req.path gets stripped to '/' while
    // req.originalUrl retains '/authorize'. Status will be 4xx; that's OK.
    await fetch(`${daemon.url}/authorize?response_type=code&client_id=x`, {
      method: "GET",
    });
    await settle();
    const entries = daemon.readAuditTail(50);
    const hit = entries.find((e) => e.path === "/authorize");
    expect(hit).toBeDefined();
    // Negative assertion guards the regression: if we ever fall back to
    // req.path post-mount-strip, the audit line would record "/" instead.
    const stripped = entries.find(
      (e) => e.path === "/" && typeof e.tool === "string" && e.tool.includes("/authorize") === false,
    );
    expect(stripped).toBeUndefined();
  });

  it("strips query string from the audit path field", async () => {
    await fetch(
      `${daemon.url}/authorize?response_type=code&client_id=secret-id&state=xyz`,
      { method: "GET" },
    );
    await settle();
    const entries = daemon.readAuditTail(50);
    const hit = entries.find((e) => e.path === "/authorize");
    expect(hit).toBeDefined();
    // No '?' anywhere in the recorded path — the secret-bearing query never
    // hits the audit log (audit lines are read by ops; query may carry PKCE
    // state, client_id correlations, etc).
    expect(hit.path).not.toContain("?");
    expect(hit.tool).not.toContain("?");
  });

  it("records /daemon/health verbatim (never stripped, since not a sub-router)", async () => {
    // Sanity check — non-sub-router routes should also work.
    await fetch(`${daemon.url}/daemon/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${daemon.bearerToken}` },
    });
    await settle();
    const entries = daemon.readAuditTail(50);
    const hit = entries.find((e) => e.path === "/daemon/health");
    expect(hit).toBeDefined();
    expect(hit.httpStatus).toBe(200);
  });

  it("audit tool field embeds the full originalUrl path (e.g. http:GET /authorize)", async () => {
    await fetch(`${daemon.url}/authorize?response_type=code`, { method: "GET" });
    await settle();
    const entries = daemon.readAuditTail(50);
    const hit = entries.find((e) => e.tool === "http:GET /authorize");
    expect(hit).toBeDefined();
    expect(hit.path).toBe("/authorize");
  });
});

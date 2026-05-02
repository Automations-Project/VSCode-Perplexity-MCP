import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { runVaultPreflight, waitForStdioInputClose, __resetVaultPreflightForTests } from "../src/index.js";
import { __resetKeyCache } from "../src/vault.js";

// In-memory stderr stub so we can assert on the warning lines without
// polluting the real test output.
function makeStderrSink(): Writable & { chunks: string[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      cb();
    },
  }) as Writable & { chunks: string[] };
  sink.chunks = chunks;
  return sink;
}

describe("runVaultPreflight — successful unseal", () => {
  beforeEach(() => {
    __resetVaultPreflightForTests();
    __resetKeyCache();
    // Force the env-var passphrase path: stub keytar to be unavailable so
    // we don't depend on the host machine's keychain state.
    vi.doMock("keytar", () => { throw new Error("unavailable"); });
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "preflight-test-pass";
    delete process.env.PERPLEXITY_MCP_STDIO;
  });
  afterEach(() => {
    vi.doUnmock("keytar");
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    delete process.env.PERPLEXITY_MCP_STDIO;
    __resetVaultPreflightForTests();
    __resetKeyCache();
  });

  it("emits no warning to stderr when env-var passphrase is set", async () => {
    const sink = makeStderrSink();
    await expect(runVaultPreflight(sink)).resolves.toBeUndefined();
    expect(sink.chunks.join("")).toBe("");
  });

  it("only probes once per server lifecycle", async () => {
    const sink = makeStderrSink();
    await runVaultPreflight(sink);
    // Second call must be a no-op even if state changes underneath.
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    __resetKeyCache();
    await runVaultPreflight(sink);
    expect(sink.chunks.join("")).toBe("");
  });
});

describe("runVaultPreflight — locked vault (Codex CLI scenario)", () => {
  beforeEach(() => {
    __resetVaultPreflightForTests();
    __resetKeyCache();
    // Reproduce the Linux Codex CLI symptom: no keychain, no env var, no TTY.
    vi.doMock("keytar", () => { throw new Error("unavailable"); });
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    process.env.PERPLEXITY_MCP_STDIO = "1";
  });
  afterEach(() => {
    vi.doUnmock("keytar");
    delete process.env.PERPLEXITY_MCP_STDIO;
    __resetVaultPreflightForTests();
    __resetKeyCache();
  });

  it("catches the locked-vault error and emits the structured stderr warning without throwing", async () => {
    const sink = makeStderrSink();
    await expect(runVaultPreflight(sink)).resolves.toBeUndefined();
    const out = sink.chunks.join("");
    expect(out).toMatch(/^\[perplexity-mcp\] WARN vault-locked: Vault locked/m);
    expect(out).toMatch(/Setup docs: docs\/codex-cli-setup\.md/);
    expect(out).toMatch(/perplexity_doctor.*will still work/);
    expect(out).toMatch(/perplexity_research.*perplexity_compute.*perplexity_reason.*will fail/);
  });

  it("emits the warning at most once per lifecycle", async () => {
    const sink = makeStderrSink();
    await runVaultPreflight(sink);
    const firstLength = sink.chunks.length;
    expect(firstLength).toBeGreaterThan(0);
    // Second call: gate prevents re-emission.
    await runVaultPreflight(sink);
    expect(sink.chunks.length).toBe(firstLength);
  });
});

describe("waitForStdioInputClose", () => {
  it("keeps the stdio server alive until stdin ends", async () => {
    const stdin = new PassThrough();
    let resolved = false;

    const waitPromise = waitForStdioInputClose(stdin).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    stdin.end();
    await waitPromise;

    expect(resolved).toBe(true);
  });
});

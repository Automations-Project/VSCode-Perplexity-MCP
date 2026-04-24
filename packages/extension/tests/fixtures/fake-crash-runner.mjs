#!/usr/bin/env node
// v0.8.6 test fixture: simulates login-runner's crash path, emitting the full
// diagnostics envelope { ok:false, reason:"crash", error, detail, stack } so
// tests can assert AuthManager preserves all four fields and logs them.
//
// Two roles:
//   FAKE_ROLE=crash_vault_locked → the Linux regression that motivated v0.8.6.
//   FAKE_ROLE=env_echo           → emits ok:true with the passphrase env var
//                                  it saw, so tests can assert it was passed.
const role = process.env.FAKE_ROLE ?? "crash_vault_locked";

if (role === "crash_vault_locked") {
  process.stdout.write(JSON.stringify({
    ok: false,
    reason: "crash",
    error: "Vault locked: no keychain, no env var, no TTY. Install OS keychain (libsecret on Linux) or set PERPLEXITY_VAULT_PASSPHRASE in your IDE's MCP config.",
    detail: "at getMasterKey (file:///ext/dist/mcp/server.mjs:12345:7)\nat Vault.set (file:///ext/dist/mcp/server.mjs:12400:9)",
    stack: "Error: Vault locked: no keychain, no env var, no TTY.\n    at getMasterKey (file:///ext/dist/mcp/server.mjs:12345:7)",
  }) + "\n");
  process.exit(5);
}

if (role === "crash_bigstack") {
  const bigStack = ("at frame\n".repeat(500));
  process.stdout.write(JSON.stringify({
    ok: false,
    reason: "crash",
    error: "Boom",
    detail: bigStack,
    stack: bigStack,
  }) + "\n");
  process.exit(5);
}

if (role === "env_echo") {
  const pass = process.env.PERPLEXITY_VAULT_PASSPHRASE ?? "";
  process.stdout.write(JSON.stringify({
    ok: true,
    tier: "Pro",
    sawPassphrase: pass,
    sawPassphraseLen: pass.length,
  }) + "\n");
  process.exit(0);
}

process.stdout.write(JSON.stringify({ ok: false, reason: "unknown_role" }) + "\n");
process.exit(1);

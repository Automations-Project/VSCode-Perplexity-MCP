# Vault Unsealing

> If you got here from a "Vault locked" error, jump to [Recovery](#recovery).

## Overview

The Perplexity MCP server stores authentication cookies encrypted at rest in `~/.perplexity-mcp/profiles/<name>/vault.enc`. To use the file, the server must unlock ("unseal") the encryption key. There are three unseal paths, tried in order:

1. **OS keychain** (preferred) — Windows Credential Manager, macOS Keychain, Linux libsecret/gnome-keyring. The server stores a 32-byte random key under service `perplexity-user-mcp`, account `vault-master-key`.
2. **Env var** — `PERPLEXITY_VAULT_PASSPHRASE` (fallback for headless Linux, sandboxed runtimes, or when the keychain is unavailable).
3. **TTY prompt** — interactive only (CLI use). Skipped when running as an stdio MCP server (no TTY).

The vault file is encrypted with AES-256-GCM. The KDF for passphrase-derived keys is scrypt (logN=17, r=8, p=1). Format details live in inline comments at the top of [`packages/mcp-server/src/vault.js`](../packages/mcp-server/src/vault.js).

## Standalone CLI vs. VS Code extension

- **Standalone `perplexity-user-mcp`** (npm package) uses the chain above directly. If you need to set a passphrase, run `npx perplexity-user-mcp setup-vault` — it generates a strong 256-bit base64url passphrase and prints per-platform persistence snippets.
- **VS Code extension** uses the same chain in its login runner, but ALSO stores a SecretStorage-backed passphrase if the keychain probe fails. Starting with **0.8.41**, the extension passes that passphrase to the long-running daemon at spawn time via a narrowly-scoped env builder, so external IDE clients (Claude Code, Antigravity, Codex CLI, Cursor) routed through the daemon don't need their own vault credentials.

## Per-platform notes

### Windows

Windows Credential Manager works out of the box for the extension's bundled `keytar` under VS Code's Electron runtime. If you see "Vault locked" in an external client's launcher (Claude Code on Node 24+, Antigravity, sandboxed Codex CLI), the issue is almost certainly that the launcher's runtime can't load `keytar` — but the **extension-managed daemon** still owns the credentials. Fix: ensure your extension is **0.8.41 or later**, then reload VS Code.

### macOS

Same as Windows — macOS Keychain works under the bundled keytar.

### Linux

Headless Linux has no libsecret by default. Two options:
1. Install libsecret + gnome-keyring (or kwallet) so keytar succeeds.
2. Set `PERPLEXITY_VAULT_PASSPHRASE` in your IDE's MCP env block. Run `npx perplexity-user-mcp setup-vault` for a strong generated passphrase + persistence snippet.

## Recovery

If you see one of these errors:

- `Vault decrypt failed: wrong passphrase or corrupted ciphertext`
- `Vault locked: no keychain, no env var, no TTY`

The vault was written under unseal material that is no longer available (rotated keychain key, changed `PERPLEXITY_VAULT_PASSPHRASE`, lost SecretStorage entry). There is **no recovery without the original material** — AES-256-GCM is authenticated and refuses to decrypt under the wrong key, by design.

Recovery flow:

1. Quarantine and discard the unreadable vault:
   ```bash
   npx perplexity-user-mcp logout --purge --profile <name>
   ```
   (replace `<name>` with your profile name; default is `default`)
2. Log in again from the VS Code dashboard, or:
   ```bash
   npx perplexity-user-mcp login --profile <name>
   ```
3. The new vault is written under whatever unseal material is currently available.

## Vault format versions

| Version | Status | KDF | Notes |
|---|---|---|---|
| v1 | legacy, decrypt-only | HKDF-SHA256 (static salt) | 0.6.x and earlier |
| v2 | legacy, decrypt-only | HKDF-SHA256 (per-blob salt) | 0.7.x |
| v3 | current | scrypt logN=17 | 0.8.x; per-blob salt + KDF params |

Reads never mutate the file. Writes always emit the latest supported version.

## Related

- [Troubleshooting external MCP clients](troubleshooting/external-mcp-clients.md) — Claude Code, Antigravity, Codex CLI specifics
- [Codex CLI setup](codex-cli-setup.md) — Codex CLI configuration walkthrough

# Codex CLI setup for Perplexity MCP

Operator guide for connecting [Codex CLI](https://github.com/openai/codex) to the Perplexity MCP server. Codex CLI reads MCP servers from `~/.codex/config.toml`. Two transports are supported: HTTP (recommended, routes through the extension daemon) and stdio (standalone Node launcher).

Motivation: a real-world Linux setup hit the locked-vault failure mode — Codex CLI's standalone Node launcher had no TTY, no libsecret/gnome-keyring, and no `PERPLEXITY_VAULT_PASSPHRASE`, so the encrypted profile vault could not be unsealed and Pro-tier tools failed even though the install was otherwise healthy. The structural fix that makes the HTTP transport the default for Codex CLI shipped in commit `895b04d` (`feat(auto-config): enable http-loopback for Codex CLI with TOML bearer env headers`).

---

## 1. TL;DR — recommended path

**Run "Perplexity: Configure for All" from the VS Code extension.** That command writes the HTTP-transport block into `~/.codex/config.toml`. Codex CLI then makes bearer-authenticated HTTP calls to the extension-managed daemon, which has SecretStorage access and unseals the vault on its own. **No keychain, passphrase, or TTY is needed in the Codex CLI subprocess.**

The block the extension writes for Codex CLI looks like this:

```toml
[mcp_servers.Perplexity]
url = "http://127.0.0.1:<port>/mcp"
bearer_token_env_var = "PERPLEXITY_MCP_BEARER"
enabled = true

[mcp_servers.Perplexity.env_http_headers]
PERPLEXITY_MCP_BEARER = "<rotating-bearer-from-extension>"
```

Notes:

- The env-var name is derived from the server name. For `Perplexity` the extension generates `PERPLEXITY_MCP_BEARER` (`<UPPER_SERVER_NAME>_MCP_BEARER` with non-alphanumerics collapsed to `_`).
- `<port>` and `<rotating-bearer-from-extension>` come from the daemon's `daemon.lock` and `daemon.token` files in `~/.perplexity-mcp/` (or `$PERPLEXITY_CONFIG_DIR`). Re-running "Configure for All" refreshes both if they change.
- Restart Codex CLI after running "Configure for All" so it picks up the new config.

---

## 2. Stdio transport — manual setup with one of three auth options

Use this when you cannot run the extension daemon — for example, Codex CLI on a headless server without VS Code installed. The stdio block:

```toml
[mcp_servers.Perplexity]
command = "/usr/bin/node"
args = ["/home/<user>/.perplexity-mcp/start.mjs"]
enabled = true

[mcp_servers.Perplexity.env]
PERPLEXITY_HEADLESS_ONLY = "1"
# pick one auth option below
```

Use `node` (without an absolute path) only if it is on the Codex CLI process's PATH. Do **not** point `command` at `Code.exe`, `Cursor.exe`, `Electron`, `windsurf-next`, or any other Electron host — those binaries spawn a UI process and the launcher will not run as a Node script.

Pick one of the following auth options.

### 2a. OS keychain (recommended for desktop Linux)

```bash
sudo apt install libsecret-1-0 gnome-keyring   # Debian/Ubuntu
sudo dnf install libsecret gnome-keyring        # Fedora
chmod 700 ~/.perplexity-mcp                     # tighten profile dir perms
```

Then run `perplexity_login` once via the extension or the standalone CLI to seed the keychain. Subsequent MCP-server starts unseal silently via the `tryKeytar` path.

### 2b. Passphrase env var (works without a keychain)

```toml
[mcp_servers.Perplexity.env]
PERPLEXITY_HEADLESS_ONLY = "1"
PERPLEXITY_VAULT_PASSPHRASE = "<your-passphrase>"
```

Security caveat: the passphrase is stored as plaintext in `~/.codex/config.toml`. Acceptable on a single-tenant machine when the file is `chmod 600`; not acceptable on a shared host or any system where other users can read your home directory.

### 2c. Use the HTTP transport instead

If you have the extension installed, prefer section 1 — the daemon owns the vault and Codex CLI sees only a bearer-authed HTTP endpoint.

---

## 3. Per-platform notes

### Linux

- libsecret + gnome-keyring may not be installed by default on server distros. Sections 2a and 2b cover both cases.
- The VS Code extension uses VS Code SecretStorage, which on Linux delegates to the same libsecret backend that the standalone CLI's `tryKeytar` path uses. If keychain works for the extension, it will work for the standalone launcher (after installing the libsecret packages in the Codex CLI environment).
- Doctor reports `Config dir is world/group readable (mode 0775)` when perms are loose — fix with `chmod 700 ~/.perplexity-mcp`.

### macOS

- Keychain Access is always available. Section 2a "just works" with `tryKeytar` after a one-time `perplexity_login`.

### Windows

- Credential Manager is always available. Same as macOS: section 2a works after a one-time `perplexity_login`.

---

## 4. Verifying the setup

After configuring, run these three checks:

1. From Codex CLI, list MCP servers and confirm `Perplexity` appears with `enabled = true`.
2. Invoke the `perplexity_doctor` tool from Codex CLI. The `vault` check must report `pass` and `unseal-path` must show which path resolved (`keychain`, env var, or passphrase).
3. Invoke `perplexity_search` with a simple query. If results come back with citations, the chain works end-to-end.

---

## 5. Troubleshooting

### `Vault locked: no keychain, no env var, no TTY`

The Codex CLI subprocess could not unseal the vault. Pick one of the auth options in section 2, or switch to the HTTP transport in section 1.

### `command path is wrong-runtime` (from doctor)

`command` in `~/.codex/config.toml` points at an Electron host (Code.exe, Cursor.exe, windsurf-next, etc.), not at a Node binary. Set `command = "node"` (or an absolute path to a Node binary) and re-run "Configure for All" in the extension.

### `Auth: Unsupported` shown by Codex CLI

Cosmetic. It means the MCP server does not advertise MCP-level OAuth to Codex CLI. Perplexity uses bearer auth on the HTTP transport, not OAuth, so this label is expected and does not indicate a setup error.

### Pro-tier features missing despite a Pro account

Re-login. The fix for ASI/computer-access tier inference shipped in commit `2d287c6` (`fix(login): infer Pro tier from ASI computer access`); older sessions may still be tagged as Free until the cookie is refreshed.

---

## 6. Reference — what each transport does

| Transport | Spawned by Codex CLI? | Vault unseal | Setup complexity |
|---|---|---|---|
| HTTP (recommended)         | No — uses extension daemon | Daemon handles it          | Low (one click in extension) |
| stdio + keychain (2a)      | Yes — Node subprocess      | `tryKeytar` (libsecret)    | Medium (install libsecret)   |
| stdio + passphrase (2b)    | Yes — Node subprocess      | env-var passphrase         | Low (but plaintext on disk)  |

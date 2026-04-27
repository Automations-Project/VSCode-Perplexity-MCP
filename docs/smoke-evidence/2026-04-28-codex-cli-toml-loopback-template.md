# Codex CLI TOML bearer-env http-loopback — smoke evidence (TEMPLATE)

> Status: **TEMPLATE — UNFILLED.** No checkbox below has been verified. Operator
> must edit this file in-place when actually running the smoke. Do NOT cite this
> file as evidence until at least one OS section is signed off.

## Why this addendum exists

The 2026-04-24 evidence doc (`2026-04-24-http-loopback-static-bearer.md`)
records the JSON-shaped `headers.Authorization: "Bearer <token>"` http-loopback
shape used by Cursor, Claude Desktop, Claude Code, Cline, Windsurf, Windsurf
Next, Amp, Roo Code, Continue.dev, and Zed. It does **not** cover Codex CLI:

- Codex CLI consumes `~/.codex/config.toml`, not `mcp.json`.
- Codex CLI does not accept a literal bearer in `[mcp_servers.<name>]`. Bearer
  must be referenced indirectly via `bearer_token_env_var` and the actual value
  set in `[mcp_servers.<name>.env_http_headers]`.
- The shape was added in commit `895b04d` (2026-04-26),
  *after* the 2026-04-24 doc was written — so referencing the older doc as
  evidence for `codexCli.httpBearerLoopback` is structurally wrong.

This template captures the per-OS smoke needed to back the Codex CLI claim.

## Front-matter

- **Date:** 2026-04-XX (operator fills)
- **Operator:** <name>
- **Platform:** <Linux distro / macOS version / Windows version>
- **Codex CLI version:** <version, e.g. output of `codex --version`>
- **Extension version:** <e.g. perplexity-vscode-0.8.10.vsix>
- **Daemon port:** <port from `~/.perplexity-mcp/daemon.lock`>

## Setup performed

1. Install the VSIX from a clean profile (or note the prior state).
2. Open VS Code with the extension installed at the version above.
3. Open the dashboard, enable the daemon, note the port and the active bearer.
4. From the command palette, run **"Perplexity: Configure for All"** (or the
   per-IDE action for `codexCli` from the IDEs tab with transport
   `http-loopback`).
5. Verify it writes `~/.codex/config.toml` (Windows: `%USERPROFILE%/.codex/config.toml`)
   with the HTTP-transport TOML shape shown below.
6. Restart Codex CLI; verify `Perplexity` appears in its MCP server list with
   `enabled = true` and reports as authenticated (no `Auth: Unsupported` for
   the loopback bearer path — that warning is a known cosmetic display for the
   stdio launcher and is documented in `linux/perplexity-codex-mcp-setup-issue.md`).
7. List MCP tools — confirm `perplexity_search`, `perplexity_doctor`,
   `perplexity_models`, `perplexity_research`, `perplexity_compute` appear.

## Expected TOML on disk

The auto-config writer (`buildTomlMcpBlock` in
`packages/extension/src/auto-config/index.ts`) emits the following exact shape
when given an `http-loopback` server config (an object with a `url` key and
`headers.Authorization = "Bearer <token>"`). The env var name is derived as
`<SERVERNAME>_MCP_BEARER` with non-alphanumerics collapsed to `_`. For server
name `Perplexity` this yields `PERPLEXITY_MCP_BEARER`.

```toml
[mcp_servers.Perplexity]
url = "http://127.0.0.1:<daemon-port>/mcp"
bearer_token_env_var = "PERPLEXITY_MCP_BEARER"
enabled = true

[mcp_servers.Perplexity.env_http_headers]
PERPLEXITY_MCP_BEARER = "<daemon-static-bearer>"
```

Notes:
- No `command`/`args` keys appear when `url` is set — that branch is exclusive.
- No `[mcp_servers.Perplexity.env]` block is written for the loopback transport.
  (`env` is reserved for the stdio-launcher transport, where things like
  `PERPLEXITY_HEADLESS_ONLY` belong.)
- The bearer is a literal value in `env_http_headers`. Codex CLI reads it at
  spawn time; rotating the bearer requires the file to be re-written and Codex
  to re-spawn the MCP child (see "Bearer rotation check" below).

Operator: paste the actual TOML written on disk here for the run, and confirm
it matches the shape above.

```toml
<paste actual ~/.codex/config.toml [mcp_servers.Perplexity] block here>
```

## Smoke checks — Linux (Ubuntu 22.04 / Fedora 40 / Arch — pick one)

Distro tested: <fill>

- [ ] `~/.codex/config.toml` contains the exact `[mcp_servers.Perplexity]` shape above
- [ ] Codex CLI lists Perplexity MCP server as `enabled`
- [ ] `perplexity_doctor` returns OK; `vault` check `pass`
- [ ] `perplexity_search` returns results with citations
- [ ] `perplexity_models` returns the right tier (Pro/Max)
- [ ] `perplexity_research` with a simple prompt returns a research result
- [ ] `perplexity_compute` with a file-producing prompt; verify file appears in `~/.perplexity-mcp/downloads/<slug>/`

### Bearer rotation check (Linux)

- [ ] After running the extension command "Rotate bearer", confirm the
      `env_http_headers` block in `~/.codex/config.toml` updates AND Codex CLI's
      next call still authenticates without manual restart of Codex itself
      (or, document the restart requirement here if one is needed).

### Sign-off (Linux)

- [ ] All boxes above are checked (no extrapolation)
- Operator signature: <name> <date>

## Smoke checks — macOS 14+

- [ ] `~/.codex/config.toml` contains the exact `[mcp_servers.Perplexity]` shape above
- [ ] Codex CLI lists Perplexity MCP server as `enabled`
- [ ] `perplexity_doctor` returns OK; `vault` check `pass`
- [ ] `perplexity_search` returns results with citations
- [ ] `perplexity_models` returns the right tier (Pro/Max)
- [ ] `perplexity_research` with a simple prompt returns a research result
- [ ] `perplexity_compute` with a file-producing prompt; verify file appears in `~/.perplexity-mcp/downloads/<slug>/`

### Bearer rotation check (macOS)

- [ ] After "Rotate bearer", `env_http_headers` updates AND Codex's next call still authenticates

### Sign-off (macOS)

- [ ] All boxes above are checked (no extrapolation)
- Operator signature: <name> <date>

## Smoke checks — Windows 11

- [ ] `%USERPROFILE%/.codex/config.toml` contains the exact `[mcp_servers.Perplexity]` shape above
- [ ] Codex CLI lists Perplexity MCP server as `enabled`
- [ ] `perplexity_doctor` returns OK; `vault` check `pass`
- [ ] `perplexity_search` returns results with citations
- [ ] `perplexity_models` returns the right tier (Pro/Max)
- [ ] `perplexity_research` with a simple prompt returns a research result
- [ ] `perplexity_compute` with a file-producing prompt; verify file appears in `%USERPROFILE%/.perplexity-mcp/downloads/<slug>/`

### Bearer rotation check (Windows)

- [ ] After "Rotate bearer", `env_http_headers` updates AND Codex's next call still authenticates

### Sign-off (Windows)

- [ ] All boxes above are checked (no extrapolation)
- Operator signature: <name> <date>

## What was NOT tested by this addendum

- The stdio-launcher transport for Codex CLI (the `command`/`args` shape with
  `[mcp_servers.Perplexity.env]`) — that is the Linux setup-issue subject of
  `linux/perplexity-codex-mcp-setup-issue.md` and needs its own evidence doc
  if/when the headless-vault path is signed off.
- `httpOAuthLoopback` for Codex CLI — not yet wired in `IDE_METADATA`.
- `httpOAuthTunnel` for Codex CLI — not yet wired in `IDE_METADATA`.

## Replay (operator quick-reference)

1. Install the VSIX.
2. Dashboard → enable daemon → note port.
3. IDEs tab → Codex CLI → transport `http-loopback` → Generate.
4. Inspect `~/.codex/config.toml` → confirm shape matches "Expected TOML on disk".
5. Restart Codex CLI → list MCP tools → run smoke checks above.
6. Rotate bearer from the dashboard → confirm config updates → re-run a tool call.

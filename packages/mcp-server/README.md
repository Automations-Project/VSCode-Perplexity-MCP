# perplexity-user-mcp

Perplexity AI MCP server. Runs a persistent Chromium session via [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) to serve MCP tools for search, reasoning, research, and Computer mode from your existing Perplexity account.

Also available as the bundled MCP inside the [Perplexity Internal VS Code extension](https://github.com/Automations-Project/VSCode-Perplexity-MCP); this package is the same server, runnable standalone.

## Install

```bash
npm install -g perplexity-user-mcp
```

or run on demand with `npx`:

```bash
npx perplexity-user-mcp
```

The server speaks MCP over stdio, so normally you point your MCP client (Claude Desktop, Cursor, Windsurf, Cline, Claude Code, Amp, Codex CLI) at the binary rather than invoking it directly.

## First run & login

Login is interactive — Perplexity emails a one-time code that you have to paste back into the prompt. The MCP `perplexity_login` tool only returns instructions, because MCP tool calls cannot display interactive prompts. You log in either through the CLI or, if you have the VS Code extension, through its dashboard.

Quick start from a fresh machine:

```bash
npm install -g perplexity-user-mcp
npx perplexity-user-mcp install-speed-boost     # optional, strongly recommended
npx perplexity-user-mcp login --mode auto --email me@example.com
# terminal will prompt for the OTP from your email
```

`--mode auto` runs the email + OTP flow over HTTP (impit-backed if Speed Boost is installed; otherwise driven through the browser). `--mode manual` opens a visible browser window so you can sign in with Google, GitHub, or Apple SSO.

Session state lives at `~/.perplexity-mcp/` (cookies, profile, models cache). Delete that directory to start over, or use `npx perplexity-user-mcp logout --purge`.

Programmatic library use is supported but logging in still happens via the CLI command — the library exposes the runner spawn helpers but does not provide an interactive prompt.

## Speed Boost (impit)

Speed Boost is an optional Rust-backed HTTP client (`impit`) that lets the server skip the browser for the tools that only need a cookie jar. Once installed it is auto-detected and used transparently — there is no env var to flip on.

Tools that benefit from Speed Boost:

- `perplexity_sync_cloud`
- `perplexity_hydrate_cloud_entry`
- `perplexity_retrieve`
- `perplexity_login` (auto-used when installed; opt out with `PERPLEXITY_DISABLE_IMPIT_LOGIN=1` or `--no-impit` on `login`)
- `perplexity_export`
- `perplexity_models`

Tools that still use the browser: `perplexity_search`, `perplexity_reason`, `perplexity_research`, `perplexity_compute`, `perplexity_ask`. (Search-via-impit is an opt-in pilot.)

Install:

```bash
npx perplexity-user-mcp install-speed-boost
```

Uninstall:

```bash
npx perplexity-user-mcp uninstall-speed-boost
```

There is no opt-out for the cloud-sync / hydrate / retrieve / export / models impit paths — every one of them falls back to the browser automatically on any impit failure (Cloudflare challenge, network error, parse error, etc.). The opt-out env vars only apply to login.

Speed Boost lives at `~/.perplexity-mcp/native-deps/node_modules/impit/`. You can remove it with the uninstall command above or with `rm -rf ~/.perplexity-mcp/native-deps/`.

## Browser requirement

The server automates a real browser to reach Perplexity (Cloudflare-protected). Any of these work out of the box, probed in the order listed:

1. **Google Chrome** *(recommended — best Cloudflare compatibility)*
2. **Microsoft Edge** (all three platforms)
3. **System Chromium** (mainly Linux)
4. **Brave Browser** (Chromium-based — works unchanged)
5. **Patchright's bundled Chromium**, downloaded with:

   ```bash
   npx patchright install chromium
   ```

If none of those are installed the server exits at startup with instructions.

### Picking a specific browser

All overrides are optional and evaluated at call time:

| Variable | Effect |
|---|---|
| `PERPLEXITY_BROWSER_PATH` | Absolute path to an executable. Takes precedence over auto-detection. |
| `PERPLEXITY_BROWSER_CHANNEL` | `chrome` \| `msedge` \| `chromium`. Controls which Patchright channel is used. |
| `PERPLEXITY_CHROME_PATH` | Legacy alias for `PERPLEXITY_BROWSER_PATH`. Still honored. |

## CLI commands

Most-used commands. Run `npx perplexity-user-mcp --help` for the full list (daemon, tunnel providers, etc.).

```bash
npx perplexity-user-mcp                                  # start MCP stdio server
npx perplexity-user-mcp login [--profile X] [--mode auto|manual] [--plain-cookies]
npx perplexity-user-mcp logout [--profile X] [--purge]
npx perplexity-user-mcp status [--profile X] [--all]
npx perplexity-user-mcp doctor [--profile X] [--probe] [--all] [--report]
npx perplexity-user-mcp install-browser
npx perplexity-user-mcp install-speed-boost
npx perplexity-user-mcp uninstall-speed-boost
npx perplexity-user-mcp add-account [--name X] [--email Y] [--mode auto|manual] [--plain-cookies]
npx perplexity-user-mcp switch-account <name>
npx perplexity-user-mcp list-accounts
npx perplexity-user-mcp export <id> --format pdf|md|docx [--out path]
npx perplexity-user-mcp open <id> [--viewer obsidian|typora|logseq|system]
npx perplexity-user-mcp rebuild-history-index [--profile X]
npx perplexity-user-mcp sync-cloud [--profile X] [--page-size N] [--verbose]
npx perplexity-user-mcp daemon start [--port N] [--tunnel]
npx perplexity-user-mcp --version
```

## MCP client configuration

Example `mcp.json` entry (Cursor, Windsurf, Claude Code format):

```json
{
  "mcpServers": {
    "perplexity": {
      "command": "npx",
      "args": ["-y", "perplexity-user-mcp"]
    }
  }
}
```

Claude Desktop (`claude_desktop_config.json`) uses the same shape.

## Environment variables

| Variable | Purpose |
|---|---|
| `PERPLEXITY_CONFIG_DIR` | Override `~/.perplexity-mcp` config/profile location. |
| `PERPLEXITY_BROWSER_PATH` | Explicit browser executable path (skips auto-detection). |
| `PERPLEXITY_BROWSER_CHANNEL` | `chrome` / `msedge` / `chromium`. Channel passed to Patchright. |
| `PERPLEXITY_CHROME_PATH` | **Legacy** alias for `PERPLEXITY_BROWSER_PATH`. Still honored. |
| `PERPLEXITY_HEADLESS_ONLY` | `1` to skip the headed Turnstile bootstrap and rely on cached `cf_clearance`. Useful on servers; fails if no clearance is cached yet. |
| `PERPLEXITY_SESSION_TOKEN` | Pre-supplied `__Secure-next-auth.session-token` (skips interactive login). |
| `PERPLEXITY_CSRF_TOKEN` | Optional companion to `PERPLEXITY_SESSION_TOKEN`. |
| `PERPLEXITY_DISABLE_IMPIT_LOGIN` | `1` to force browser-driven login even when Speed Boost is installed. |
| `PERPLEXITY_VAULT_PASSPHRASE` | Env-var master-key fallback for headless Linux (no keychain). |

## Tools exposed over MCP

- `perplexity_search` — fast web search with citations
- `perplexity_reason` — step-by-step reasoning (Pro tier)
- `perplexity_research` — deep multi-section reports (Pro tier)
- `perplexity_ask` — flexible queries with explicit model/mode/follow-up control
- `perplexity_compute` — Computer mode / ASI (requires Computer-mode access — typically Max)
- `perplexity_models` — list models, account tier, rate limits
- `perplexity_retrieve` — poll a pending research/compute task
- `perplexity_export` — export a saved history entry as PDF, Markdown, or DOCX (uses Perplexity's native export endpoint with a local Markdown fallback)
- `perplexity_sync_cloud` — sync Perplexity cloud thread history into the local history store
- `perplexity_hydrate_cloud_entry` — hydrate a single cloud-backed history entry on demand
- `perplexity_list_researches` / `perplexity_get_research` — saved research history
- `perplexity_login` — returns login instructions (interactive login runs via the CLI / extension)
- `perplexity_doctor` — run diagnostic checks across browser, profile, auth, and network and return a Markdown report (pass `probe:true` for a live search probe)

## Library use

Subpath exports are published for embedding the same runtime inside other Node tooling:

```ts
import { PerplexityClient } from "perplexity-user-mcp/client";
import { CONFIG_DIR, BROWSER_DATA_DIR } from "perplexity-user-mcp/config";
import { readHistory } from "perplexity-user-mcp";
```

Logging in still goes through the CLI (`npx perplexity-user-mcp login`) — the library does not expose an interactive prompt.

## Requirements

- Node.js >= 20
- A browser runtime — any of: real Chrome, Microsoft Edge, Brave, system Chromium, or patchright's bundled Chromium (see the [Browser requirement](#browser-requirement) section)
- An active Perplexity account (free tier works; Pro/Max unlock reason/research/compute)

## Issues

Bug reports and feature requests: <https://github.com/Automations-Project/VSCode-Perplexity-MCP/issues>.

## License

MIT — see [LICENSE](../../LICENSE).

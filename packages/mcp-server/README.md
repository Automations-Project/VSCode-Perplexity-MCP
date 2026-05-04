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

The server speaks MCP over stdio, so normally you point your MCP client (Claude Desktop, Cursor, Windsurf, Cline, Claude Code, Amp, Codex CLI, VS Code MCP, Visual Studio 2022, OpenCode, GitHub Copilot CLI, Factory Droid, Qwen Code, Gemini CLI, Kiro, Firebase Studio, …) at the binary rather than invoking it directly.

## First run & login

Login is interactive — Perplexity emails a one-time code that you have to paste back into the prompt. The MCP `perplexity_login` tool only returns instructions, because MCP tool calls cannot display interactive prompts. You log in either through the CLI or, if you have the VS Code extension, through its dashboard.

Pick the row that matches your environment for a copy-pasteable quick start. Everything below assumes the package is installed (`npm install -g perplexity-user-mcp`).

| Environment | Quick start |
|---|---|
| **A. Desktop + VS Code extension** | Install [the extension](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode), open the dashboard, click **Login**. The extension owns the browser, vault, and OTP prompt — no terminal needed. |
| **B. Desktop, standalone CLI (Win / Mac / Linux with display)** | `npx perplexity-user-mcp login --mode manual` — opens a visible browser, sign in with email / Google / GitHub / Apple SSO, runner persists cookies and exits. |
| **C. Desktop, standalone CLI, prefer terminal-only** | `npx perplexity-user-mcp install-speed-boost && npx perplexity-user-mcp login --mode auto --email me@example.com` — OTP prompt appears on stderr, paste the six-digit code from your email. |
| **D. Headless VPS, can receive your email** | First run `npx perplexity-user-mcp setup-vault` — if the box has no OS keychain (libsecret missing on Linux servers) it generates a passphrase and prints persistence snippets (PowerShell / setx / zsh / bash / systemd / MCP-client env block). Then same as **C**. Speed Boost (impit) does the email/OTP flow over HTTP with no browser. Falls back to a browser runner only on `cf_blocked`, which fails on a true headless box — see pattern **E** if that happens. |
| **E. Headless VPS, can't run a browser** | Log in on a desktop machine, then either set `PERPLEXITY_SESSION_TOKEN` from the cookie value on the VPS, **or** copy the vault. See [Headless / VPS deployment](#headless--vps-deployment) below. |
| **F. Headless VPS + a desktop you control** | Run `npx perplexity-user-mcp daemon start --tunnel` on the desktop; point the VPS's MCP client at the printed Cloudflare URL with the bearer token. The desktop owns the browser; the VPS only sees a bearer-authed HTTP MCP endpoint. |

Common verifications after any path:

```bash
npx perplexity-user-mcp status                   # expect: valid, with a tier (Pro / Max / Enterprise / Authenticated)
npx perplexity-user-mcp doctor                   # green across the board, especially profiles + vault
```

What success vs failure looks like on the CLI:

- `login finished (0)` and `status` reports `valid` → you're done.
- Non-zero exit code from `login` is a failure even if the CLI prints a "finished" line. The runner emits a JSON line on stdout with the actual `reason`: `cf_blocked`, `chrome_missing`, `otp_rejected`, `crash`, `timeout`. Read stderr for the full message — that's where the structured error surfaces.

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
npx perplexity-user-mcp                                  # start MCP stdio server (no output until a client connects)
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

> **Note** — `npx perplexity-user-mcp` with no subcommand starts the stdio MCP server and waits silently for JSON-RPC on stdin. There's no progress output; if you typed it expecting a login or status prompt, that's why "nothing happened." Use the explicit subcommand (`login`, `status`, etc.) for interactive operation.

## Multiple accounts / profiles

Each Perplexity account lives in its own profile under `~/.perplexity-mcp/profiles/<name>/`. The active profile is the one tools read cookies from. Naming them after the plan tier (`pro`, `max`, `personal`, `work`) keeps things obvious.

```bash
npx perplexity-user-mcp add-account --name pro --mode auto --email pro-account@example.com
# ...follow the OTP prompt, persist cookies under profiles/pro/

npx perplexity-user-mcp add-account --name personal --mode manual
# opens a browser, persist under profiles/personal/

npx perplexity-user-mcp list-accounts
# * pro       [Pro]   mode=auto    lastLogin=2026-05-04...
#   personal  [Free]  mode=manual  lastLogin=2026-05-04...

npx perplexity-user-mcp switch-account personal       # switch active profile
npx perplexity-user-mcp status                        # confirm "valid" for the new active profile
```

The MCP server picks up the active profile change immediately — version 0.8.40+ watches the active-pointer file and reloads cookies on switch, so you don't need to restart the server (or your IDE) when toggling between accounts. Pre-0.8.40 you'd see the old profile's data until the daemon was restarted.

If you set `PERPLEXITY_PROFILE=<name>` in an MCP client's env block, that pins the server to that one profile regardless of `switch-account` — useful when you want one IDE on `pro` and another on `personal` simultaneously.

## Headless / VPS deployment

`login --mode manual` and the browser fallback for `--mode auto` both launch a real Chromium and need a graphical session. On a true headless box (no X server, no DISPLAY, no Wayland) those paths fail at browser launch with a `chrome_missing` or `crash` reason. Three workable patterns:

**1. Terminal-only login (preferred when impit succeeds).** Try this first — it's the simplest and works on most VPS boxes if Cloudflare doesn't gate the email endpoint:

```bash
npx perplexity-user-mcp install-speed-boost      # required: provides the impit HTTP runner
npx perplexity-user-mcp login --mode auto --email me@example.com
# server emails the OTP; paste the six-digit code at the prompt on stderr
```

If this fails with `cf_blocked`, fall back to one of the other patterns. (impit is opt-in; without it the auto runner falls back to the browser, which won't work headless.)

**2. Pre-supplied session token.** Log in on a desktop machine via any browser, extract the `__Secure-next-auth.session-token` cookie value, and feed it to the headless server:

```bash
PERPLEXITY_SESSION_TOKEN=<long-jwt-from-the-cookie> \
PERPLEXITY_CSRF_TOKEN=<optional-companion-cookie> \
  npx perplexity-user-mcp                        # stdio server bypasses login entirely
```

The cookie expires when Perplexity rotates it (typically ~30 days); refresh by re-extracting from the desktop browser. This path is acceptable for personal-use VPS boxes where the env block is `chmod 600`; do not use on shared hosts.

**3. Daemon + tunnel from a desktop.** Run the daemon on a desktop machine you control, expose it via Cloudflare Quick Tunnels (built-in) or ngrok, and point your headless clients at the tunnel URL:

```bash
# on the desktop:
npx perplexity-user-mcp daemon start --tunnel
# prints: tunnel URL https://<random>.trycloudflare.com  bearer <token>
# on the VPS, point your MCP client at the tunnel URL with the bearer in Authorization
```

The desktop owns the browser session and the vault; the VPS only sees a bearer-authed HTTP MCP endpoint. See [the Codex CLI setup guide](https://github.com/Automations-Project/VSCode-Perplexity-MCP/blob/main/docs/codex-cli-setup.md) for an end-to-end walkthrough using the same daemon + tunnel pattern.

**Why not just `login --mode manual` on the VPS?** It launches a headed Chromium that needs `$DISPLAY`. On a server distro you'd see `Failed to launch browser process` and the runner exits with `crash`. A virtual framebuffer (`xvfb-run`) would technically work but the email/OTP step still requires a way to interact with the email — pattern 1 covers that without the X11 dependency.

## MCP client configuration

Example `mcp.json` entry (Cursor, Windsurf, Claude Code, Cline, Amp, Kiro, Firebase Studio, Antigravity, Gemini CLI, Factory Droid, Qwen Code, Copilot CLI — `mcpServers` root key):

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

**VS Code MCP / Visual Studio 2022** use the `servers` root key with a `type` discriminator:

```json
{
  "servers": {
    "perplexity": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "perplexity-user-mcp"]
    }
  }
}
```

Workspace paths: `.vscode/mcp.json` (VS Code), `<sln>/.mcp.json` or `%USERPROFILE%\.mcp.json` (Visual Studio 2022).

**OpenCode** uses the `mcp` root key with a local-server entry shape:

```json
{
  "mcp": {
    "perplexity": {
      "type": "local",
      "command": ["npx", "-y", "perplexity-user-mcp"],
      "enabled": true
    }
  }
}
```

Path: `~/.config/opencode/opencode.json`.

**Zed** uses the `context_servers` root key. **Codex CLI** uses TOML at `~/.codex/config.toml`.

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

## Search sources and advanced queries

Search-style tools support Perplexity source focus through a `sources` argument:

- `web` — general web search. This is the default.
- `scholar` — scholarly / academic source focus.
- `social` — social discussion source focus.

The source selector is explicit. If `sources` is omitted, the server sends `["web"]`.

Examples:

```json
{
  "tool": "perplexity_search",
  "arguments": {
    "query": "recent papers on retrieval augmented generation evaluation",
    "sources": ["scholar"],
    "language": "en-US"
  }
}
```

```json
{
  "tool": "perplexity_ask",
  "arguments": {
    "query": "What are practitioners saying about Cursor versus Windsurf for large TypeScript repos?",
    "sources": ["social"],
    "mode": "copilot"
  }
}
```

```json
{
  "tool": "perplexity_research",
  "arguments": {
    "query": "Compare academic evidence and practitioner discussion around code review automation",
    "sources": ["scholar", "social"],
    "language": "en-US"
  }
}
```

Natural-language prompts usually work too when they name the desired source mode:

- "Use Perplexity scholar sources for recent papers on agentic search evaluation."
- "Search social sources for developer reports about Claude Code memory issues."
- "Run deep research using both scholar and web sources, and cite every claim."
- "Use `perplexity_ask` with `sources: [\"social\"]` and keep the answer concise."

Useful shorthand:

- "search ..." usually maps to `perplexity_search` for quick lookup and source discovery.
- "ask Perplexity ..." usually maps to `perplexity_ask` for a synthesized answer with citations.
- "reason through ..." usually maps to `perplexity_reason` for multi-step analysis.
- "research deeply ..." usually maps to `perplexity_research` for longer reports.
- "use ASI", "Computer mode", "run a compute task", or "do code/execution-style analysis" maps to `perplexity_compute` when the account has Computer-mode access.

For ASI / Computer mode, ask for `perplexity_compute` by name when precision matters:

```json
{
  "tool": "perplexity_compute",
  "arguments": {
    "query": "Model the true cost of a 5 kW residential solar installation in the Philippines versus investing the same cash at 6% annually over 10 and 20 years. Show assumptions, calculations, and sensitivity cases.",
    "language": "en-US"
  }
}
```

### Defaults

| Tool | Model default | Mode default | Sources default | Language default |
|---|---|---|---|---|
| `perplexity_search` | Authenticated: `pplx_pro`; anonymous: `turbo` | Authenticated: `copilot`; anonymous: `concise` | `["web"]` | `en-US` |
| `perplexity_ask` | `PERPLEXITY_SEARCH_MODEL` or `pplx_pro` | `copilot` | `["web"]` | `en-US` |
| `perplexity_reason` | `PERPLEXITY_REASON_MODEL` or `claude46sonnetthinking` | `copilot` | `["web"]` | `en-US` |
| `perplexity_research` | `PERPLEXITY_RESEARCH_MODEL` or `pplx_alpha` | `copilot` | `["web"]` | `en-US` |
| `perplexity_compute` | Tool argument, then `PERPLEXITY_COMPUTE_MODEL`, then account ASI default, then `pplx_asi` | `asi` | web-only Computer mode | `en-US` |

Model defaults are configurable with `PERPLEXITY_SEARCH_MODEL`, `PERPLEXITY_REASON_MODEL`, `PERPLEXITY_RESEARCH_MODEL`, and `PERPLEXITY_COMPUTE_MODEL`. `perplexity_ask`, `perplexity_reason`, and `perplexity_compute` also accept a per-call `model` argument. `perplexity_ask` accepts `mode: "concise" | "copilot"`.

Under the hood, search-style tools post a Perplexity web-app style request from the logged-in browser session to `https://www.perplexity.ai/rest/sse/perplexity_ask`. The response is a Server-Sent Events stream, which the MCP runtime parses into answer text, citation sources, media items, suggested follow-ups, follow-up context, and the Perplexity thread URL.

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

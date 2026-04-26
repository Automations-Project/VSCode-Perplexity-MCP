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

## First run & login

Perplexity serves a Cloudflare Turnstile challenge that cannot be solved headlessly. On first run you log in through a visible browser window that the server opens for you; after that a `cf_clearance` cookie is persisted and subsequent runs are headless.

Via the CLI directly (library form):

```ts
import { PerplexityClient } from "perplexity-user-mcp/client";

const client = new PerplexityClient();
await client.loginViaBrowser(); // opens a visible window; waits up to 3 min
```

Via the VS Code extension: use the **Perplexity: Login** command.

Session state lives at `~/.perplexity-mcp/` (cookies, profile, models cache). Delete that directory to start over.

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

## Tools exposed over MCP

- `perplexity_search` — fast web search with citations
- `perplexity_reason` — step-by-step reasoning (Pro tier)
- `perplexity_research` — deep multi-section reports (Pro tier)
- `perplexity_ask` — flexible queries with explicit model/mode/follow-up control
- `perplexity_compute` — Computer mode / ASI (Max tier)
- `perplexity_models` — list models, account tier, rate limits
- `perplexity_retrieve` — poll a pending research/compute task
- `perplexity_list_researches` / `perplexity_get_research` — saved research history
- `perplexity_login` — open a browser for Perplexity authentication

## Library use

Subpath exports are published for embedding the same runtime inside other Node tooling:

```ts
import { PerplexityClient } from "perplexity-user-mcp/client";
import { CONFIG_DIR, BROWSER_DATA_DIR } from "perplexity-user-mcp/config";
import { readHistory } from "perplexity-user-mcp";
```

## Requirements

- Node.js >= 20
- A browser runtime — any of: real Chrome, Microsoft Edge, Brave, system Chromium, or patchright's bundled Chromium (see the [Browser requirement](#browser-requirement) section)
- An active Perplexity account (free tier works; Pro/Max unlock reason/research/compute)

## License

UNLICENSED — private project.

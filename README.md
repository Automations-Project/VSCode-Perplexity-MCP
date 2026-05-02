<div align="center">

<p align="center">
  <img alt="Perplexity MCP" src="./packages/extension/media/icon.png" height="120">
</p>

# Perplexity MCP for 15+ IDEs

**Long‑lived Perplexity browser session, auto‑config for 15+ IDEs, and a VS Code extension – all in one monorepo.**

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode"><img src="https://vsmarketplacebadges.dev/version-short/Nskha.perplexity-vscode.svg?style=for-the-badge&label=VS%20Code&colorB=007ACC" alt="VS Code version" /></a>
  <a href="https://www.npmjs.com/package/perplexity-user-mcp"><img src="https://img.shields.io/npm/v/perplexity-user-mcp?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=CB3837" alt="npm version" /></a>
  <a href="https://registry.modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP%20Registry-Listed-1D4ED8?style=for-the-badge" alt="MCP Registry listing" /></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode"><img src="https://vsmarketplacebadges.dev/installs-short/Nskha.perplexity-vscode.svg?style=for-the-badge&label=VS%20Code%20Installs&colorB=1E8CBE" alt="VS Code installs" /></a>
  <a href="https://www.npmjs.com/package/perplexity-user-mcp"><img src="https://img.shields.io/npm/dw/perplexity-user-mcp?style=for-the-badge&logo=npm&logoColor=white&label=npm%20Downloads%2FWeek&color=F43F5E" alt="npm downloads per week" /></a>
  <a href="https://github.com/Automations-Project/VSCode-Perplexity-MCP/stargazers"><img src="https://img.shields.io/github/stars/Automations-Project/VSCode-Perplexity-MCP?style=for-the-badge&logo=github&logoColor=white&label=GitHub%20Stars&color=FBBF24" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="https://github.com/Automations-Project/VSCode-Perplexity-MCP/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Automations-Project/VSCode-Perplexity-MCP/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI" alt="CI status" /></a>
  <a href="https://github.com/Automations-Project/VSCode-Perplexity-MCP/releases/latest"><img src="https://img.shields.io/github/v/release/Automations-Project/VSCode-Perplexity-MCP?style=for-the-badge&logo=github&logoColor=white&label=Latest%20Release&color=10B981" alt="Latest release" /></a>
  <a href="https://github.com/Automations-Project/VSCode-Perplexity-MCP/commits/main"><img src="https://img.shields.io/github/last-commit/Automations-Project/VSCode-Perplexity-MCP?style=for-the-badge&logo=github&logoColor=white&label=Last%20Commit&color=6366F1" alt="Last commit" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Automations-Project/VSCode-Perplexity-MCP?style=for-the-badge&logo=opensourceinitiative&logoColor=white&label=License&color=22C55E" alt="License" /></a>
</p>

<br />

> **Not affiliated with Perplexity AI, Inc.** This is a community-maintained project.
>
> **Experimental** — This project is under active development and not intended for production use. APIs, tools, and behavior may change without notice.

</div>

---

## Install the Extension

<div align="center">

| IDE | Install |
|:---:|:--------|
| <img src="./mcp-tool-icons/vscode.svg" height="20" valign="middle" alt="VS Code" /> **Visual Studio Code** | [![Install in VS Code](https://img.shields.io/badge/Install-VS%20Code-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="./mcp-tool-icons/vscode.svg" height="20" valign="middle" alt="VS Code Insiders" /> **VS Code Insiders** | [![Install in VS Code Insiders](https://img.shields.io/badge/Install-VS%20Code%20Insiders-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="./mcp-tool-icons/cursor.svg" height="20" valign="middle" alt="Cursor" /> **Cursor** | [![Install in Cursor](https://img.shields.io/badge/Install-Cursor-000000?style=flat-square&logo=cursor&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="./mcp-tool-icons/windsurf.svg" height="20" valign="middle" alt="Windsurf" /> **Windsurf** | [![Install in Windsurf](https://img.shields.io/badge/Install-Windsurf-0E6EFD?style=flat-square&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="./mcp-tool-icons/trae.svg" height="20" valign="middle" alt="Trae" /> **Trae** | [![Install in Trae](https://img.shields.io/badge/Install-Trae-FF6B35?style=flat-square&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="./mcp-tool-icons/vscode.svg" height="20" valign="middle" alt="Open VSX" /> **Open VSX** (Gitpod · Theia · Coder) | [![Install on Open VSX](https://img.shields.io/badge/Install-Open%20VSX-C160EF?style=flat-square&logoColor=white)](https://open-vsx.org/extension/Nskha/perplexity-vscode) |

</div>

---

## TL;DR – what lives here?

A monorepo that ships the Perplexity MCP runtime two ways:

- **`perplexity-vscode`** – native VS Code extension with an embedded MCP daemon, webview dashboard, and auto‑config for 15+ MCP‑capable IDEs.[^ver]
- **`perplexity-user-mcp`** – the same MCP server as a standalone npm package for Cursor, Claude Desktop, Claude Code, Windsurf, Cline, Amp, Codex CLI, and any other MCP client that talks stdio.

Both wrap a long‑lived **patchright** browser session against your existing Perplexity account, so the tools consume your logged‑in plan (Free / Pro / Max) instead of an API key.[^runtime]

[^ver]: See [CHANGELOG.md](./CHANGELOG.md) for current version and release notes.
[^runtime]: Browser and profile details: [packages/mcp-server](./packages/mcp-server/) and [Architecture notes](#architecture-notes).

---

## Who should use what?

<table>
  <thead>
    <tr>
      <th align="left">You want to…</th>
      <th align="left">Use</th>
      <th align="left">How</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Use Perplexity inside VS Code with a dashboard, login flows, and auto‑config for other IDEs.</td>
      <td><strong><code>perplexity-vscode</code></strong> (extension)</td>
      <td>Install the VSIX or from Marketplace, run <code>Perplexity: Login</code>, optionally enable auto‑config.</td>
    </tr>
    <tr>
      <td>Run the MCP server standalone for Cursor / Claude Desktop / Windsurf / Cline / Amp / Codex CLI.</td>
      <td><strong><code>perplexity-user-mcp</code></strong> (npm CLI)</td>
      <td><code>npm install -g perplexity-user-mcp</code> or <code>npx perplexity-user-mcp</code>, point your MCP client at it.</td>
    </tr>
    <tr>
      <td>Keep a long‑lived HTTP MCP daemon with tunnels (Cloudflare Quick Tunnels / ngrok).</td>
      <td><strong>Daemon mode</strong> (mcp‑server <code>daemon/</code>)</td>
      <td>Use the daemon entrypoint &amp; tunnel providers under <code>packages/mcp-server/src/daemon/</code>.</td>
    </tr>
  </tbody>
</table>

---

## Repo shape

Four npm workspaces under <a href="./packages/">packages/</a>. Almost every aggregate task builds **shared first** because the extension host and the webview both import its contracts from source.[^shape]

- **[`packages/shared`](./packages/shared/)** – message contracts, `IdeTarget` / `DashboardState` types, and the `PERPLEXITY_RULES_SECTION_START/END` markers used by auto‑config.
- **[`packages/mcp-server`](./packages/mcp-server/)** – Perplexity MCP runtime. Ships standalone as `perplexity-user-mcp` and is bundled into the extension’s `dist/mcp/server.mjs` (ESM only).
- **[`packages/webview`](./packages/webview/)** – React 19 + Vite + Tailwind v4 + zustand dashboard. Built assets copied into `packages/extension/media/webview/`.
- **[`packages/extension`](./packages/extension/)** – VS Code extension host (CommonJS via tsup, `target: node20`). Registers the bundled MCP server via `mcpServerDefinitionProviders`, owns the webview, auto‑config, and the embedded daemon.

[^shape]: See [tsconfig.base.json](./tsconfig.base.json) and [vitest.config.ts](./vitest.config.ts) for workspace wiring and test globs.

---

## Quick start

Prerequisites:

- Node.js **20+**
- npm (workspaces enabled)
- A Perplexity account (Free / Pro / Max)

```bash
git clone https://github.com/Automations-Project/VSCode-Perplexity-MCP.git
cd VSCode-Perplexity-MCP

npm install
npm run build          # shared → mcp-server → webview → extension (in that order)
npm test               # vitest across all packages
npm run package:vsix   # produces packages/extension/perplexity-vscode-<version>.vsix
```

Install the unpacked extension into VS Code:

```bash
code --install-extension packages/extension/perplexity-vscode-<version>.vsix
```

> **Build order matters.** `packages/shared` must build before the other three. The root scripts enforce this; keep that invariant when adding new scripts.

---

## Browser support matrix

The MCP server automates a **real Chromium browser** via patchright to survive Cloudflare and serve Perplexity.[^browser]

<table>
  <thead>
    <tr>
      <th align="left">Priority</th>
      <th align="left">Runtime</th>
      <th align="left">Env hints</th>
      <th align="left">Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>#1</td>
      <td><strong>Google Chrome</strong></td>
      <td><code>PERPLEXITY_BROWSER_CHANNEL=chrome</code></td>
      <td>Recommended, best Cloudflare compatibility.</td>
    </tr>
    <tr>
      <td>#2</td>
      <td><strong>Microsoft Edge</strong></td>
      <td><code>PERPLEXITY_BROWSER_CHANNEL=msedge</code></td>
      <td>All three platforms, works like Chrome.</td>
    </tr>
    <tr>
      <td>#3</td>
      <td><strong>System Chromium</strong></td>
      <td><code>PERPLEXITY_BROWSER_CHANNEL=chromium</code></td>
      <td>Mainly Linux; good for headless servers.</td>
    </tr>
    <tr>
      <td>#4</td>
      <td><strong>Brave</strong></td>
      <td>auto‑detected</td>
      <td>Chromium‑based; works with no special flags.</td>
    </tr>
    <tr>
      <td>#5</td>
      <td><strong>Patchright’s bundled Chromium</strong></td>
      <td>
        <code>npx patchright install chromium</code><br>
        then auto‑detected
      </td>
      <td>Fallback when nothing else is present.</td>
    </tr>
  </tbody>
</table>

Extra overrides:

- `PERPLEXITY_BROWSER_PATH` – absolute browser executable path (wins over detection).
- `PERPLEXITY_CHROME_PATH` – legacy alias for `PERPLEXITY_BROWSER_PATH`.
- `PERPLEXITY_CONFIG_DIR` – overrides `~/.perplexity-mcp` (profiles, vault, daemon state).

---

## First run, profiles, and the vault

Perplexity serves a Cloudflare Turnstile on first run; the server opens a headed browser for you to log in, then caches `cf_clearance` + session in `~/.perplexity-mcp/`.[^login]

- Profiles live under `~/.perplexity-mcp/profiles/<name>/`.
- Cookies are encrypted into `vault.enc` (keytar with passphrase fallback).
- Any process that mutates profile state touches a `.reinit` sentinel, which running MCP servers watch and hot‑reload from (no restart required).

Delete `~/.perplexity-mcp/` to start over completely, or use `PERPLEXITY_HEADLESS_ONLY=1` once a valid clearance is cached.

---

## Search Sources and Advanced Queries

This MCP mirrors Perplexity's web app source picker more closely than the official API-key MCP server. The search-style tools accept a `sources` array with these values:

- `web` - general web search. This is the default.
- `scholar` - scholarly / academic source focus.
- `social` - social discussion source focus.

The source selector is explicit. If your MCP client calls a tool without `sources`, the server sends `["web"]`. Ask your agent for the source mode you want, or pass it directly when your client exposes tool arguments.

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

Natural-language prompts usually work too, as long as they are specific:

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

### Search defaults

When no optional arguments are supplied:

| Tool | Model default | Mode default | Sources default | Language default |
|---|---|---|---|---|
| `perplexity_search` | Authenticated: `pplx_pro`; anonymous: `turbo` | Authenticated: `copilot`; anonymous: `concise` | `["web"]` | `en-US` |
| `perplexity_ask` | `PERPLEXITY_SEARCH_MODEL` or `pplx_pro` | `copilot` | `["web"]` | `en-US` |
| `perplexity_reason` | `PERPLEXITY_REASON_MODEL` or `claude46sonnetthinking` | `copilot` | `["web"]` | `en-US` |
| `perplexity_research` | `PERPLEXITY_RESEARCH_MODEL` or `pplx_alpha` | `copilot` | `["web"]` | `en-US` |
| `perplexity_compute` | Tool argument, then `PERPLEXITY_COMPUTE_MODEL`, then account ASI default, then `pplx_asi` | `asi` | web-only Computer mode | `en-US` |

Model defaults are configurable with environment variables:

- `PERPLEXITY_SEARCH_MODEL`
- `PERPLEXITY_REASON_MODEL`
- `PERPLEXITY_RESEARCH_MODEL`
- `PERPLEXITY_COMPUTE_MODEL`

`perplexity_ask`, `perplexity_reason`, and `perplexity_compute` also accept a per-call `model` argument. `perplexity_ask` accepts `mode: "concise" | "copilot"`. `perplexity_search`, `perplexity_reason`, `perplexity_research`, and `perplexity_ask` accept `sources` and `language`.

### How requests reach Perplexity

For search-style tools, the MCP server builds the same kind of request body the Perplexity web app sends: `query_str`, selected model, mode, source list, language, and optional follow-up thread context. It posts that body from the logged-in browser session to `https://www.perplexity.ai/rest/sse/perplexity_ask`.

Perplexity responds as a Server-Sent Events stream. The MCP runtime reads the stream and turns it into a normal tool response: answer text, citation sources, media items, suggested follow-ups, follow-up context, and the Perplexity thread URL. This is why the server can use your existing Free / Pro / Max account features without a Perplexity API key, but it also means the request shape can drift if Perplexity changes its private web endpoint.

### Current tuning opportunities

- The auto-config rules catalogue in `packages/extension/src/auto-config/index.ts` is a static copy of the tool list and summaries. Tests keep it in sync with registered tool names, but summaries and usage guidance still have to be updated by hand. A future improvement would generate the rules block from the MCP tool schemas, or share one typed catalogue between the runtime and auto-config.
- `sources` defaults to `["web"]` even for queries that clearly ask for papers or social discussion. We can either document prompt patterns, as above, or add a small routing layer that infers `scholar` / `social` from the user's request before calling Perplexity.
- `perplexity_search` uses browser-backed search by default. Experimental browser-free search exists behind `PERPLEXITY_EXPERIMENTAL_IMPIT_SEARCH=1`, but it is intentionally opt-in because Perplexity's private search request body can change.
- `perplexity_models` already uses a warm disk cache before launching the browser. Similar cache-first behavior may help for repeated model/tier/rate-limit checks from agents.

---

## Supported IDEs / MCP clients

Auto‑config writes MCP configs and rulesets for 15+ IDEs and agents; the same server also runs everywhere else.[^ide]

<table>
  <thead>
    <tr>
      <th align="left">Client</th>
      <th align="left">How it’s wired</th>
      <th align="left">Config artifact</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>VS Code</strong></td>
      <td>Native extension, embedded daemon, webview dashboard.</td>
      <td><code>settings.json</code>, <code>Perplexity: Login</code>, agent MCP config.</td>
    </tr>
    <tr>
      <td><strong>Cursor</strong></td>
      <td>Auto‑written MCP settings + rules section.</td>
      <td><code>.cursor/rules/*.mdc</code>, <code>mcp.json</code>.</td>
    </tr>
    <tr>
      <td><strong>Claude Desktop / Claude Code</strong></td>
      <td>Config + rules docs, upsert between markers.</td>
      <td><code>claude_desktop_config.json</code>, <code>CLAUDE.md</code>.</td>
    </tr>
    <tr>
      <td><strong>Windsurf, Cline, Amp, Codex CLI</strong></td>
      <td>MCP config and rules files per target.</td>
      <td><code>mcp_config.json</code>, <code>.rules</code>, <code>.github/instructions/*</code>, etc.</td>
    </tr>
  </tbody>
</table>

Auto‑config uses `IDE_METADATA` in `packages/shared/src/constants.ts` and upserts `PERPLEXITY-MCP-START` / `PERPLEXITY-MCP-END` sections without touching hand‑written content.

---

## Commands

All commands run from the repo root.

```bash
npm install

npm run build          # shared → mcp-server → webview → extension
npm run typecheck      # tsc --noEmit across all four packages
npm test               # builds shared, then runs vitest
npm run test:coverage  # vitest with v8 coverage; enforces per-file thresholds
npm run package:vsix   # full build + vendored deps + vsce package

npm run dev:webview    # Vite dev server for dashboard
npm run dev:extension  # tsup --watch for extension host
npm run clean          # rm dist + media/webview across packages
```

Single‑file / single‑test runs:

```bash
npx vitest run packages/mcp-server/test/redact.test.js
npx vitest run packages/extension/tests/auth-manager.login.test.ts
npx vitest run -t "resolves .reinit sentinel"
```

Coverage thresholds are enforced: e.g., `redact.js` / `vault.js` ≥ 95%, `profiles.js` / `cli.js` ≥ 85%.

---

## Architecture notes

A few cross‑cutting pieces that matter:

- **Bundled MCP with curated externals.**  
  `packages/extension/package.json` `build:mcp` tsups `packages/mcp-server/src/index.ts` into `dist/mcp/server.mjs`, renames `index.mjs → server.mjs`, and copies the mcp‑server `package.json` next to it. Externals
  (`patchright`, `got-scraping`, `tough-cookie`, `gray-matter`, `express`, `@ngrok/ngrok`, `helmet`, `keytar`, …) are deliberately left out of the bundle and vendored into `dist/node_modules/` by `packages/extension/scripts/prepare-package-deps.mjs`.

- **Daemon + pluggable tunnels.**  
  `packages/mcp-server/src/daemon/` runs a long‑lived HTTP MCP server with OAuth 2.1 (via `@modelcontextprotocol/sdk`’s `mcpAuthRouter`) and pluggable tunnels under `daemon/tunnel-providers/` (`cf-quick` and `ngrok`). Daemon state lives in `<configDir>/daemon.lock`, `daemon.token`, `tunnel-settings.json`, and `ngrok.json`.

- **Browser detection & download manager.**  
  `packages/extension/src/browser/browser-detect.ts` probes Chrome → Edge → system Chromium → Brave → patchright’s Chromium, with `BrowserDownloadManager` managing `patchright install chromium` into VS Code’s globalStorage and `AuthManager` syncing env to the detached daemon.

For deeper internals, see:

- [`docs/release-process.md`](./docs/release-process.md)
- [`docs/smoke-tests.md`](./docs/smoke-tests.md)

---

## Find Us

<div align="center">

| Registry | Link |
|:---------|:-----|
| **VS Code Marketplace** | [`Nskha.perplexity-vscode`](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| **npm** | [`perplexity-user-mcp`](https://www.npmjs.com/package/perplexity-user-mcp) |
| **MCP Registry** | [`io.github.Automations-Project/perplexity-user-mcp`](https://registry.modelcontextprotocol.io) |

</div>

---

## Support This Project

This project is built and maintained with the help of AI coding tools. If you find it useful and want to support continued development (new tools, updates, bug fixes), you can contribute by gifting **Claude Code credits** — the primary tool used to build this project.

Interested? [Open an issue](https://github.com/Automations-Project/VSCode-Perplexity-MCP/issues/new) or reach out to discuss feature requests and sponsorship.

---

## Contributing

Contributions are welcome! Conventions:

- Branch from `main` and open a PR (protected).
- Run the smoke‑test checklist in `docs/smoke-tests.md` on Windows 11, macOS 14+, and Ubuntu 22+ before tagging a release.
- Version `packages/extension` and `packages/mcp-server` together and add a [CHANGELOG](./CHANGELOG.md) entry that follows Keep a Changelog + SemVer.
- Avoid hand‑editing auto‑managed blocks between `PERPLEXITY-MCP-START` / `PERPLEXITY-MCP-END`.

---

## License

The repository is licensed under the **MIT License** – see [LICENSE](./LICENSE).

> ### Important notice
>
> This project is an **unofficial, community‑maintained integration** for Perplexity.
> It is **not affiliated with, endorsed by, or sponsored by Perplexity AI, Inc.** in any way.
>
> The MCP server works by automating a logged‑in Perplexity browser session on **your local machine**.
> This may be considered **automated access / scraping / technical misuse** under Perplexity’s
> Terms of Service and Acceptable Use Policy, and Perplexity may change or block this behaviour
> at any time.
>
> By using this project, **you are solely responsible for ensuring your use complies with
> Perplexity’s terms, policies, and any applicable law**, and you accept the risk that your
> Perplexity account could be rate‑limited, suspended, or terminated.
>
> This software is provided **“as is”**, on an **experimental** basis, **without any warranty**.
> Do not use it for anything where reliability, correctness, or policy compliance are critical.

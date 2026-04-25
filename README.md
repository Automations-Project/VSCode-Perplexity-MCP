# VSCode-Perplexity-MCP

A monorepo that ships a Perplexity MCP server two ways:

- **`perplexity-vscode`** — a native VS Code extension (currently **0.8.5**, see [CHANGELOG.md](CHANGELOG.md)) with an embedded daemon, webview dashboard, and auto-config for 15+ MCP-capable IDEs.
- **`perplexity-user-mcp`** — the same server as a standalone npm package, for Cursor, Claude Desktop, Claude Code, Windsurf, Cline, Amp, Codex CLI, and anything else that speaks MCP over stdio.

Both wrap a long-lived patchright browser session against your existing Perplexity account, so the MCP tools consume your logged-in plan (Pro, Max, etc.) rather than a paid API key.

## Repo shape

Four npm workspaces under [packages/](packages/). Almost every aggregate task builds **shared first** because the extension host and the webview both import its type contracts directly from source.

- **[packages/shared](packages/shared/)** — message contracts, `IdeTarget` / `DashboardState` types, and the `PERPLEXITY_RULES_SECTION_START/END` markers used by auto-config.
- **[packages/mcp-server](packages/mcp-server/)** — the Perplexity MCP runtime. Ships standalone as `perplexity-user-mcp` on npm and is also bundled into the extension's `dist/mcp/server.mjs`. Mixed `.ts` / `.js`; ESM only.
- **[packages/webview](packages/webview/)** — React 19 + Vite + Tailwind v4 + zustand dashboard. Its Vite build output is copied into `packages/extension/media/webview/` by [packages/extension/scripts/prepare-webview.mjs](packages/extension/scripts/prepare-webview.mjs).
- **[packages/extension](packages/extension/)** — VS Code extension host (CommonJS, `tsup`, `target: node20`). Registers the bundled MCP server via `mcpServerDefinitionProviders`, owns the webview, owns auto-config for 15+ IDEs, owns the embedded daemon.

## Quick start

Prerequisites: Node.js 20+, npm (workspaces). The author develops on Windows 11 with `bash` via Git for Windows; the same commands work on macOS and Linux.

```bash
git clone <this-repo>
cd VSCode-Perplexity-MCP
npm install
npm run build          # builds shared → mcp-server → webview → extension (in that order)
npm test               # vitest at repo root across all test folders
npm run package:vsix   # produces packages/extension/perplexity-vscode-<version>.vsix
```

**Build order matters.** `packages/shared` must build before the other three packages — the top-level scripts encode this explicitly (`-w @perplexity-user-mcp/shared` always runs first). Don't skip that step when wiring new scripts.

To load an unpacked build into VS Code, run `code --install-extension packages/extension/perplexity-vscode-<version>.vsix` on the VSIX produced by `package:vsix`.

## Commands

All run from the repo root.

```bash
npm install
npm run build          # shared → mcp-server → webview → extension (required order)
npm run typecheck      # tsc --noEmit across all 4 packages, same order
npm test               # builds shared, then runs vitest
npm run test:coverage  # vitest with v8 coverage; enforces per-file thresholds
npm run package:vsix   # full build + vendored deps + vsce package
npm run dev:webview    # Vite dev server for the dashboard
npm run dev:extension  # tsup --watch on the extension
npm run clean          # rm dist + media/webview across packages
```

Capture / analyze helpers for recording Perplexity's network protocol (used when extending the client):

```bash
npm run capture        # patchright-based capture (default)
npm run capture:cdp    # Chrome DevTools Protocol variant
npm run analyze        # post-process captures into docs
```

Single-test runs use `vitest` directly from the root — [vitest.config.ts](vitest.config.ts) globs all three test roots:

```bash
npx vitest run packages/mcp-server/test/redact.test.js
npx vitest run packages/extension/tests/auth-manager.login.test.ts
npx vitest run -t "resolves .reinit sentinel"
```

## Running the MCP server standalone

If you just want the MCP server (no VS Code), install `perplexity-user-mcp` from npm and point your MCP client at the binary. The consumer-facing docs live in [packages/mcp-server/README.md](packages/mcp-server/README.md) — that file is what ships to npm and is the authoritative reference for tool behaviour, browser requirements, login flows, the daemon, and the `doctor` subcommand.

## Architecture notes

A few things that take more than a single file to see:

- **The extension bundles the MCP server with a curated externals list.** [packages/extension/package.json](packages/extension/package.json) `build:mcp` tsups `packages/mcp-server/src/index.ts` into `dist/mcp/server.mjs`, renames `index.mjs → server.mjs`, and copies the mcp-server `package.json` next to it. Externals (`patchright`, `got-scraping`, `tough-cookie`, `gray-matter`, `express`, `@ngrok/ngrok`, `helmet`, `keytar`, …) are deliberate — they ship native binaries, top-level `require()`, or JSON data files that tsup can't inline. When adding a dependency, update both tsup configs **and** [packages/extension/scripts/prepare-package-deps.mjs](packages/extension/scripts/prepare-package-deps.mjs), which copies externals into `dist/node_modules/` at pack time so the VSIX is self-contained.
- **Profiles, vault, and the `.reinit` sentinel.** Login state lives at `~/.perplexity-mcp/profiles/<name>/` (override with `PERPLEXITY_CONFIG_DIR`). Cookies are written encrypted to `vault.enc` by [packages/mcp-server/src/vault.js](packages/mcp-server/src/vault.js) (keytar with passphrase fallback). Any process that mutates profile state touches a `.reinit` sentinel, which running MCP servers watch via [packages/mcp-server/src/reinit-watcher.js](packages/mcp-server/src/reinit-watcher.js) and hot-reload without a restart — this is why switching accounts in the dashboard takes effect in Cursor / Claude Desktop instantly.
- **Daemon + pluggable tunnel providers.** Beyond the stdio entrypoint, [packages/mcp-server/src/daemon/](packages/mcp-server/src/daemon/) runs a long-lived HTTP MCP server with OAuth 2.1 (via `@modelcontextprotocol/sdk`'s `mcpAuthRouter`) and a pluggable tunnel layer at [packages/mcp-server/src/daemon/tunnel-providers/](packages/mcp-server/src/daemon/tunnel-providers/) — `cf-quick` (Cloudflare Quick Tunnels, default) and `ngrok` (via `@ngrok/ngrok` NAPI, no child process). Daemon state lives in `<configDir>/daemon.lock`, `daemon.token`, `tunnel-settings.json`, and `ngrok.json`.
- **Auto-config for 15+ IDEs.** [packages/extension/src/auto-config/index.ts](packages/extension/src/auto-config/index.ts) writes `mcp.json` / `mcp_config.json` / `config.toml` and rules files (`.cursor/rules/*.mdc`, `.clinerules/*.md`, `CLAUDE.md`, `AGENTS.md`, `.rules`, `GEMINI.md`, `.github/instructions/*`, etc.) for every target listed in `IDE_METADATA` in [packages/shared/src/constants.ts](packages/shared/src/constants.ts). For `md-section` targets it upserts a block between `PERPLEXITY-MCP-START` / `PERPLEXITY-MCP-END` markers and preserves everything outside them.
- **Coverage thresholds are enforced.** [vitest.config.ts](vitest.config.ts) sets per-file floors: `redact.js` / `vault.js` ≥ 95% (security-critical), `profiles.js` / `cli.js` ≥ 85%. `npm run test:coverage` fails if any of those drop.
- **Six supported browser runtimes.** [packages/extension/src/browser/browser-detect.ts](packages/extension/src/browser/browser-detect.ts) probes Google Chrome → Microsoft Edge → system Chromium → Brave → patchright's bundled Chromium → **Obscura** (a ~30 MB Rust CDP server from [h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)). The first four launch via Patchright's `channel`; the fifth comes from `patchright install chromium` into VS Code's globalStorage (managed by [BrowserDownloadManager](packages/extension/src/browser/browser-download.ts)); the sixth is **connected to over CDP** via `chromium.connectOverCDP` — Obscura runs as a subprocess spawned by [ObscuraManager](packages/extension/src/browser/obscura-manager.ts) and pulls its binary from GitHub releases. Obscura is **only used for the headless search phase** in [packages/mcp-server/src/client.ts](packages/mcp-server/src/client.ts) — the headed Cloudflare Turnstile bootstrap always uses a real Chrome-family browser because Obscura hasn't been validated against CF. Selection flows through the env vars `PERPLEXITY_BROWSER_CHANNEL` (`chrome` / `msedge` / `chromium` / `obscura`), `PERPLEXITY_BROWSER_PATH`, and `PERPLEXITY_OBSCURA_ENDPOINT` (all evaluated by [packages/mcp-server/src/config.ts](packages/mcp-server/src/config.ts)). The extension's [AuthManager](packages/extension/src/mcp/auth-manager.ts) syncs these onto `process.env` so the detached MCP daemon inherits the active selection.

## Contributing

This is a **pre-public repo** — the conventions below reflect that and will tighten once the public remote is set up.

- **Commit directly to `main`.** No feature branches, no PRs against this repo yet. `main` is the default and (by intent) protected branch.
- **VSIX smoke-test before tagging.** Every versioned release must pass the manual checklists in [docs/smoke-tests.md](docs/smoke-tests.md) on Windows 11, macOS 14+, and Ubuntu 22+ before being tagged. Integration tests alone don't catch login / packaging bugs — skipping smoke has already caused regressions that made it to a shipped VSIX.
- **Version `packages/extension` and `packages/mcp-server` together.** They share a version (both are currently `0.8.5`). When bumping, update both `package.json` files and add a [CHANGELOG.md](CHANGELOG.md) entry. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and SemVer — see the 0.8.x entries for the expected level of rationale (Added / Changed / Security / Tests / Release gate).
- **Windows-first shell.** Prefer forward slashes and `/dev/null` in examples rather than `\` and `NUL`.
- **Don't touch auto-managed blocks.** Files like [CLAUDE.md](CLAUDE.md) contain a block between `PERPLEXITY-MCP-START` / `PERPLEXITY-MCP-END` that the extension regenerates; edit the hand-written sections above it instead.

## Release process

A separate walkthrough of the tag / smoke / publish flow lives in [docs/release-process.md](docs/release-process.md).

## License

The repository is licensed under the **MIT License** — see [LICENSE](LICENSE). Note that [packages/extension/package.json](packages/extension/package.json) currently declares `"license": "UNLICENSED"` because the extension isn't published to the VS Code Marketplace yet; the intent is to align it with the repository's MIT license when the extension goes public. The `perplexity-user-mcp` npm package follows the repository license.

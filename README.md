# Perplexity Internal MCP

This repository now ships a **native VS Code extension workspace** around the existing Perplexity browser-session MCP runtime.

## What Changed

- `packages/extension`: VS Code extension host, embedded MCP server bundle, auth/config commands, VSIX packaging
- `packages/webview`: React + Vite dashboard UI for login, model browsing, history, and IDE config status
- `packages/shared`: shared message contracts and state types
- `src/`: legacy standalone MCP runtime, still kept as the source of truth for the Playwright + Perplexity browser client

## Key Behavior

- VS Code registers the bundled MCP server through `mcpServerDefinitionProviders`
- The bundled server starts with `PERPLEXITY_HEADLESS_ONLY=1` so normal activation does not pop a visible browser
- Login still uses the visible Playwright/Chrome bootstrap and writes to the shared profile under `~/.perplexity-mcp` or `PERPLEXITY_CONFIG_DIR`
- The extension can generate additive MCP config files for Cursor, Windsurf, and Claude Desktop
- Query history and cached account/model state are exposed both in the webview dashboard and as MCP resources

## Workspace Commands

```bash
npm install
npm run build
npm run typecheck
npm test
npm run package:vsix
```

The packaged VSIX is written to:

```text
packages/extension/perplexity-vscode-0.1.0.vsix
```

## Development

```bash
npm run dev:webview
npm run dev:extension
```

The webview build output is copied into `packages/extension/media/webview` during extension builds.

## Legacy Runtime

The original standalone entrypoints are still available for direct runtime debugging:

```bash
npm run legacy:dev
npm run legacy:build
npm run legacy:login
```

## Notes

- The packaged extension includes the Playwright JavaScript runtime under `dist/node_modules`. Browser binaries are still expected to come from system Chrome or an existing Playwright browser install.
- Top-level architecture research remains in [VSCODE_EXTENSION_ARCHITECTURE.md](/c:/Users/admin/github-repos/Perplixity-Internal-MCP/VSCODE_EXTENSION_ARCHITECTURE.md).

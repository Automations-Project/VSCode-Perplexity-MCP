<div align="center">

<p align="center">
  <img alt="Perplexity MCP" src="https://raw.githubusercontent.com/Automations-Project/VSCode-Perplexity-MCP/main/packages/extension/media/icon.png" height="120">
</p>

# Perplexity MCP for VS Code

**Use your Perplexity account (Free / Pro / Max) directly inside VS Code — no API key needed.**

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode"><img src="https://vsmarketplacebadges.dev/version-short/Nskha.perplexity-vscode.svg?style=for-the-badge&label=VS%20Code&colorB=007ACC" alt="VS Code version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode"><img src="https://vsmarketplacebadges.dev/installs-short/Nskha.perplexity-vscode.svg?style=for-the-badge&label=Installs&colorB=1E8CBE" alt="VS Code installs" /></a>
  <a href="https://github.com/Automations-Project/VSCode-Perplexity-MCP/releases/latest"><img src="https://img.shields.io/github/v/release/Automations-Project/VSCode-Perplexity-MCP?style=for-the-badge&logo=github&logoColor=white&label=Latest%20Release&color=10B981" alt="Latest release" /></a>
  <a href="https://github.com/Automations-Project/VSCode-Perplexity-MCP/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Automations-Project/VSCode-Perplexity-MCP?style=for-the-badge&logo=opensourceinitiative&logoColor=white&label=License&color=22C55E" alt="License" /></a>
</p>

<br />

> **Not affiliated with Perplexity AI, Inc.** This is a community-maintained project.
>
> **Experimental** — Under active development. APIs and behavior may change without notice.

</div>

---

## Install

| IDE | Install |
|:---:|:--------|
| <img src="https://raw.githubusercontent.com/Automations-Project/VSCode-Perplexity-MCP/main/mcp-tool-icons/vscode.svg" height="20" valign="middle" alt="VS Code" /> **Visual Studio Code** | [![Install](https://img.shields.io/badge/Install-VS%20Code-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="https://raw.githubusercontent.com/Automations-Project/VSCode-Perplexity-MCP/main/mcp-tool-icons/vscode.svg" height="20" valign="middle" alt="VS Code Insiders" /> **VS Code Insiders** | [![Install](https://img.shields.io/badge/Install-VS%20Code%20Insiders-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="https://raw.githubusercontent.com/Automations-Project/VSCode-Perplexity-MCP/main/mcp-tool-icons/cursor.svg" height="20" valign="middle" alt="Cursor" /> **Cursor** | [![Install](https://img.shields.io/badge/Install-Cursor-000000?style=flat-square&logo=cursor&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="https://raw.githubusercontent.com/Automations-Project/VSCode-Perplexity-MCP/main/mcp-tool-icons/windsurf.svg" height="20" valign="middle" alt="Windsurf" /> **Windsurf** | [![Install](https://img.shields.io/badge/Install-Windsurf-0E6EFD?style=flat-square&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="https://raw.githubusercontent.com/Automations-Project/VSCode-Perplexity-MCP/main/mcp-tool-icons/trae.svg" height="20" valign="middle" alt="Trae" /> **Trae** | [![Install](https://img.shields.io/badge/Install-Trae-FF6B35?style=flat-square&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Nskha.perplexity-vscode) |
| <img src="https://raw.githubusercontent.com/Automations-Project/VSCode-Perplexity-MCP/main/mcp-tool-icons/vscode.svg" height="20" valign="middle" alt="Open VSX" /> **Open VSX** (Gitpod · Theia · Coder) | [![Install](https://img.shields.io/badge/Install-Open%20VSX-C160EF?style=flat-square&logoColor=white)](https://open-vsx.org/extension/Nskha/perplexity-vscode) |

---

## What is this?

A VS Code extension that embeds the **Perplexity MCP runtime** directly in your editor. It drives a long-lived **patchright** Chromium session against your existing Perplexity account — so it uses your Free / Pro / Max plan instead of an API key.

### Key features

- **Zero API key** — authenticates via your browser session, uses your existing Perplexity plan.
- **Embedded MCP server** — registered via `mcpServerDefinitionProviders`; agents (Copilot, Cursor, etc.) pick it up automatically.
- **Webview dashboard** — login flows, profile management, session status, all inside VS Code.
- **Auto-config for 15+ IDEs** — one click writes MCP configs and rulesets for Cursor, Windsurf, Claude Desktop, Cline, Amp, Codex CLI, and more.
- **Daemon mode** — keep a long-lived HTTP MCP server running with Cloudflare or ngrok tunnels.

---

## Getting started

1. Install the extension from the Marketplace.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`Perplexity: Login`**.
3. A browser window opens — log in to your Perplexity account.
4. Done. The MCP server is now available to any agent in VS Code.

> **First run only:** Perplexity serves a Cloudflare Turnstile on the first login. The extension opens a headed browser so you can complete it. After that, sessions are cached and renewed automatically.

---

## Browser support

The extension automates a real Chromium browser to survive Cloudflare. It probes in this order:

| Priority | Browser | Notes |
|:--------:|:--------|:------|
| #1 | **Google Chrome** | Recommended — best Cloudflare compatibility |
| #2 | **Microsoft Edge** | Works on all platforms |
| #3 | **System Chromium** | Good for Linux / headless servers |
| #4 | **Brave** | Auto-detected, no special flags |
| #5 | **Bundled Chromium** | Fallback via `npx patchright install chromium` |

Override detection with `PERPLEXITY_BROWSER_CHANNEL` or `PERPLEXITY_BROWSER_PATH`.

---

## Auto-config: supported IDEs

Run **`Perplexity: Configure IDEs`** from the Command Palette to auto-write MCP configs and rules for:

| Client | Config written |
|:-------|:--------------|
| **Cursor** | `.cursor/rules/*.mdc`, `mcp.json` |
| **Claude Desktop / Claude Code** | `claude_desktop_config.json`, `CLAUDE.md` |
| **Windsurf** | `mcp_config.json`, `.windsurfrules` |
| **Cline** | MCP settings, `.clinerules` |
| **Amp** | `.github/instructions/*` |
| **Codex CLI** | `mcp.json`, `AGENTS.md` |
| …and 9 more | See [full IDE list](https://github.com/Automations-Project/VSCode-Perplexity-MCP#supported-ides--mcp-clients) |

---

## Commands

| Command | Description |
|:--------|:-----------|
| `Perplexity: Login` | Open login browser and authenticate |
| `Perplexity: Logout` | Clear cached session |
| `Perplexity: Configure IDEs` | Auto-write MCP configs for all supported IDEs |
| `Perplexity: Open Dashboard` | Open the webview dashboard |
| `Perplexity: Restart Server` | Restart the embedded MCP daemon |

---

## Links

- [GitHub Repository](https://github.com/Automations-Project/VSCode-Perplexity-MCP)
- [Changelog](https://github.com/Automations-Project/VSCode-Perplexity-MCP/blob/main/CHANGELOG.md)
- [Report a Bug](https://github.com/Automations-Project/VSCode-Perplexity-MCP/issues/new?template=bug-report.yml)
- [npm package (standalone MCP server)](https://www.npmjs.com/package/perplexity-user-mcp)

---

**MIT License** · Not affiliated with Perplexity AI, Inc.

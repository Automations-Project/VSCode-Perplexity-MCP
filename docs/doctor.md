# Perplexity MCP Doctor

`perplexity-user-mcp doctor` audits your install across 10 categories, exits non-zero on any `fail`, and optionally runs a live search probe. Use it first whenever anything isn't working.

## CLI

```
npx perplexity-user-mcp doctor [flags]
```

Flags:
- `--profile <name>` — audit a specific profile (default: active profile).
- `--probe` — run an opt-in live `perplexity_search` probe. Adds ~1–10 s to the run.
- `--all` — audit every profile, not just the active one.
- `--json` — emit a single-line machine-readable `DoctorReport`. Suitable for piping to `jq`.

Exit codes: `0` for pass/warn/skip, `10` when any category rolls up to `fail`.

## Categories

Each category rolls up multiple check entries. Ordering is significant — higher-level categories (runtime, config) come first so failures earlier in the pipeline surface before dependent checks.

| Category | What it audits |
|---|---|
| `runtime` | Node ≥ 20, platform, arch, package version, git SHA (if present) |
| `config` | `~/.perplexity-mcp/` exists with 0700 perms, `active` pointer valid, `config.json` parseable |
| `profiles` | Per-profile: `meta.json` parses, vault file present (enc or plain), models cache age (< 7 days) |
| `vault` | Encryption mode (AES-GCM or plaintext opt-out), unseal path (keychain → env var → TTY → fail) |
| `browser` | Chrome / Edge / Chromium detected, version probe, patchright bundle presence |
| `native-deps` | patchright resolves, **got-scraping packaging chain intact** (header-generator → dot-prop → is-obj — carry-over #5 regression guard), impit install state |
| `network` | DNS for `www.perplexity.ai`, HTTPS HEAD `/login`, Cloudflare challenge detection |
| `ide` | Detected vs configured IDEs (Cursor, Windsurf, Claude Desktop, Codex CLI, etc.) — only when the extension passes `ideStatuses` |
| `mcp` | `tools-config.json` parseable, enabled-tool count matches the configured profile |
| `probe` | **Opt-in:** live `perplexity_search({query:"hello"})` — returns latency + source count |

## Dashboard

Open the VS Code extension → `Perplexity` sidebar → `Doctor` tab.

- **Run** — quick checks, no live probe.
- **Deep check** — includes the live probe.
- **Export** — save the full `DoctorReport` JSON to a file of your choice.
- **Report issue** — builds a redacted GitHub issue URL (see the Reporting section below). Only appears when overall status is `fail`.

## MCP tool

```ts
perplexity_doctor({ probe?: boolean, profile?: string })
```

Returns the report rendered as Markdown — suitable for LLMs to self-diagnose their own Perplexity MCP setup. Available under the `read` tool category, so it works in both `read-only` and `full` profiles.

## Reporting issues

The guided issue flow:

1. You click **Report issue** in the Doctor tab.
2. The extension runs `doctor` again (fresh report), builds a Markdown payload including the 10-category rollup + a `stderr` tail, and **applies the shared redactor** (`packages/mcp-server/src/redact.js`).
3. You see a preview modal with the redacted payload. Three buttons: **Open GitHub issue**, **Copy to clipboard**, **Cancel**.
4. If you click **Open GitHub issue**, `vscode.env.openExternal` opens a pre-filled URL against `.github/ISSUE_TEMPLATE/doctor-report.yml` (consent checkboxes gate submission).

### Redaction guarantees

Before the payload is shown in the preview modal, these patterns are scrubbed:

- Email addresses (RFC 5322 subset)
- Perplexity user IDs (`user_<hex>`)
- `__Secure-next-auth.session-token` and `cf_clearance` cookie values
- Home directory paths (`/home/<user>/...`, `/Users/<user>/...`, `C:\Users\<user>\...`)
- IPv4 and IPv6 addresses
- Any `key=<opaque-token>` where the token is ≥ 20 base64/hex characters

See [packages/mcp-server/src/redact.js](../packages/mcp-server/src/redact.js) for the full pattern list and unit tests in [redact.test.js](../packages/mcp-server/test/redact.test.js).

### Opt-out

Add to `~/.perplexity-mcp/config.json`:

```json
{ "reporting": { "githubIssueButton": false } }
```

The Report-issue button is hidden in the Doctor tab and the CLI doctor never composes issue URLs. No telemetry or background reporting exists — this toggle only controls the user-initiated GitHub URL path.

## Carry-over #5: the got-scraping packaging chain

Phase 2 shipped a VSIX where the `header-generator → dot-prop → is-obj` transitive dep chain wasn't hoisted into the extension's `dist/node_modules/`. When the chain broke at runtime, `got-scraping` silently fell back from its fast HTTP tier to a slower browser tier — users got working but slower installs with no indication why.

The Phase 2 packaging patch added `dot-prop` and `is-obj` to `rootPackages` in [packages/extension/scripts/prepare-package-deps.mjs](../packages/extension/scripts/prepare-package-deps.mjs). The Phase 3 Doctor's `native-deps/got-scraping-chain` check walks the chain via `createRequire` and emits a `warn` with an actionable hint pointing back at that script if any link regresses. It's the permanent regression guard.

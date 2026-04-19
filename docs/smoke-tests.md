# Manual smoke tests — Phase 2 (`perplexity-user-mcp` 0.3.0)

These cases exercise behavior that integration tests can't cover: real
browser rendering, real OTP email delivery, real Cloudflare challenge, and
real keychain dialogs. Run on Windows 11, macOS 14+, and Ubuntu 22+ before
tagging 0.3.0.

## Checklist

1. [ ] Fresh install: `npx perplexity-user-mcp@0.3.0 --help` prints the subcommand list.
2. [ ] `npx perplexity-user-mcp add-account --name work --mode manual` creates `~/.perplexity-mcp/profiles/work/`.
3. [ ] `npx perplexity-user-mcp login --profile work --mode manual` opens a headed browser; after login, `vault.enc` exists and CLI prints `login finished (0)`.
4. [ ] Within 2s of login, a running MCP server (Claude Desktop or Cursor) accepts a `perplexity_models` call and reports Pro tier (proves `.reinit` sentinel fires across runtimes).
5. [ ] `npx perplexity-user-mcp status --json` reports `{"valid":true,"tier":"Pro",...}`.
6. [ ] `npx perplexity-user-mcp add-account --name personal --mode auto` then `login --profile personal --mode auto --email you@example.com`: CLI prompts for OTP, accepts it, succeeds.
7. [ ] `npx perplexity-user-mcp switch-account work` followed by `status` reports the `work` profile's tier (not `personal`).
8. [ ] In VS Code, open the dashboard: profile pill shows active profile name + tier + green status dot.
9. [ ] Click the pill -> Switch to `personal` -> status pill re-renders with `personal`'s tier; the extension fires `serverDefinitionsChanged`, MCP host refreshes.
10. [ ] Click Logout (soft) -> pill shows yellow/red; `perplexity_search` from any MCP host returns a "session expired, run login" remediation error rather than crashing.
11. [ ] Force session expiry (delete the vault's `cookies` key manually) then run any auth-requiring tool: extension shows "Re-login" warning dialog.
12. [ ] On headless Linux (no libsecret), set `PERPLEXITY_VAULT_PASSPHRASE`, run `status` -> succeeds. Unset the env var -> `status` prints the "Vault locked" remediation message and exits non-zero.

Referenced by release gate in [docs/superpowers/plans/2026-04-20-phase-2-auth.md](docs/superpowers/plans/2026-04-20-phase-2-auth.md) Task 14.

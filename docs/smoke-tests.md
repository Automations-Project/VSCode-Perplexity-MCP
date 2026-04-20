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

## Phase 3 — Doctor (0.4.0)

Run these manually before tagging v0.4.0. Each item should pass on Windows 11, macOS 14+, and Ubuntu 22+.

- [ ] **Clean install passes.** On a fresh `pnpm install && pnpm build`, `npx perplexity-user-mcp doctor` exits 0 with overall `pass` or `warn` (no `fail`).
- [ ] **Broken VSIX packaging is detected.** Temporarily delete `dist/node_modules/is-obj/` in the built VSIX, then load the extension from `code --install-extension <vsix>`. Open the Doctor tab and click Run — the `native-deps/got-scraping-chain` check should emit a `warn` with a hint pointing at `prepare-package-deps.mjs`.
- [ ] **`--probe` runs a live search.** Log in via the extension first, then `npx perplexity-user-mcp doctor --probe`. The `probe/probe-search` check should emit `pass` with `latencyMs < 10000` and `sourceCount ≥ 1`.
- [ ] **`--json` output is valid JSON.** `npx perplexity-user-mcp doctor --json | jq .overall` prints one of `"pass"`, `"warn"`, `"fail"`.
- [ ] **Doctor tab renders.** Open the extension's `Doctor` tab. All 10 category cards render. Clicking a category toggles the expanded check list. Status dots reflect the category rollup.
- [ ] **Report-issue preview shows no PII.** Artificially induce a fail (e.g., rename your Chrome binary so `browser/chrome-family` fails). Click **Report issue**. Verify the preview modal contains no emails, no userIds, no cookie values, no home paths, and no IPs.

## Phase 3.1 — Doctor-exposed hotfix (0.4.1)

Run these on Windows 11 after `npm run package:vsix` in `packages/extension/` produces `perplexity-vscode-0.4.1.vsix` AND the VSIX is installed via `code --install-extension perplexity-vscode-0.4.1.vsix`. All four items must be green before tagging v0.4.1.

- [ ] **Login succeeds end-to-end.** Open the extension -> click **Login** in the header -> the manual-login browser opens (or OTP flow starts). You must get past the Phase-2 `"require not available"` error. A successful login writes cookies to `~/.perplexity-mcp/profiles/default/vault.enc`.
- [ ] **Doctor: patchright + got-scraping-chain both pass.** Open the Doctor tab -> click **Run**. The `native-deps` category's `patchright` check should be `pass` (no "not resolvable" error) and `got-scraping-chain` should be `pass` (no warn). The carry-over #5 detector remains, but the false positive is gone.
- [ ] **Doctor report timestamp is readable.** In the Doctor tab, click **Report issue** on any failing check -> the preview modal shows `Generated: <real ISO timestamp>` -- NOT `Generated: <ip>.278Z`.
- [ ] **Tab order.** The tab strip reads: Home -> IDEs -> Rules -> Models -> Doctor -> History. Doctor is second-to-last, not second.

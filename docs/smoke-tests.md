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

## Phase 4 — History Viewer (0.5.0)

Run these before tagging `v0.5.0`.

- [ ] **History writes as Markdown.** Run a new `perplexity_search` or `perplexity_research`, then confirm a new `~/.perplexity-mcp/profiles/<name>/history/*.md` file exists with YAML frontmatter and readable Markdown body.
- [ ] **Rich View renders.** Open the dashboard -> History -> Rich View for an entry. Confirm the overlay shows the Markdown body, metadata, sources, and attachments sidebar. Press `Esc` and confirm it closes.
- [ ] **Markdown export fallback works.** From the dashboard or `Perplexity: Export History Entry`, export an entry as Markdown. Confirm a `.md` copy is written under that entry's attachments directory.
- [ ] **Native PDF or DOCX export works for an authenticated entry.** Export a logged-in entry as PDF or DOCX and confirm the saved file opens correctly from the attachments directory.
- [ ] **Preview and external open flows work.** Use **Open with** -> `VS Code preview` and at least one detected external viewer or `System default`.
- [ ] **Pin and tag changes round-trip.** Pin an entry in Rich View, add/update tags, refresh the dashboard, and confirm the card and Rich View metadata stay in sync.
- [ ] **Rebuild index recovers history.** Run `Perplexity: Rebuild History Index` or `npx perplexity-user-mcp rebuild-history-index --json` and confirm it reports scan counts and the History tab still loads.
- [ ] **Doctor reports viewer detection.** Run `npx perplexity-user-mcp doctor` and confirm the `ide.mdViewers` check reports detected viewers without failing when none are installed.

## Phase 8.3 — stdio launcher → daemon-proxy (0.8.0)

Phase 8.3 flips every auto-configured external stdio MCP client (Claude Desktop, Cursor, Cline, Codex CLI, Amp, …) onto the shared daemon. Pre-8.3.0, each client spawned its own in-process stdio server + Chromium; post-8.3.0, they all multiplex onto one daemon + one Chromium. The integration suite covers the CLI/launcher-generator paths but cannot exercise three real clients opening Chromium simultaneously — this checklist is gating for v0.8.0.

Prereqs before running:

1. Install the fresh smoke VSIX: `code --install-extension packages/extension/perplexity-vscode-0.7.4.vsix --force`. The VSIX still carries the **0.7.4** version stamp deliberately — the bump to 0.8.0 happens in Task 8.3.5 **after** this smoke passes. The artifact at HEAD `d987f60` contains the 8.3.1–8.3.3 code and is the correct smoke target; the filename only becomes `perplexity-vscode-0.8.0.vsix` during release prep.
2. Reload the VS Code window.
3. Profile must already be logged in (daemon needs cookies in `~/.perplexity-mcp/profiles/<active>/vault.enc`).
4. Claude Desktop, Cursor, and Cline all installed. (If any is unavailable, substitute another stdio MCP client but note the substitution in the smoke-evidence file.)

Run these on Windows 11 (primary) + macOS 14 (secondary, if available). All eight must pass or be explicitly waived before tagging v0.8.0.

- [ ] **Migration — stale launcher is rewritten.** Before installing 0.8.0, note the current contents of `~/.perplexity-mcp/start.mjs` (should be the pre-8.3.3 one-liner `await import(config.serverPath)`). Install the 0.8.0 VSIX and reload VS Code. Re-open `start.mjs` — it must now contain the literal substring `attachToDaemon` AND `fallbackStdio: true`. Fresh installs (no pre-existing file) are also acceptable; in that case, note "fresh install" in the evidence.
- [ ] **Configs generated.** Run command `Perplexity: Generate MCP Configs` from the command palette. Select at least Claude Desktop, Cursor, and Cline (add more if configured). Each target's config file (`claude_desktop_config.json`, `.cursor/mcp.json`, `.cline/mcp_config.json` or equivalent) points `args` at `~/.perplexity-mcp/start.mjs`.
- [ ] **One daemon + one Chromium invariant.** Launch Claude Desktop, Cursor, and Cline in sequence (give each ~5s to hand-shake). Open Task Manager (Windows) or Activity Monitor (macOS). Filter by process tree. Assert: **exactly one `node` process holding `daemon.lock`'s PID** AND **exactly one Chromium tree** (one parent + N renderer children is fine — "one tree" means one parent PID). Attach a screenshot or copy the process table into the evidence file. If you see three Chromium parents, the consolidation failed.
- [ ] **Distinct launcher client IDs in audit.** Open `~/.perplexity-mcp/audit.log` (or wherever the daemon writes OAuth/request audit entries — check the daemon's startup banner). Each of the three clients should have stamped a distinct `x-perplexity-client-id` header with prefix `perplexity-launcher-<pid>`. Count the distinct PIDs: expect exactly three (one per client's launcher process).
- [ ] **End-to-end tool call.** From each of the three clients, trigger a `perplexity_models` or simple `perplexity_search` tool call. All three responses must succeed and include model/account-tier data. This proves the stdio↔HTTP proxy path is fully wired across all three launchers simultaneously.
- [ ] **PERPLEXITY_NO_DAEMON opt-out.** Edit one client's `mcp.json` to add `"env": { "PERPLEXITY_NO_DAEMON": "1" }` alongside the existing env block. Restart that client only. Assert: that client's process inventory shows a **new** Chromium tree (its own, not shared with the daemon). Its stderr (visible in the client's MCP log) contains the literal line `[perplexity-mcp] PERPLEXITY_NO_DAEMON=1 set; running in-process stdio (daemon bypass)`. A `perplexity_models` call from that client still succeeds. Revert the edit before moving on.
- [ ] **Stdout discipline.** Enable MCP protocol logging in one client (e.g., Claude Desktop: `MCP_LOGS=1` or check the view logs menu). After a tool call, inspect the MCP session log — it must contain zero `Parse error` / `SyntaxError` / `Unexpected token` entries. If the launcher ever writes to stdout, JSON-RPC framing breaks and these errors appear.
- [ ] **Fallback-stdio path — best-effort manual.** Naively killing the running daemon does NOT reliably exercise the fallback path: `ensureDaemon` has a 15s retry loop that cheerfully re-spawns a fresh daemon on the next poll, so a restarted client will just re-attach to the respawned daemon and never enter the fallback branch. The **authoritative evidence** for the fallback path is the automated integration test `packages/mcp-server/test/daemon/attach.test.js` (fallback-stdio case added in Task 8.3.1), which the headless release gate (`npx vitest run`) proves on every commit — re-run it here and record the count:
  ```
  npx vitest run packages/mcp-server/test/daemon/attach.test.js
  ```
  Expect: 3 passed / 1 file. Paste the output in the evidence file.

  **Optional best-effort manual recipe** (skip if integration test is green and time is short): in ONE client's `mcp.json`, set an env block `"PERPLEXITY_CONFIG_DIR": "<userprofile>/.perplexity-mcp-smoke-blocker.txt"` where that path is a **pre-created empty file** (not a directory). The daemon can't `mkdirSync` onto a file, so `spawnDetachedDaemon`'s child crashes, `ensureDaemon` times out after 15s, and `attachToDaemon` runs the fallback. Restart that client. **Expected behavior if fallback triggers:**
    - That client's MCP stderr contains the literal line: `[perplexity-mcp] daemon unreachable (...); falling back to in-process stdio`
    - The in-process stdio then runs `server.main()` via the DI `runStdioMain` shim added in 8.3.3 (the default `attach.ts` fallback path — `import("../index.js")` — does NOT work in the bundled extension layout where attach.ts is inlined into `dist/mcp/server.mjs`; if you ever see `ERR_MODULE_NOT_FOUND` here instead of the fallback line, the DI shim did NOT land correctly in the bundle).
    - `server.main()` may itself fail to find a logged-in profile under the bogus config dir — that's OK for this check. The evidence you need is the stderr line plus clean process exit (no ERR_MODULE_NOT_FOUND). If the client shows "no session" after fallback, that's a secondary confirmation that `server.main()` ran.

  Revert the bogus `PERPLEXITY_CONFIG_DIR` edit before moving on. Mark this check ✅ if the integration test passed OR the manual recipe showed the stderr line.

When all eight are green (or explicitly waived), save the evidence file to `docs/smoke-evidence/phase-8-3-YYYY-MM-DD.md` and proceed to Task 8.3.5 (release v0.8.0).

Referenced by release gate in [docs/superpowers/plans/2026-04-22-phase-8-completeness.md](superpowers/plans/2026-04-22-phase-8-completeness.md) Task 8.3.4.

# Manual smoke tests — Phase 2 (`perplexity-user-mcp` 0.3.0)

> **Release gate.** See [docs/release-process.md](release-process.md) for the consolidated release workflow: what must be green before a tag, how a three-platform smoke pass is recorded, and when a waiver is permitted.

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

## Phase 8.4 — Cloudflare named tunnel provider (0.8.1)

Phase 8.4 adds the `cf-named` tunnel provider: a persistent URL on a user-managed Cloudflare zone (as opposed to the ephemeral `*.trycloudflare.com` of cf-quick). Unlike Phase 8.3 — where hermetic integration tests covered the fallback path cleanly — this phase's external surface cannot be meaningfully mocked: `cloudflared tunnel login`, origin-cert placement, tunnel-creation stdout parsing, DNS CNAME creation, and named-tunnel readiness detection (a NEW `Registered tunnel connection` stderr pattern, NOT the `*.trycloudflare.com` URL-extraction used by cf-quick) ALL need to be validated against real Cloudflare APIs at least once before the first public release of this provider. The 6-step minimum-viable smoke below is the release gate for v0.8.1.

Run on Windows 11 (primary) plus any second host if available.

**Prereqs:**

1. A Cloudflare account with an owned zone (free tier is fine; this smoke creates exactly one tunnel + one DNS CNAME and the cleanup in step 8 removes them).
2. One pre-chosen subdomain. Use something unambiguously disposable — e.g. `mcp-smoke-<YYYYMMDD>.<zone>` so accidental orphaning is obvious.
3. Fresh VSIX installed at v0.8.1 (filename `perplexity-vscode-0.8.1.vsix` after Task 8.4.5's bump) OR the post-8.4.4 build at HEAD `381f75c` stamped 0.8.0 (the CLI-only checks don't require the extension at all).
4. Profile logged in (only required for step 6's end-to-end daemon-start check; steps 1-5 and 7-8 are CLI-only and don't need a profile).
5. A browser available for step 3 (cloudflared login opens one).
6. The chosen hostname must not be subject to Cloudflare Challenge/CAPTCHA on MCP/OAuth paths. If the zone has WAF, Security Level, Browser Integrity Check, or Super Bot Fight Mode challenge rules, create a higher-priority Skip rule for this smoke hostname before step 6.

**Placeholders** (substitute throughout):
- `<sub>` — the disposable subdomain you chose (e.g. `mcp-smoke-20260423`)
- `<zone>` — your Cloudflare-managed zone (e.g. `example.com`)
- `<hostname>` — `<sub>.<zone>` fully qualified
- `<uuid>` — the tunnel UUID returned by `cf-named-create` in step 5 (record it for steps 7 and 8)

**Shell note:** PowerShell is the primary shell below. Git-Bash fallback is given where the syntax materially differs. Do NOT use `curl` in PowerShell (alias for `Invoke-WebRequest`, wrong output shape) — use `curl.exe` explicitly.

**Before starting — guard against orphaned prior attempts:**

```powershell
npx perplexity-user-mcp daemon cf-named-list
```
If any `mcp-smoke-*` tunnels show up from a prior run, jump to step 8 and clean them before proceeding. A stale tunnel + DNS route blocks re-running step 5 with the same hostname.

---

- [ ] **Step 1 — Install cloudflared binary.**

  **PowerShell:**
  ```powershell
  npx perplexity-user-mcp daemon install-tunnel --json
  ```
  **Bash:**
  ```bash
  npx perplexity-user-mcp daemon install-tunnel --json
  ```

  Expect: exit 0; stdout is a single JSON line containing `"ok":true` and a `binaryPath` pointing at `<configDir>/bin/cloudflared(.exe)`. The binary should be executable from that exact path in step 3.

- [ ] **Step 2 — cf-named-login decline path returns 130.**

  **PowerShell:**
  ```powershell
  "n" | npx perplexity-user-mcp daemon cf-named-login; $LASTEXITCODE
  ```
  **Bash:**
  ```bash
  echo n | npx perplexity-user-mcp daemon cf-named-login; echo "exit=$?"
  ```

  Expect: stderr shows the confirmation prompt `This opens your default browser to authorize Cloudflare. Continue? [y/N]` followed by `Cancelled.` — then the exit code printed is **130**. If you see exit 0 or 1 the confirmation wiring is wrong and this is a release blocker.

- [ ] **Step 3 — cf-named-login --yes completes browser auth and cert appears.**

  **PowerShell:**
  ```powershell
  npx perplexity-user-mcp daemon cf-named-login --yes
  ```
  **Bash:**
  ```bash
  npx perplexity-user-mcp daemon cf-named-login --yes
  ```

  A browser tab opens to `https://dash.cloudflare.com/argotunnel?...`. Authorize the zone. The CLI blocks until `~/.cloudflared/cert.pem` appears (up to 10 minutes default timeout); it should land within ~30s of clicking Authorize.

  Expect: exit 0; stdout prints `cloudflared login completed. Cert at <path>`. Then verify manually:

  **PowerShell:**
  ```powershell
  Test-Path "$env:USERPROFILE\.cloudflared\cert.pem"
  ```
  **Bash:**
  ```bash
  ls -la ~/.cloudflared/cert.pem
  ```
  Expect `True` / a regular file.

- [ ] **Step 4 — cf-named-list works (initially empty or pre-existing-only).**

  **PowerShell:**
  ```powershell
  npx perplexity-user-mcp daemon cf-named-list --json
  ```
  **Bash:**
  ```bash
  npx perplexity-user-mcp daemon cf-named-list --json
  ```

  Expect: exit 0; stdout is a single parseable JSON line `{"tunnels":[...]}`. If the array is empty that's fine — this confirms the plain-text formatter works (run without `--json` to see `No named tunnels.` on stdout). If you have pre-existing named tunnels from another workflow, they'll appear — that's expected, the list is cert-scoped not script-scoped.

- [ ] **Step 5 — cf-named-create creates tunnel, DNS route, and managed YAML.**

  **PowerShell:**
  ```powershell
  npx perplexity-user-mcp daemon cf-named-create --name "mcp-smoke-$(Get-Date -Format yyyyMMdd)" --hostname "<sub>.<zone>" --yes --json
  ```
  **Bash:**
  ```bash
  npx perplexity-user-mcp daemon cf-named-create --name "mcp-smoke-$(date +%Y%m%d)" --hostname "<sub>.<zone>" --yes --json
  ```

  Expect: exit 0; stdout is a single JSON line `{"ok":true,"hostname":"<sub>.<zone>","uuid":"<uuid>","configPath":"<configDir>/cloudflared-named.yml"}`. Record `<uuid>` for step 7 and step 8 cleanup.

  Then verify manually:

  **PowerShell:**
  ```powershell
  Get-Content "$env:USERPROFILE\.perplexity-mcp\cloudflared-named.yml"
  Test-Path "$env:USERPROFILE\.cloudflared\<uuid>.json"
  ```
  **Bash:**
  ```bash
  cat ~/.perplexity-mcp/cloudflared-named.yml
  ls -la ~/.cloudflared/<uuid>.json
  ```
  Expect the YAML contains `tunnel: <uuid>` and `hostname: <sub>.<zone>` and `service: http://127.0.0.1:1` (port=1 placeholder — real port is rewritten by the provider at daemon start; see step 6). Expect the `<uuid>.json` credentials file exists.

  **DNS cross-check** (optional but recommended):

  **PowerShell:**
  ```powershell
  Resolve-DnsName "<sub>.<zone>" -Type CNAME
  ```
  **Bash:**
  ```bash
  dig +short CNAME <sub>.<zone>
  ```
  Expect a CNAME pointing at `<uuid>.cfargotunnel.com`. If DNS hasn't propagated within ~2 minutes, Cloudflare's side of the route creation failed and step 6 will not reach the hostname.

- [ ] **Step 6 — set-provider cf-named + daemon start --tunnel reaches the named URL.**

  **PowerShell:**
  ```powershell
  npx perplexity-user-mcp daemon set-provider cf-named
  npx perplexity-user-mcp daemon start --tunnel
  ```
  **Bash:**
  ```bash
  npx perplexity-user-mcp daemon set-provider cf-named
  npx perplexity-user-mcp daemon start --tunnel
  ```

  The daemon starts, writes the lockfile at the OS-assigned loopback port, rewrites `cloudflared-named.yml` with that port (replacing the port=1 placeholder from step 5 — this is the load-bearing 8.4.2 port-drift rewrite), and spawns cloudflared with `tunnel --no-autoupdate --config <managed-yml> run`. Wait ~15s for the first `Registered tunnel connection` line in the daemon log.

  In a **second terminal**, probe the public URL via the allowlisted tunnel endpoints. **Do not** try `/daemon/*` through the tunnel — v0.7.4's H11 hardening returns 404 to all `/daemon/*` routes on the tunnel regardless of bearer, and the security regression check below verifies that still holds.

  **Primary probe: protected-resource metadata (allowlisted public endpoint).**

  **PowerShell:**
  ```powershell
  curl.exe -i "https://<sub>.<zone>/.well-known/oauth-protected-resource"
  ```
  **Bash:**
  ```bash
  curl -i "https://<sub>.<zone>/.well-known/oauth-protected-resource"
  ```
  Expect: HTTP 200. Response body is JSON containing `"resource": "https://<sub>.<zone>/mcp"` and `"resource_name": "Perplexity MCP"`. The host-aware `resource` URL proves (a) the named tunnel is up, (b) traffic reaches the local daemon on the LIVE port (not the port=1 placeholder), (c) the OAuth resource-binding logic correctly reflects the incoming Host header rather than 127.0.0.1.

  **Cloudflare edge challenge check (release blocker if present).**

  **PowerShell:**
  ```powershell
  curl.exe -i -X POST "https://<sub>.<zone>/mcp" -H "Content-Type: application/json" -H "Accept: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
  ```
  **Bash:**
  ```bash
  curl -i -X POST "https://<sub>.<zone>/mcp" -H "Content-Type: application/json" -H "Accept: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
  ```

  Expect: **not** `403` and **no** `Cf-Mitigated: challenge` response header. Cloudflare Challenge/CAPTCHA pages are returned as `text/html` before the request reaches the local daemon; MCP clients cannot solve them and will report the server as unreachable.

  If this probe is challenged, add or fix a Cloudflare WAF Custom Rule above the challenge rule:

  ```text
  http.host eq "<sub>.<zone>" and (
    http.request.uri.path eq "/" or
    starts_with(http.request.uri.path, "/mcp") or
    starts_with(http.request.uri.path, "/.well-known/") or
    http.request.uri.path in {"/authorize" "/token" "/register" "/revoke"}
  )
  ```

  Action: `Skip`. Select the products/phases that are issuing the challenge for this hostname: all remaining custom rules, managed rules, Super Bot Fight Mode, Browser Integrity Check, Security Level, and rate limiting rules as applicable. If legacy Bot Fight Mode is the source, it cannot be skipped; disable it for the zone or use a hostname/zone that does not challenge MCP traffic.

  **Optional: unauthenticated /mcp POST returns 401 with correct WWW-Authenticate.**

  **PowerShell:**
  ```powershell
  curl.exe -i -X POST "https://<sub>.<zone>/mcp" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
  ```
  **Bash:**
  ```bash
  curl -i -X POST "https://<sub>.<zone>/mcp" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
  ```
  Expect: HTTP 401 with a `WWW-Authenticate` response header that contains `resource_metadata="https://<sub>.<zone>/.well-known/oauth-protected-resource"` (host-aware — MUST match the tunnel hostname, NOT 127.0.0.1).

  **Security regression check (H11 holds through the named tunnel).**

  **PowerShell:**
  ```powershell
  $bearer = (Get-Content "$env:USERPROFILE\.perplexity-mcp\daemon.token" | ConvertFrom-Json).bearerToken
  curl.exe -i -H "Authorization: Bearer $bearer" "https://<sub>.<zone>/daemon/health"
  ```
  **Bash:**
  ```bash
  curl -i -H "Authorization: Bearer $(jq -r .bearerToken ~/.perplexity-mcp/daemon.token)" "https://<sub>.<zone>/daemon/health"
  ```
  Expect: **HTTP 404**, not 200. Even with the correct daemon bearer, tunnel callers must be blocked from all `/daemon/*` admin routes. This is the v0.7.4 H11 contract — if the response is 200 OR 401, the H11 hardening regressed under the cf-named provider and this is a release blocker.

  **Port-drift YAML verification (load-bearing — 8.4.2 contract).**

  **PowerShell:**
  ```powershell
  Select-String "service: http" "$env:USERPROFILE\.perplexity-mcp\cloudflared-named.yml"
  ```
  Expect a line like `    service: http://127.0.0.1:<live-port>` where `<live-port>` ≠ 1. If it still reads port=1, the port-drift rewrite regressed — release blocker.

  Stop the daemon (Ctrl-C in the first terminal, or `npx perplexity-user-mcp daemon stop` from another) before step 7.

- [ ] **Step 7 — cf-named-list confirms the UUID appears.**

  **PowerShell:**
  ```powershell
  npx perplexity-user-mcp daemon cf-named-list --json
  ```

  Expect: stdout JSON `tunnels` array now includes an object with `uuid == <uuid>` and `name == "mcp-smoke-<date>"`. `connections` will be 0 now that the daemon has stopped.

- [ ] **Step 8 — CLEANUP. Delete the smoke tunnel + DNS route.**

  **Always run this step, whether the smoke passed or failed midway.** A stale tunnel + DNS route costs nothing but clutters your zone and blocks re-running the smoke with the same hostname.

  The `cloudflared` binary that landed in step 1 includes delete/route commands — our CLI doesn't surface delete yet (that's a future enhancement), so drive it directly.

  **PowerShell:**
  ```powershell
  $cf = "$env:USERPROFILE\.perplexity-mcp\bin\cloudflared.exe"
  & $cf tunnel delete <uuid>                 # if this fails with "has active connections", ensure daemon is stopped and retry; add --force as last resort
  # DNS route: cloudflared doesn't have a direct "delete route" for CNAMEs created via `tunnel route dns`.
  # Delete the `<sub>` CNAME manually in the Cloudflare dashboard: zone -> DNS -> Records -> find <sub>.<zone> -> Delete.
  Remove-Item "$env:USERPROFILE\.cloudflared\<uuid>.json" -ErrorAction SilentlyContinue
  Remove-Item "$env:USERPROFILE\.perplexity-mcp\cloudflared-named.yml" -ErrorAction SilentlyContinue
  npx perplexity-user-mcp daemon set-provider cf-quick   # reset active provider so the daemon doesn't try to start a deleted tunnel on next `daemon start`
  ```
  **Bash:**
  ```bash
  cf=~/.perplexity-mcp/bin/cloudflared
  "$cf" tunnel delete <uuid>
  rm -f ~/.cloudflared/<uuid>.json ~/.perplexity-mcp/cloudflared-named.yml
  npx perplexity-user-mcp daemon set-provider cf-quick
  ```

  **Verify cleanup:**
  ```powershell
  npx perplexity-user-mcp daemon cf-named-list --json
  ```
  Expect the `<uuid>` is gone from the array (if the smoke tunnel was the only one, the array is empty). Also open the Cloudflare dashboard → DNS → confirm `<sub>.<zone>` is gone; if it lingers, delete it manually.

  The origin cert at `~/.cloudflared/cert.pem` is zone-scoped and is safe to keep for future smokes; delete it only if you want to fully reset the machine's Cloudflare trust.

---

**Release gate for v0.8.1:** all 8 boxes checked OR step 8 cleanup executed AND a distinct waiver recorded in `docs/smoke-evidence/` + the release commit body stating that external provider smoke was not performed (stronger language than v0.8.0's waiver because the risk is external-API, not code-only).

Referenced by Task 8.4.5 in [docs/superpowers/plans/2026-04-22-phase-8-completeness.md](superpowers/plans/2026-04-22-phase-8-completeness.md).

## Phase 8.5 — Unified diagnostics + legacy debug cleanup (0.8.2)

Phase 8.5 replaces the pre-0.8.2 `debugCollector` infrastructure (three commands + a dedicated output channel + `DashboardState.debug` slice) with a single one-click diagnostics bundle: `Perplexity.captureDiagnostics`. The bundle is a redacted zip with the extension output channel (last 5000 lines via an in-memory ring), daemon log, last 1000 audit lines, inline doctor report, `daemon.lock.json` (bearer scrubbed), `tunnel-settings.json`, `oauth-clients.json`, `package-versions.json`, and `REDACTION_NOTES.md`. Automated tests cover the pure-function path (PEM redaction, zip entry count, bearer scrub); this smoke exists because an interactive save dialog + doctor probe + extension output integration can't be exercised hermetically.

Run on Windows 11 (primary) plus macOS 14+ / Ubuntu 22+ as available.

**Prereqs:**

1. Fresh VSIX installed at v0.8.2 or the consolidated 0.8.6 VSIX; reload VS Code window.
2. Profile logged in (only needed so the doctor probe produces an auth-positive section — an unauthenticated capture should still succeed with a `warn` overall).

- [ ] **Command palette entry exists.** Command Palette → type `Perplexity: Capture Diagnostics`. The entry is present and enabled.
- [ ] **Dashboard button exists.** Open the Perplexity dashboard → Home tab → Daemon status card. A **Capture diagnostics** button sits alongside the existing kill/restart actions. Click it.
- [ ] **Save dialog defaults correctly.** The OS save dialog opens with the default filename `perplexity-mcp-diagnostics-<ISO>.zip` under `~/Downloads`. ISO timestamp in the filename is readable (no `<ip>.278Z` regression).
- [ ] **Success toast offers "Show in folder".** On save, a VS Code info toast appears with a **Show in folder** action. Clicking it opens the enclosing directory via the OS file manager (Explorer / Finder / Nautilus).
- [ ] **Zip contents are correct.** Unzip the saved file. Confirm presence of all nine entries: the extension output channel text, daemon log, `audit.log.txt` (≤1000 lines), `doctor.json`, `daemon.lock.json`, `tunnel-settings.json`, `oauth-clients.json`, `package-versions.json`, `REDACTION_NOTES.md`.
- [ ] **Bearer is redacted in `daemon.lock.json`.** Open the zip's `daemon.lock.json`; the `bearerToken` field (if present) is replaced with `"<redacted>"` — NOT the live token. Cross-check by diffing against the raw `~/.perplexity-mcp/daemon.lock.json` on disk.
- [ ] **PEM blocks are redacted where they appear.** If you've run cf-named, `tunnel-settings.json` may reference cert material; open the zip's copy and confirm any `-----BEGIN CERTIFICATE-----…-----END CERTIFICATE-----` block is replaced with a `<redacted PEM block>` marker (or similar). `package-versions.json` should be untouched — it's allowlisted.
- [ ] **Legacy debug commands are GONE.** Command Palette searches for `Perplexity.debugStartSession`, `Perplexity.debugStopAndExport`, `Perplexity.debugExportAll` return **zero results**. The **Perplexity Debug Trace** output channel is no longer listed in the Output dropdown.
- [ ] **Legacy debug setting is GONE.** Settings UI search `Perplexity.debugBufferSize` returns zero results (legacy setting removed; the new ring is not user-configurable).
- [ ] **Cancel path releases the spinner.** Click the dashboard button, then cancel the save dialog. The dashboard's pending-action spinner clears (the daemon card returns to its normal idle state). No stuck busy state on any subsequent action click.
- [ ] **Bundle produces no secret leaks.** Run the no-secret-leak gate against a captured bundle: unzip, concatenate all text entries, and grep for the current daemon bearer. Expected: zero matches.
  ```powershell
  $bearer = (Get-Content "$env:USERPROFILE\.perplexity-mcp\daemon.token" -Raw | ConvertFrom-Json).bearerToken
  # Extract and concatenate zip entries — use Expand-Archive then Get-Content -Raw *
  Expand-Archive -Path "<saved-zip>" -DestinationPath "$env:TEMP\pplx-smoke-unzip" -Force
  Get-Content "$env:TEMP\pplx-smoke-unzip\*" -Raw | Select-String -SimpleMatch $bearer
  ```
  Expect: no output (no matches).

**Release gate for Phase 8.5:** all 10 boxes checked. This phase's surface is largely pure-function tested, so the smoke is primarily about confirming the command/button wiring and the interactive save dialog/doctor pipeline.

## Phase 8.6 — Transport picker (0.8.3 + 0.8.4 hotfix)

Phase 8.6 introduces a per-IDE MCP transport picker in the dashboard (radio group inside each auto-configurable IdeCard) with four options: `stdio-in-process`, `stdio-daemon-proxy` (default), `http-loopback`, `http-tunnel`. v0.8.3 shipped the UI + dispatcher; v0.8.4 hotfixed the wire between them (`http-loopback` static-bearer variant, capability-matrix `httpBearerLoopback=true` for every auto-configurable JSON IDE, `transport:select` handler, staleness detector, surfaced error modals, cf-named WAF banner). H3–H8 security prechecks (sanitized `.bak`, sync-folder detection, port-pin nudge, stability gates for http-tunnel, audit on every exit path) must hold across both.

Run on Windows 11 (primary) plus macOS 14+ / Ubuntu 22+ as available.

**Prereqs:**

1. Fresh VSIX installed at v0.8.4 or the consolidated 0.8.6 VSIX; reload VS Code window.
2. Profile logged in.
3. At least two auto-configurable IDEs available (e.g. Cursor + Claude Desktop) so the picker's "per-IDE" nature is exercisable.
4. For step 5 (sync-folder gate): a synced directory (OneDrive / Dropbox / iCloud) with a dummy IDE config you can point `Perplexity.syncFolderPatterns` at OR a real IDE whose mcp.json happens to live under a sync folder.

- [ ] **Picker renders for every IDE.** Open the dashboard → IDEs tab. Each auto-configurable IdeCard shows a 4-radio `TransportPicker` labelled stdio-in-process / stdio-daemon-proxy / http-loopback / http-tunnel. Unsupported options render disabled with an inline reason hint. Default selection is `stdio-daemon-proxy`.
- [ ] **http-loopback radios are ENABLED** (not greyed) for cursor, claudeDesktop, claudeCode, cline, windsurf, windsurfNext, amp, rooCode, continueDev, zed. This is the v0.8.4 capability-matrix flip.
- [ ] **http-tunnel radios are DISABLED** for every IDE (no `httpOAuthTunnel` evidence yet) with an inline reason tooltip pointing at the missing capability.
- [ ] **Pick http-loopback for one IDE → generate → config shape is correct.** Select http-loopback for, e.g., Cursor. Click Generate. Confirm `~/.cursor/mcp.json` now contains:
  ```json
  {
    "Perplexity": {
      "url": "http://127.0.0.1:<live-port>/mcp",
      "headers": { "Authorization": "Bearer <daemon-static-bearer>" }
    }
  }
  ```
  The `<live-port>` matches the current daemon lockfile port and `<daemon-static-bearer>` matches `~/.perplexity-mcp/daemon.token`'s `bearerToken` byte-for-byte.
- [ ] **Picker persists across reload.** Reload the VS Code window. Re-open dashboard → IDEs tab → the previously-picked `http-loopback` for Cursor is still selected (not reset to default). This proves `Perplexity.mcpTransportByIde` was written.
- [ ] **H4 sync-folder gate fires.** Configure `Perplexity.syncFolderPatterns` to match the path of a target IDE's mcp.json (or pick an IDE whose config legitimately lives under OneDrive/Dropbox). Pick http-loopback → Generate. A **VS Code warning modal** appears with default-deny wording ("This will write a daemon bearer to a file under a sync folder…"). Cancel → no write occurs. Accept → write proceeds; `.bak` of the prior content is sanitized (no bearer substring).
- [ ] **H3 sanitized `.bak` on rewrite.** Pre-populate a target IDE's mcp.json with a `bearerToken` or `Authorization: Bearer pplx_...` field. Run http-loopback Generate again (second time). Open the resulting `<configPath>.bak` — the bearer value is replaced with `<redacted>` (not the live token). On success, the `.bak` is deleted. Check tempfile POSIX / ACL: during the write window the tempfile has 0600 (Unix) or restricted ACLs (Windows icacls), never world-readable.
- [ ] **H8 audit on every exit.** After the preceding three items, tail `~/.perplexity-mcp/audit.log` and confirm at least one `applyIdeConfig` entry per attempted outcome: `ok`, `rejected-sync` (if you cancelled the sync-folder modal), `rejected-cancelled` (if you cancelled the confirm modal). `configPath` is home-redacted (`~/...`, not the absolute path).
- [ ] **Stale-config banner appears after daemon restart.** With at least one IDE configured http-loopback, click **Restart daemon** in the dashboard. On new port landing, the IDEs tab top-of-list shows a `"N config(s) contain(s) stale auth"` banner with a **Regenerate all** button. Per-IDE `Stale` chip appears on the affected IdeCard header.
- [ ] **v0.8.4 picker hotfix: `mcpTransportByIde` persistence works.** Before the hotfix this was `{}` no matter what you picked. After a pick + reload, `vscode.workspace.getConfiguration('Perplexity').get('mcpTransportByIde')` returns a populated object. Verify via a `Perplexity.captureDiagnostics` zip → check the output-channel text for `[staleness]` traces or a `transport:select` handler entry; OR open the VS Code settings.json for the workspace/user and confirm `Perplexity.mcpTransportByIde` has the entry.
- [ ] **Regenerate all from banner works.** Click **Regenerate all** in the stale-config banner. A single confirm modal appears (because the banner is a refresh of an already-approved `(IDE, transport)` pair, not a first-time write, per 0.8.5's auto-regen policy; if v0.8.3/0.8.4-only is installed, expect a modal per IDE). Each affected IDE's mcp.json is rewritten with the new port/bearer; banner clears on success. Audit lines carry the same `ok` shape as a manual generate.
- [ ] **Surfaced error modal on failure.** Induce a failure: pick http-tunnel for an IDE whose capability allows it (none ship this way — skip if no IDE has httpOAuthTunnel=true), OR set `Perplexity.daemonPort` to a port you've intentionally blocked, then Generate. A **VS Code error modal** appears with a reason-specific message + an **Open Output** action that reveals the Perplexity output channel. Expected reasons observed by the modal string: `unsupported`, `sync-folder`, `tunnel-unstable`, `port-unavailable`, `cancelled`, `error`.

**Release gate for Phase 8.6:** all 11 boxes checked. The v0.8.4 hotfix was itself driven by a smoke that found `mcpTransportByIde: {}`, so the persistence check is the load-bearing one; everything else verifies the security prechecks (H3/H4/H8) hold through both the 0.8.3 UI and the 0.8.4 wire.

## Phase 8.7 — Loopback-default + perf dashboard + tunnel-switch confirm + auto-regen + cf-named WAF banner (0.8.5)

Phase 8.7 covers the five UX shifts v0.8.4's smoke surfaced: (1) loopback-default mode with tunnels opt-in, (2) tunnel performance dashboard, (3) tunnel-switch confirmation modal + post-switch staleness refresh, (4) auto-regenerate stale MCP configs on port/tunnel change, (5) cf-named WAF warning banner. The first makes the extension usable out-of-the-box without touching a tunnel; the others prevent the "tunnel switched, my IDE still points at the old URL, I got silent 401s for an hour" class of footgun.

Run on Windows 11 (primary) plus macOS 14+ / Ubuntu 22+ as available.

**Prereqs:**

1. Fresh VSIX installed at v0.8.5 or the consolidated 0.8.6 VSIX; reload VS Code window.
2. For step 2 (tunnel opt-in flow): ability to enable at least one tunnel provider (cf-quick requires no auth; ngrok requires authtoken; cf-named requires cert + zone). cf-quick is recommended for this smoke because it needs no prereqs.
3. For step 6 (cf-named WAF banner): a cf-named provider already set up with `activeProvider === "cf-named"` AND `tunnel.status === "enabled"`. **If not available, mark this item "waived — no cf-named tunnel in the smoke environment" and rely on the automated 7 banner-component tests for coverage.**
4. For step 1 (fresh install default): a machine WITHOUT `<configDir>/tunnel-settings.json` (i.e. no prior Perplexity MCP install), OR delete the file + the `globalState.perplexity.enableTunnels.migrated` flag before the smoke.

- [ ] **Loopback-default on fresh install.** On a machine with no prior `tunnel-settings.json`, install 0.8.5+ and reload. Open the dashboard → Home tab. The TunnelManager card is collapsed to a single `RemoteAccessOptIn` card ("Enable tunnel options" button). `http-tunnel` is NOT a selectable radio in any IdeCard's TransportPicker (it's **removed**, not just disabled). Run Generate for any IDE and confirm the default transport in its mcp.json is stdio-daemon-proxy OR http-loopback with the static bearer (never http-tunnel). `Perplexity.enableTunnels` reads `false` via settings JSON inspection.
- [ ] **Upgrader migration preserves tunnel UI.** On a machine with a pre-existing `<configDir>/tunnel-settings.json` containing a non-empty `activeProvider`, install 0.8.5+ and reload. Open the dashboard → the full TunnelManager UI appears (not the opt-in card). `Perplexity.enableTunnels` reads `true` after activation. The `globalState.perplexity.enableTunnels.migrated` flag is set so the auto-migration is one-shot (re-installing doesn't run it again).
- [ ] **Tunnel opt-in flow.** From the loopback-default state (item 1), click **Enable tunnel options** on the opt-in card. `Perplexity.enableTunnels` flips to `true`; the full TunnelManager card replaces the opt-in card; `http-tunnel` radio returns to every IdeCard's TransportPicker (gated by the per-IDE capability, still disabled for most IDEs). At the bottom of TunnelManager a **Disable tunnel options** link is visible.
- [ ] **Tunnel opt-out confirm tears down active tunnel.** With a tunnel enabled and a provider selected, click the **Disable tunnel options** link. A VS Code modal fires. Accept → the tunnel is disabled atomically (the tunnel URL card clears) BEFORE `enableTunnels` flips to `false`. After the flip: dashboard shows the opt-in card again; `http-tunnel` is removed from pickers. Cancel path: modal dismissed, no changes.
- [ ] **Perf dashboard: enable durations per provider.** With tunnels enabled, enable + disable cf-quick (or any provider) three times. Expand the TunnelManager's TunnelPerformance section. The **Last enable durations** row shows a wall-clock ms value for that provider (cf-quick typically ~5.5s, cf-named ~1.5s, ngrok ~2s per the CHANGELOG). Switch to a second provider and enable → its own row populates. Values reset on VS Code reload (session-local ring buffer).
- [ ] **Perf dashboard: rolling health-check latency.** With a daemon running for >1 minute (enough to accrue ≥10 `/daemon/health` audit entries), the **Average health-check latency** row shows a single ms number. Reload the audit log — the value recomputes from the audit tail (last 10 entries).
- [ ] **Perf dashboard: MCP status ratios by source.** Trigger at least one `/mcp` tool call from a loopback-configured IDE AND, if a tunnel is enabled, one from a tunnel-configured IDE. Expand the **MCP /mcp status ratios** row. Two sub-rows appear (`loopback` + `tunnel`) with `ok / unauthorized / serverError / other` counts totaling over the last 200 audit entries.
- [ ] **High-401 warning fires when tunnel unauthorized ratio >10%.** This is hard to induce manually; if you can trigger ≥20 unauthenticated POSTs to `/mcp` through the tunnel (e.g. via `curl.exe` without a bearer), the perf dashboard emits a yellow **High tunnel 401 ratio** warning row below the stats. Skip if not easily inducible and rely on the automated component tests; mark this item "waived — covered by tunnel-performance component tests".
- [ ] **Tunnel-switch confirm modal.** With provider A active and tunnel enabled, switch to provider B in the TunnelManager. A **VS Code warning modal** appears naming both providers and explaining: (i) current tunnel will disconnect, (ii) MCP clients connected via the current URL will drop, (iii) IDEs configured http-tunnel will need regenerating. The text explicitly states **"http-loopback and stdio IDEs are unaffected."** Cancel → no provider change. Accept → provider flips, old tunnel tears down, new tunnel spins up.
- [ ] **Tunnel-switch is idempotent.** Re-select the currently-active provider in the TunnelManager. **No modal appears** (idempotent no-op). Dashboard state unchanged.
- [ ] **Post-switch staleness refresh.** After accepting a provider switch (item 9), within a second or two the IDEs tab's stale-config banner updates to reflect the new tunnel URL. Any IDE previously configured `http-tunnel` now shows a `Stale` chip. Proves `postStaleness` fires immediately after the switch per the CHANGELOG's `postDaemonState → postStaleness → auto-regen → postTunnelPerformance` chain.
- [ ] **Auto-regen on daemon restart (default setting).** Confirm `Perplexity.autoRegenerateStaleConfigs` defaults to `true` in the settings UI. With at least one IDE configured http-loopback, click **Restart daemon**. Wait for the new lockfile. Check `~/.cursor/mcp.json` (or equivalent): the `url` now reflects the new port; the `Authorization` header still carries the current daemon bearer. **No modal fires** (refresh of an already-approved `(IDE, transport)` pair). Audit log shows an `applyIdeConfig` entry with `auto=true` tag.
- [ ] **Auto-regen on tunnel-URL rotation.** With at least one IDE configured `http-tunnel` (requires an httpOAuthTunnel-enabled IDE — skip if none available in the smoke environment), disable + re-enable the tunnel so a new URL is minted. Expected: the IDE's mcp.json `url` is auto-updated to the new tunnel URL without a modal. Audit `auto=true`.
- [ ] **H4 sync-folder gate STILL fires under auto-regen.** Configure an IDE whose mcp.json lives under a sync folder (per 8.6 item 5) with http-loopback. Restart daemon. Expected: the default-deny modal still appears (H4 is preserved even during the silent refresh). Without it, the auto-regen would silently write bearer material to OneDrive — the CHANGELOG explicitly calls this out.
- [ ] **Auto-regen disabled via setting.** Flip `Perplexity.autoRegenerateStaleConfigs` to `false` in settings. Restart daemon. Expected: **no** auto-regen occurs; the stale-config banner appears instead (the user must click **Regenerate all** manually). Audit shows no `auto=true` entries.
- [ ] **cf-named WAF warning banner — manual swap if no cf-named available.** If the smoke environment has a cf-named provider enabled, open the dashboard → the TunnelManager card shows a **Cloudflare WAF warning banner** with: (i) the tunnel URL inline, (ii) an inline `Path = "/mcp"` WAF-skip-rule recipe, (iii) a link to `https://developers.cloudflare.com/waf/custom-rules/skip/`. The banner is not dismissable (Zone config is one-time). **If cf-named is NOT available**, mark this item "waived — no cf-named environment; covered by 7 banner-component tests (v0.8.4)".
- [ ] **Observability traces land in output channel.** Open the Perplexity MCP output channel. After a daemon restart or tunnel switch, two traces appear per staleness cycle:
  ```
  [staleness] checking <N> ides against daemonPort=<P> tunnelUrl=<U>
  [staleness] posted <N> stale config(s): <tag>(<reason>), ...
  ```
  Grepping the output channel proves the pipeline ran and what it found.

**Release gate for Phase 8.7:** all 16 boxes checked OR explicitly waived per-item rationale. Items 8 (high-401 warning) and 15 (cf-named WAF banner) are the likeliest to be waived because both require environment setup beyond the default smoke scope; waivers for either cite the automated component tests that cover them.

## Phase 8.8 — 0.8.6 release hardening

Phase 8.8 is the release-hardening patch that backs v0.8.6: it addresses the consolidated-smoke findings against 0.8.2–0.8.5 and closes the gap left by four untested releases. The surface is small (atomic auto-config rules-file writes, stale-lockfile reclaim, VSIX express-4.x invariant) but each item closes a real foot-gun that only shows up on long-running or crash-recovery scenarios.

Run on Windows 11 (primary) plus macOS 14+ / Ubuntu 22+ as available.

**Prereqs:**

1. Fresh VSIX packaged at v0.8.6 installed; reload VS Code window.
2. For step 3 (stale lockfile reclaim): ability to `SIGKILL` / end-task a running daemon process so it can't run its own shutdown path (Task Manager → End Task, or `kill -9 <pid>`).
3. For step 4 (express-4.x invariant): ability to inspect the packed VSIX. On Windows, 7-Zip or VS Code's built-in VSIX-explorer extension work; on macOS/Linux, `unzip` is enough.

- [ ] **Atomic auto-config rules-file write — marker integrity.** In `~/.claude/CLAUDE.md` (or any target that uses md-section upsert), manually **reverse** the marker pair: rename `PERPLEXITY-MCP-START` → `PERPLEXITY-MCP-END` and `PERPLEXITY-MCP-END` → `PERPLEXITY-MCP-START`, so the end marker now appears before the start marker. Leave the interior content alone. Run **Perplexity: Generate MCP Configs** → select this target.
  - **Pre-0.8.6 behavior (regression):** the upsert could not find a valid marker pair, so it either ate the interior content OR wrote a second marker pair leaving the reversed ones orphaned. File content outside the markers was at risk.
  - **Post-0.8.6 expected:** the extension detects the reversed markers as "no valid block present", **appends a fresh block** with correct markers at EOF, and **preserves every byte outside** the (broken) markers. The reversed markers remain in place verbatim (the extension doesn't touch them). Diffing the file pre/post-generate shows additions only — zero deletions to the pre-existing content.
  - Evidence: paste the pre/post file diff into the evidence file (or a `git diff` if the file is tracked).
- [ ] **Stale lockfile reclaim on restart after SIGKILL.** Start the daemon (via dashboard or `npx perplexity-user-mcp daemon start`). Find its PID from `~/.perplexity-mcp/daemon.lock.json`. `SIGKILL` it (Windows: `taskkill /F /PID <pid>`; Unix: `kill -9 <pid>`). `daemon.lock.json` remains on disk stale (the process couldn't run its own shutdown cleanup).
  - Click **Start daemon** in the dashboard (or run `npx perplexity-user-mcp daemon start`). Expected: the new daemon detects the stale lock (PID no longer alive), **reclaims and overwrites** it with its own PID + port + bearer, and starts cleanly. No "another daemon is already running" error. Lockfile's `pid` field now matches the new process.
  - Evidence: paste pre-kill lockfile JSON, kill command output, post-start lockfile JSON.
- [ ] **VSIX ships express 4.x.** Unpack the packaged VSIX (`packages/extension/perplexity-vscode-0.8.6.vsix`) and inspect `extension/dist/node_modules/express/package.json`. The `"version"` field must start with `"4."`. Express 5.x introduces behavior changes (async router, promise-based middleware signatures) that would break the daemon's OAuth routes silently.
  - **PowerShell:**
  ```powershell
  Expand-Archive -Path "packages\extension\perplexity-vscode-0.8.6.vsix" -DestinationPath "$env:TEMP\pplx-vsix-unpack" -Force
  (Get-Content "$env:TEMP\pplx-vsix-unpack\extension\dist\node_modules\express\package.json" -Raw | ConvertFrom-Json).version
  ```
  **Bash:**
  ```bash
  unzip -p packages/extension/perplexity-vscode-0.8.6.vsix \
    extension/dist/node_modules/express/package.json | jq -r .version
  ```
  Expect: a string starting with `4.` (e.g. `4.21.2`). Any `5.x` = release blocker — revert the offending dependency upgrade and re-pack.
- [ ] **Daemon shutdown under onShutdown failure — SKIPPED in manual smoke.** This is an internal-only path (an `onShutdown` hook throws; the daemon must still exit cleanly without hanging the process). Fully covered by `packages/mcp-server/test/daemon/` unit tests. Mark this item **"skipped — test-only"** in the evidence file; do not attempt to manually induce an `onShutdown` throw.

**Release gate for Phase 8.8:** items 1, 2, 3 checked; item 4 marked `skipped — test-only`. Item 3 (express 4.x) is automatable in CI; if CI is green on the packaged VSIX, item 3 can be recorded as `verified-ci` with the CI job link.

---

## Consolidated 0.8.2 → 0.8.6 final-smoke — required before tagging v0.8.6

Releases 0.8.2, 0.8.3, 0.8.4, and 0.8.5 all deferred their manual smoke per the execution strategy `docs/superpowers/specs/2026-04-24-phase-8-completion-execution-design.md`. 0.8.6 closes that loop: **do not tag v0.8.6 until a single consolidated smoke pass covering Phases 8.5 → 8.8 is recorded on Windows 11, macOS 14+, and Ubuntu 22+** (or each uncovered OS is explicitly waived in the release commit message with reason).

The three evidence skeletons for this consolidated smoke live at:

- [docs/smoke-evidence/2026-04-XX-v0.8.6-win11.md](smoke-evidence/) (rename `XX` to the day of smoke execution)
- [docs/smoke-evidence/2026-04-XX-v0.8.6-macos14.md](smoke-evidence/)
- [docs/smoke-evidence/2026-04-XX-v0.8.6-ubuntu22.md](smoke-evidence/)

Each skeleton carries the full checklist from Phase 8.5 through Phase 8.8 (this document's last four sections), ready for the tester to tick off. Per the release process in [docs/release-process.md](release-process.md): one fully-green platform + two waived platforms is acceptable if the waived platforms document a distinct reason (hardware unavailability, not "no time").

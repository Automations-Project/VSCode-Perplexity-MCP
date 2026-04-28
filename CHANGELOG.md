# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/).

## [Unreleased]

## [0.8.28] — 2026-04-28 — Pre-public impit coverage: login + export + models

> **Versioning note:** 0.8.20 through 0.8.27 were local pre-release iterations and were never tagged. The cumulative work (cloud-sync timeout fixes, retrieve-via-impit, search-pilot, plus the four phases below) is rolled into this release. Plan: [docs/impit-coverage-plan.md](docs/impit-coverage-plan.md).

### Added
- **Phase 1 — Impit-driven `perplexity_login` (auto mode), opt-in.** New runner at [packages/mcp-server/src/impit-login-runner.js](packages/mcp-server/src/impit-login-runner.js) drives the existing 6-step Perplexity email+OTP flow (csrf → sso check → signin/email → wait OTP → otp-redirect → callback) through impit instead of through a Patchright browser. The big visible Chrome window goes away on auto-login; OTP entry happens in the dashboard webview (existing UI) or CLI (`readline`-style prompt). Falls back to the existing browser runner on impit-only failures (`cf_blocked`, `impit_missing`, `impit_load_failed`, `auto_unsupported`, `crash`); user-facing failures (`otp_rejected`, `sso_required`, `email_rejected`) are surfaced directly. Gated behind `PERPLEXITY_EXPERIMENTAL_IMPIT_LOGIN=1` (env var) for the public release.
- **CF warmup helper** at [packages/mcp-server/src/cf-warmup.ts](packages/mcp-server/src/cf-warmup.ts). Brief headless Chromium launch (~1-2s, capped at ~12s) that captures `cf_clearance` for the impit pipeline. Skipped when the vault already has it. This is the only browser surface remaining in the impit-login pilot — Phase 7 (post-public) explores raw-impit Turnstile solving to drop it entirely.
- **`CookieJar` helper** at [packages/mcp-server/src/cookie-jar.js](packages/mcp-server/src/cookie-jar.js) (+ tests, 21 cases, all passing). RFC 6265-style Set-Cookie/Cookie round-trip used by the impit-login runner to capture session cookies across the OAuth callback redirect chain. Hand-rolled (no new npm deps) to honor the externalize-vs-bundle rules.
- **Phase 2 — CLI parity for impit-login.** `npx perplexity-user-mcp login --mode auto --email <addr>` honors the same `PERPLEXITY_EXPERIMENTAL_IMPIT_LOGIN=1` opt-in (or `--impit` flag) and falls back to the browser runner with the same reason set as the extension. `--no-impit` forces the browser path.
- **Phase 3 — `perplexity_export` impit fast path.** PDF / DOCX exports now go via two impit calls (entry-uuid resolve + `POST /rest/entry/export`) instead of through `page.evaluate`. Stable JSON contract — default-on, no env-var gate. Markdown remains a 100% local operation. Implemented as `exportThreadViaImpit` in [packages/mcp-server/src/client.ts](packages/mcp-server/src/client.ts).
- **Phase 4 — `perplexity_models` from-cache.** Reads `<configDir>/profiles/<name>/models-cache.json` directly via the new `readCachedAccountInfoFromDisk()` helper, bypassing browser init when the cache is populated by an earlier `refresh.ts` tier-fetch. Falls back to lazy `getClient()` on missing/empty cache. Anonymous accounts still go through init (their cache has no `modelsConfig`).

### Changed
- `parseSSEText`, `parseASIReconnectSSE`, `extractFromWorkflowBlock`, `parseASIThreadEntry` were promoted from `private` instance methods to `static` so the standalone impit helpers can share the same response-parsing source of truth as the in-class browser path.
- `auth-manager.ts` `runLogin` refactored into `runLogin` + `runOneRunner` to support the impit→browser fallback. Behavior identical when `PERPLEXITY_EXPERIMENTAL_IMPIT_LOGIN` is unset.
- `loadImpit` and `ImpitModule` are now exports of `refresh.ts` so the impit-login runner can construct an Impit client directly.

### Tests
- `cookie-jar.test.js` — 21 cases covering Set-Cookie parsing, Domain/Path matching, Expires/Max-Age, Secure/HttpOnly, replace-on-same-triple, and round-trip through `toPlaywrightShape()`.
- `getClient-retry.test.js` updated to set `PERPLEXITY_CONFIG_DIR` so the new cache-fast-path doesn't bypass the init() the test exercises.
- `stealth-args.test.ts` updated to accept `static extractFromWorkflowBlock` (was `private`).

## [0.8.19] — 2026-04-28 — Fix impit silent-empty + history-list cap consistency

> **Versioning note:** 0.8.18 was a local pre-release iteration and was never tagged.

### Fixed
- **Cloud-sync via impit was returning 0 rows on every call** while the same account had hundreds of threads on the web. Root cause: `listCloudThreadsViaImpit` POSTed without the Perplexity-specific request headers (`x-app-apiclient`, `x-app-apiversion`, `x-perplexity-request-endpoint`, `x-perplexity-request-reason`, `x-perplexity-request-try-number`) that Perplexity's frontend JS auto-injects on every same-origin fetch. The backend treats requests missing these as "no app context" and silently returns HTTP 200 with `[]` rather than 401 — so the sync looked successful but never imported anything. The browser path (`pageFetchJson`) was unaffected because Perplexity's own JS adds the headers when fetch fires from inside the page context. Discovered in 0.8.17 testing where every sync logged `list_ask_threads via impit: 0 rows (offset=0 limit=100 total=0)`.
- **History-list cap was inconsistent across actions in the dashboard.** `postHistoryList` in [DashboardProvider.ts](packages/extension/src/webview/DashboardProvider.ts) was called with `100` after rebuild / search / hydrate / profile-switch and `200` after cloud-sync; the default was `50`. On stores larger than 100 entries this made the visible total flip between actions — the source of the "stats change when I click rebuild / when I click from Claude" reports. All call sites now use a single 200-cap default.

## [0.8.17] — 2026-04-28 — Cloud-sync impit fast path + larger pages

> **Versioning note:** 0.8.13–0.8.16 were local pre-release iterations and were never tagged or published. The cumulative work (public-hardening followups: stealth-flag pruning, vault v3 KDF stretching, auto-config full tool list, CI heap + Windows browser-test fixes, webview-on-reload error catch) was rolled into this release alongside the cloud-sync work below.

### Added
- **Browser-free cloud-sync fast path via impit.** New `listCloudThreadsViaImpit` + `impitFetchJson` helpers in [client.ts](packages/mcp-server/src/client.ts) / [refresh.ts](packages/mcp-server/src/refresh.ts) skip the headless Patchright launch entirely when impit (Speed Boost) is installed and a session cookie is on disk. The daemon's `perplexity_sync_cloud` tool now passes `getClient` (lazy) instead of an already-init'd client so the browser is only spawned if impit misses on a page; the first miss in a run sticks. Per-page success logs as `[perplexity-mcp] list_ask_threads via impit: N rows ...` to make engagement easy to verify.
- **`with_temporary_threads: true`** in `list_ask_threads` POST body, matching the captured browser-side request.

### Changed
- **Cloud-sync default page size 20 → 100** ([cloud-sync.js](packages/mcp-server/src/cloud-sync.js), [client.ts](packages/mcp-server/src/client.ts)) — 5× fewer round trips per sync. `MAX_PAGES` lowered from 200 to 50 so the runaway cap is still ~5000 threads.
- `CloudSyncOptions` gains an optional `getClient` (lazy getter) used by the daemon to defer init until impit-fallback is needed; the `client` (eager) form is preserved for the CLI and other callers that already paid for init.

### Fixed
- **Stealth flags pruned** ([client.ts](packages/mcp-server/src/client.ts), [refresh.ts](packages/mcp-server/src/refresh.ts)) — `--disable-web-security`, `--disable-features=IsolateOrigins,site-per-process`, and `--disable-site-isolation-trials` removed; the rationale is documented inline. Same-origin in-page `fetch()` doesn't need them; the off-origin ASI download path moved to `APIRequestContext` (which inherits cookies but isn't subject to CORS) so the security cost was unjustified.
- **Vault v3 KDF stretching with scrypt** for passphrase-derived vaults; v1/v2 vaults migrate transparently on first unlock.
- **Auto-config rules block now lists all 14 tools** in the PERPLEXITY-MCP managed section so IDEs that read the rules file get an accurate inventory.
- **Extension webview `already registered` error** on host reload caught and logged instead of crashing activation.

### CI
- Tailwind oxide native binding force-installed on CI to work around npm/cli#4828.
- `NODE_OPTIONS` heap raised to 4GB for the tsup DTS worker.
- Browser-backed integration tests skipped on CI; per-OS test paths fixed.
- VSIX clean-check ignores vendored `.ts` under `node_modules`; tighter VSIX grep + platform-aware path validator.

## [0.8.12] — 2026-04-27 — Open-source readiness + vault v2 + responsive webview

### Added
- **HTTP-loopback transport for Codex CLI** with TOML bearer env headers in auto-config.
- **Vault v2 (salted format).** Passphrase-based vaults now use per-vault random salts for PBKDF2 key derivation; existing v1 vaults are migrated transparently on first unlock.

### Fixed
- **Browser Runtime card now populates on initial dashboard load.** `DashboardProvider.refresh()` was missing the `postAuthState()` call, so the BrowserSettings card stayed empty until an auth-state change event fired.
- **History tab cards resize with the sidebar** instead of clipping. Added `min-width: 0` to grid items, `overflow-wrap: anywhere` to text content, and constrained markdown code blocks to scroll within cards.
- **Pro tier inferred from ASI computer access** when Perplexity omits explicit tier data in login metadata.
- **Doctor now flags `code-insiders` command paths** and warns on non-node stdio command paths in IDE config audits.
- **Resolved node path passed to stdio config writers** and stale config regen to prevent path-mismatch issues.
- **Express alignment with SDK.** Daemon express setup aligned with `@modelcontextprotocol/sdk` internal expectations.
- **ASI workflow blocks** typed via discriminated union (refactor, no behavior change).

### Changed
- `packages/mcp-server` + `packages/extension` bump to `0.8.12`.
- Extension license aligned to MIT; publisher set to `Automations-Project`; "Internal" removed from display name and descriptions.
- NOTICE expanded to cover all significant runtime dependencies.
- README updated for public contributing workflow (PRs welcome, branch from main).

### Tests
- `audit-log-path`, `oauth-rate-limit`, `security-helpers` daemon tests.
- `login-tier-end-to-end` integration test for tier-inference fix.
- `vault.test.js` covers v1→v2 migration and salted-format round-trip.
- `validate-command`, `detect-ide-status-command`, `configure-targets-node-path` extension tests.
- `capabilities.test.ts` in shared package.

## [0.8.10] — 2026-04-26 — Hygiene cycle: Obscura revert + safe-write + page.evaluate + Windows CI + Express 5 alignment

> **Versioning note:** 0.8.6–0.8.9 were local pre-release iterations and were never tagged or published. The cumulative work was rolled into 0.8.10.

Broadens browser support from "Chrome or bundled Chromium, Windows/Linux-centric" to five runtimes with a usable UI contract across all three platforms; reverts the briefly-attempted Obscura CDP integration; and ships several Windows-friendliness fixes (atomic write helper, Singleton-lock cleanup, stale-version daemon reaper, Express 5 alignment) plus the first round of Windows CI.

### Added
- **Brave Browser detection** on Windows, macOS, and Linux. Treated as `channel: 'chromium'` with an explicit `executablePath`, which is how Patchright handles Chromium forks natively. Wired into both [mcp-server/config.ts::findBrowser](packages/mcp-server/src/config.ts) and the new [extension/browser/browser-detect.ts](packages/extension/src/browser/browser-detect.ts).
- **Microsoft Edge on macOS.** Previously only probed on Windows and Linux; the macOS `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` path is now in the candidate list.
- **`BrowserDownloadManager`** at [packages/extension/src/browser/browser-download.ts](packages/extension/src/browser/browser-download.ts). Drives `patchright-core install chromium` with `PLAYWRIGHT_BROWSERS_PATH` pointed at VS Code's per-extension globalStorage, parses progress from stderr, fires `onDidChange` events the dashboard can consume, supports clean removal, and SIGKILL-escalates on timeout so Windows never leaks a stuck download process.
- **Two new `PERPLEXITY_*` env vars** read by [mcp-server/config.ts](packages/mcp-server/src/config.ts):
  - `PERPLEXITY_BROWSER_PATH` — absolute path to any browser executable (supersedes legacy `PERPLEXITY_CHROME_PATH`, which still works).
  - `PERPLEXITY_BROWSER_CHANNEL` — `chrome` / `msedge` / `chromium`.
- **`AuthManager` browser orchestration** at [packages/extension/src/mcp/auth-manager.ts](packages/extension/src/mcp/auth-manager.ts): `attachDownloadManager`, `refreshBrowserDetection`, `setBrowserChoice`, and `syncProcessEnv` (writes the env vars onto `process.env` so the detached daemon spawned in [daemon/runtime.ts](packages/extension/src/daemon/runtime.ts) inherits the active selection). Runners spawned via `spawnRunner` receive the same env vars.
- **Shared wire types** in [packages/shared/src/messages.ts](packages/shared/src/messages.ts): `BrowserInfo`, `BrowserChoice`, `BrowserDownloadState`, `BrowserChannel`. `AuthState` now carries `browser`, `availableBrowsers`, `browserDownload`, `browserChoice` so a future dashboard browser-picker UI has everything it needs over postMessage.

### Changed
- **"Capture diagnostics" button moved from the Singleton Daemon panel to the Doctor tab header.** The action lives next to Run / Deep check / Export — the bundle includes a doctor report, so the Doctor tab is its natural home. The button now renders a spinner + "Capturing…" label while the file-save dialog and zip write are in flight (was previously silent), and is disabled while a doctor probe is running so concurrent IO doesn't race the report shipped inside the bundle. Tooltip rewritten to lead with "Bundle a redacted .zip … share this when filing a bug" so the purpose is obvious without hovering for context.
- `findBrowser()` probe order expanded to **Chrome → Edge (all platforms) → Chromium → Brave → override-via-env**. Signature `{ path, channel: "chrome" | "msedge" | "chromium" | "bundled" }` is unchanged; consumers that destructure only `path` are unaffected.
- `resolveBrowserExecutable()` return type extended with `channel: BrowserChannel` and distinguishes `system-brave` vs `system-chromium` in the `source` field. Old callers that only read `{ path }` still work.
- Error message in `resolveBrowserExecutable()` now mentions Edge and Brave as supported options and documents the new env-var names alongside the legacy `PERPLEXITY_CHROME_PATH`.
- Login runners (`login-runner.js`, `manual-login-runner.js`) now pass `channel` through to `chromium.launch` — previously they only forwarded the path, so `launch` fell back to its default behavior for msedge and Brave.
- `buildLaunchOptions()` in [client.ts](packages/mcp-server/src/client.ts) switched from `findChromeExecutable()` to `findBrowser()` so it can forward the detected channel; the headless `chromium.launch` call accepts `channel` when one is set.
- **`page.evaluate` call sites in `client.ts` converted from string-source to function form** (5 sites). The function form gives the bundler/typechecker visibility into the snippet, removes implicit-globals risk, and matches the Patchright API's preferred shape.
- **Express 4 → 5 alignment in `packages/mcp-server`.** Direct dep bumped from `^4.21.0` to `^5.2.1` to match what `@modelcontextprotocol/sdk@1.29.0` already pulls in transitively. Drops the dual-install (the daemon's nested express@4 and the SDK's root express@5 were coexisting on the shared `(req, res, next)` duck-type contract — the source of the 0.6.1 `req.originalUrl` vs `req.path` audit-log bug). Post-bump npm dedupes to a single express@5.2.1 at the root; `npm install` removed 25 nested packages. No source changes were required: every route in `daemon/server.ts` uses literal paths, no v4-only APIs remain, and `helmet@8.1.0` / `express-rate-limit@8.x` are already v5-compatible.

### Fixed
- **"Capturing…" spinner no longer sticks after the diagnostics zip is written.** Root cause: [packages/extension/src/diagnostics/flow.ts](packages/extension/src/diagnostics/flow.ts) awaited `vscode.window.showInformationMessage(...)` before returning the outcome, but VS Code info notifications without a button payload only resolve when the user clicks the X — so the dashboard's `action:result` was gated on the user dismissing the toast. The success / error notification calls are now fire-and-forget (`void Promise.resolve(...).catch(...)`), so the outcome returns the moment the file lands on disk. The "Show in folder" action button still works because the underlying VS Code lambda runs to completion in the background even after the flow returns.
- **Dashboard "Capture diagnostics" toast now offers a "Show in folder" affordance** matching the `Perplexity.captureDiagnostics` command-palette path. Clicking it dispatches `revealFileInOS` (with `openExternal` as a fallback) so users can jump straight to the saved zip without copying the path out of the toast.
- **Doctor probe (Deep check) no longer leaks visible Chrome windows.** Two related bugs in [packages/mcp-server/src/checks/probe.js](packages/mcp-server/src/checks/probe.js): (1) `client.init()` was outside the try/finally, so when init threw — most commonly when the headed Cloudflare bootstrap couldn't resolve in 20s, or when the headless launch was killed by AV mid-spawn — `client.shutdown()` was never called and the spawned chrome.exe (plus its visible window from the headed phase) was leaked; (2) the probe always ran the full headed bootstrap, opening a real visible browser on every Deep check click, so a sequence of failed probes would pile up windows. Fix: scope `PERPLEXITY_HEADLESS_ONLY=1` around the probe so it never opens a visible window (probe is a smoke test for the headless search path, which is what tools actually use), and move `client.init()` inside the try block so the finally always runs `client.shutdown()`. The env var is restored to its prior value in the same `finally`, so concurrent tool-call clients are unaffected. Existing dangling Chrome windows from before this fix must be closed manually.
- **Doctor `browser` check no longer pops a visible Chrome window on every run on Windows.** Root cause: [packages/mcp-server/src/checks/browser.js](packages/mcp-server/src/checks/browser.js) ran `chrome.exe --version` to read the version string, but on Windows Chrome forks itself when launched from a non-console parent (the VS Code extension host) — the original returns exit-code 0 with empty stdout (which is exactly why the doctor report's `chrome-family` message was blank), and the forked children stay alive as visible browser windows. Every `runDoctor()` call therefore leaked one window on Windows: clicking Run, Deep check, Capture diagnostics, or Export each opened a new Chrome window that never closed. Fix: on Windows, query the executable's `VersionInfo.ProductVersion` via `powershell.exe -NoProfile -NonInteractive -Command "(Get-Item -LiteralPath '<chrome.exe>').VersionInfo.ProductVersion"` with `windowsHide: true`. PowerShell reads the PE header — same string the user sees in File Properties → Details — without launching the browser. macOS / Linux still use `--version` (CLI app contract is honored there). Existing windows from before this fix must still be closed manually (`taskkill /IM chrome.exe /T`), but no new ones will spawn.
- **`safeAtomicWriteFileSync` helper + 7 call-site replacements.** New helper at [packages/mcp-server/src/safe-write.js](packages/mcp-server/src/safe-write.js) writes to a `${path}.tmp` staging file then `renameSync`s into place; on Windows that's `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, atomic with no `rmSync` window. On any failure the `.tmp` file is best-effort deleted and the original error rethrown. Replaces seven hand-rolled write+rename pairs across `daemon/local-tokens.ts`, `daemon/oauth-consent-cache.ts`, `daemon/server.ts`, `daemon/token.ts`, `daemon/tunnel-providers/cloudflared-named-setup.ts`, `daemon/tunnel-providers/index.ts`, `daemon/tunnel-providers/ngrok-config.ts`, and `vault.js` — eliminates a Windows race where a crash between `unlinkSync(target)` and `renameSync(tmp, target)` left no file on disk.
- **`clearStaleSingletonLocks` helper + integration in `client.ts`.** New helper at [packages/mcp-server/src/fs-utils.js](packages/mcp-server/src/fs-utils.js) unlinks Chromium's `SingletonLock` / `SingletonCookie` / `SingletonSocket` files from the persistent user-data-dir before launch. Chromium silently exits with code 0 when these files claim an active instance, so a stale lock from an unclean previous exit was breaking `launchPersistentContext` on every restart until the user manually wiped the profile.
- **Stale-version daemon reaper** at [packages/extension/src/daemon/stale-version.ts](packages/extension/src/daemon/stale-version.ts) (`isLockStale`, `removeStaleLock`, `killStaleDaemonPid`) wired into [daemon/runtime.ts](packages/extension/src/daemon/runtime.ts). When the extension activates against a daemon launched by an older bundled version, the helper SIGTERMs that pid and removes the lock so a fresh daemon can spawn. Older ESM module graphs pin hashed chunk filenames at startup; later upgrades overwrite those files on disk and dynamic imports for code-split chunks (e.g. `perplexity_doctor`'s `doctor-XXXXX.mjs`) fail forever. Any version difference (newer or older) is treated as "stale".
- **`getClient()` init-rejection retry** in [packages/mcp-server/src/daemon/server.ts](packages/mcp-server/src/daemon/server.ts). When a cached client's `init()` promise rejects, the cache is now invalidated so the next `getClient()` call constructs a fresh client instead of returning the rejected promise forever.

### Removed
- **Obscura runtime support** (briefly attempted on this branch). The h4ckf0r0day/obscura CDP server didn't expose the `Target.createTarget` / frame-attachment domains Patchright relies on, so the connect-over-CDP path could never bootstrap a usable session against it. All Obscura plumbing — `ObscuraManager`, `connectOverCDP` branches in client.ts / refresh.ts / health-check.js, the `obscura` channel in `BrowserChannel`, the `PERPLEXITY_OBSCURA_ENDPOINT` env var, and the `obscura` browser-icon — was ripped out. The migration shim that downgraded a saved `browserChoice.channel === "obscura"` to `mode: "auto"` was also removed since no released build ever shipped that channel.

### Tests
- New browser-detect / download-manager modules ship without dedicated tests in this commit. Follow-up work: unit tests for `AuthManager.resolveBrowserEnv` (table-driven).
- **`safe-write.test.js`** covers happy path, write-failure cleanup, AND a new rename-failure case where `writeFileSync(tmp)` succeeds but `renameSync(tmp, target)` fails because target is an existing directory — asserts the original target is preserved and the `.tmp` staging file is cleaned up.
- **`fs-utils.test.js`** covers `clearStaleSingletonLocks` happy / partial / missing-dir paths.
- **`getClient-retry.test.js`** in `packages/mcp-server/test/daemon/` covers the init-rejection re-creation path — first `getClient()` gets a rejected client, second call returns a fresh one.
- **`stale-version.test.ts`** in `packages/extension/tests/` covers `isLockStale` / `removeStaleLock` / `killStaleDaemonPid` including ESRCH and EPERM error-code handling.
- **`recordLoginSuccess` coverage** in `profiles.test.js` — three focused tests bringing `profiles.js` function coverage from 83.33% to 87.5%, restoring the 85% per-file floor enforced by `vitest.config.ts`.
- **`reauth-cycle.integration.test.js`** replaces a fixed 400ms wall-clock wait with condition polling up to a 5s deadline; under parallel vitest workers, event-loop pressure plus the watcher's 200ms debounce occasionally exceeded 400ms and produced false-negative `reinitFired === 0` assertions.

### CI
- **Windows CI matrix.** [.github/workflows/ci.yml](.github/workflows/ci.yml) extended from `{ubuntu-latest} × {node 20, 22}` to `{ubuntu-latest, windows-latest} × {node 20, 22}`. `shell: bash` pinned at the job level (windows-latest ships Git Bash preinstalled), `fail-fast: false` so a Windows-specific failure doesn't cancel the Linux legs. Surfaces the Windows-specific code paths (atomic-rename behavior, icacls token ACLs, backslash path handling, the new `safeAtomicWriteFileSync` helper) that were never exercised in CI before.

### Chore
- **Lockfile workspace-version sync.** `package-lock.json` mirror copies updated to track the four workspace `package.json` bumps from this cycle (extension/mcp-server: 0.8.5 → 0.8.10, shared: 0.1.0 → 0.1.2, webview: 0.1.3 → 0.1.5). Pure metadata sync — no dependency tree changes, no integrity-hash churn, no transitive resolution differences.

### Release gate
- Typecheck: green across all 4 packages.
- Full suite: **109 files / 942 pass + 2 skip** (no failures); per-file coverage thresholds clear after `recordLoginSuccess` coverage was restored.
- `npm audit --audit-level=high`: exit 0 (5 moderate remain in the postcss + uuid-via-vsce chain, out of scope).

## [0.8.5] — 2026-04-24 — UX polish: auto-regen + tunnel switching safety + perf dashboard + loopback-default

v0.8.4's smoke surfaced three UX gaps and two user-preference shifts: staleness never auto-healed, tunnel provider switches had no warning or performance visibility, and the tunnel UI was always-visible even for users who only use loopback. This release addresses all five, in that order.

### Added
- **Auto-regenerate stale MCP configs.** New setting `Perplexity.autoRegenerateStaleConfigs` (default **true**). When a daemon restart (port drift) or tunnel-URL rotation leaves a configured IDE's `mcp.json` pointing at dead values, the extension now automatically re-runs `applyIdeConfig` for each stale IDE with `confirmTransport` forced to `true` (this is a refresh, not a first-time write — the H5 intent was to guard surprise writes; the user already approved this (IDE, transport) pair). `warnSyncFolder` is preserved by reference so the sync-folder gate still fires. Audit entries for auto-regen writes carry `auto=true` to distinguish them from user-driven generates. Pure-function core at `packages/extension/src/webview/staleness-auto-regen.ts` so tests don't need any VS Code mock.
- **Staleness pipeline observability.** Pre/post-detection traces on `postStaleness`: `[staleness] checking <N> ides against daemonPort=<P> tunnelUrl=<U>` before detection and `[staleness] posted <N> stale config(s): <tag>(<reason>), ...` after the `transport:staleness` message is sent. Makes it possible to grep the Output channel to prove the pipeline ran + what it found.
- **Tunnel-switch confirmation modal.** Before `daemon:set-tunnel-provider` takes effect, a VS Code warning modal with both the current and next provider names, explaining that the current tunnel will disconnect, any MCP client connected through the current URL will drop, and any IDE configured for `http-tunnel` will need regenerating. **`http-loopback` and stdio IDEs are unaffected** is called out explicitly so the user knows the disruption is bounded. Default-confirm (`"Continue switching"` primary, `"Cancel"` secondary). Skipped when no tunnel is currently enabled OR the user re-selects the same provider (idempotent no-op). Pure helper at `packages/extension/src/webview/tunnel-switch-confirm.ts` — fully unit-tested, no VS Code mock needed. After the switch completes, `postStaleness` fires immediately so the banner reflects the new tunnel URL on next render.
- **Tunnel performance dashboard.** New `TunnelPerformance` component in the TunnelManager card shows:
  - **Last enable durations per provider** (session-local ring buffer; cf-named ~1.5s, ngrok ~2s, cf-quick ~5.5s observed in testing — visible now).
  - **Rolling average health-check latency** over the last 10 `/daemon/health` loopback hits from the audit tail.
  - **MCP `/mcp` status ratios by source** (loopback vs tunnel) over the last 200 audit entries: `ok / unauthorized / serverError / other`.
  - **High-401 warning hint** when tunnel unauthorized ratio exceeds 10%: directly surfaces CF WAF / OAuth misconfigurations without the user having to read audit logs.
  Data pipeline: `parseTunnelPerformance` pure parser in `packages/extension/src/webview/tunnel-performance.ts` + session-local `TunnelEnableRecorder` ring buffer in `tunnel-enable-recorder.ts` (extension-host scoped, resets on reload; provider ids + wall-clock ms only). New `tunnel:performance` outbound message + store slice. Renders nothing pre-hydrate; graceful empty-state for every sub-section.
- **Loopback-default mode + tunnels opt-in.** New setting `Perplexity.enableTunnels` (default **false**). When disabled, TunnelManager collapses to a single `RemoteAccessOptIn` card explaining what a tunnel is for and a single "Enable tunnel options" button. `http-tunnel` is also hidden from every IDE's TransportPicker (not just disabled — removed from the rendered radio group). When enabled, the full tunnel UI returns with a "Disable tunnel options" link at the bottom that fires a confirm modal and tears down any active tunnel atomically before flipping the setting.
- **Migration for existing users.** On first activation of 0.8.5, `migrateEnableTunnelsOnce` checks for an existing `<configDir>/tunnel-settings.json` with a non-empty `activeProvider` — if found AND the user hasn't explicitly set `enableTunnels` yet, the setting is auto-set to `true` so upgraders keep their familiar UI. One-shot, flagged by `globalState.perplexity.enableTunnels.migrated`.

### Changed
- `packages/mcp-server` + `packages/extension` bump to `0.8.5`.
- `DashboardProvider.postDaemonState` now runs a 3-step downstream chain after posting status: `postStaleness → auto-regen if enabled → postTunnelPerformance`. Each step is independently traced and individually try/catch-guarded so one failure doesn't poison the others.
- `TransportPicker` gains a `tunnelsEnabled` prop; `TunnelManager` gains a `settings` prop; `DaemonStatus` threads both from the store.
- `settings:update` handler intercepts `enableTunnels: false` to run the disable confirmation + tunnel shutdown flow before writing the setting. Co-sent keys in the same payload are still applied (the interceptor strips only `enableTunnels` from the partial if the user cancels).

### Security
- No new secrets surface. The static daemon bearer remains loopback-only (H11 from v0.7.4); auto-regen uses the same `getDaemonBearer` dep as manual generate. Sync-folder detection (H4) is preserved on the auto-regen path — an IDE whose `mcp.json` lives under OneDrive/Dropbox/etc. still triggers the default-deny modal, even during a silent refresh.
- Enable-history and health-latency metrics stored in-memory only; never persisted to disk; no plaintext tokens touched.

### Tests
- **805 passed / 94 files** — up from 742 / 86 at v0.8.4 (+63 new tests across the patch). Breakdown: 12 staleness-auto-regen (Wave 1), 7 tunnel-switch-confirm (Wave 2α), 29 tunnel-performance + recorder + component (Wave 2β), 15 loopback-default + migration + opt-in + picker-filter (Wave 3).

### Release gate
- Typecheck: green across all 4 packages.
- Full suite: 805 passed / 94 files.
- Secret-leak gate: clean on `.test-artifacts/vitest.log`.

## [0.8.4] — 2026-04-24 — Phase 8.6 hotfix: picker actually works

v0.8.3 shipped the transport picker UI + dispatcher but the wire between the two was severed — HTTP transport options looked clickable and landed in the picker but never persisted, and the capability matrix kept every HTTP option disabled for every IDE. Owner's smoke produced a diagnostics zip showing `mcpTransportByIde: {}` after picking HTTP in the UI and every audit line defaulting to `stdio-daemon-proxy`. This release closes the five gaps surfaced by that smoke.

### Added
- **`http-loopback` static-bearer variant.** New `bearerKind: "static"` on `TransportBuildInput`; `http-loopback` builder embeds `Authorization: Bearer <daemon-static-bearer>` when this kind is set. The daemon's static bearer is already accepted on loopback via Phase 8.2 H11's source-aware `verifyAccessToken`, so this transport now works out of the box for every IDE the picker can reach. Per-client scoped bearers (the `local-tokens.ts` primitives shipped in 8.6.1) remain for future work — the dispatcher's `bearerKind` decision now prefers `"static"` when `httpBearerLoopback` is the capability, and the `"local"` branch is unreachable until a future evidence-gated capability flip re-enables it.
- **Capability baseline.** `IdeMeta.capabilities.httpBearerLoopback` flipped `true` for every auto-configurable JSON IDE (`cursor`, `claudeDesktop`, `claudeCode`, `cline`, `windsurf`, `windsurfNext`, `amp`, `rooCode`, `continueDev`, `zed`). Evidence file: `docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md`. `httpOAuthLoopback` and `httpOAuthTunnel` remain `false` everywhere — those require the OAuth-discovery + RFC 8707 resource-binding evidence paths which are separate future work.
- **`getDaemonBearer` dependency** on `ApplyIdeConfigDeps`. Wired in `buildApplyIdeConfigDepsLive` to read `status.record.bearerToken` from the bundled daemon lockfile. Unit tests cover the error paths (null bearer → `ok: false, reason: "error"`; dep not provided → same shape).
- **`transport:select` + `transport:regenerate-stale` extension-host handlers** in `DashboardProvider`. The first persists the user's per-IDE choice to `Perplexity.mcpTransportByIde` via `vscode.workspace.getConfiguration().update(...)`, then re-posts the settings snapshot so the webview re-renders with the committed value. The second delegates to the existing `Perplexity.generateConfigs` command so both entry points (dashboard button and command palette) share the same modal + capability gates. Unit-testable via a new extracted `transport-select-handler.ts` helper following the repo's `bearer-reveal-gate.ts` pattern.
- **Staleness detector** at `packages/extension/src/webview/staleness-detector.ts`. Pure function that reads each auto-configurable IDE's mcp.json, extracts the Perplexity entry, and compares `url` / `headers.Authorization` against the live daemon port + tunnel URL + static bearer. Returns `{ ideTag, reason: "bearer" | "url" }[]`. Skips unreadable or malformed configs silently per IDE. Wired into `DashboardProvider.postDaemonState` so every daemon-state push triggers a fresh comparison; the result flows to the webview via `transport:staleness`, populating the `staleConfigs` slice added in 8.6.5 and finally making the "N configs contain stale auth" banner visible.
- **Surfaced error modals** in `Perplexity.generateConfigs`. The command handler now inspects `outcome.results`, groups failures, builds a reason-specific message per target, and surfaces via `window.showErrorMessage` with an "Open Output" action that reveals the Perplexity output channel. Covers `unsupported`, `sync-folder`, `tunnel-unstable`, `port-unavailable`, `cancelled`, `error` reasons. Previous behaviour: audit-only, silent to the user.
- **Cloudflare Named Tunnel WAF warning banner** in the dashboard's TunnelManager card. Fires when `activeProvider === "cf-named"` AND `tunnel.status === "enabled"`. Text: the tunnel URL inline, an inline `Path = "/mcp"` WAF-Skip-rule recipe, and a link to `https://developers.cloudflare.com/waf/custom-rules/skip/`. Not dismissable — the warning corresponds to a one-time Zone configuration; future "tested & working" state collapse is a deferred enhancement.

### Changed
- `packages/mcp-server` + `packages/extension` bump to `0.8.4`.
- `ApplyIdeConfigResult` audit line shapes expanded with the new `"static"` bearer-kind tag. The surfaced toast includes failure detail aggregated across targets; successful generates still post an info notice to the dashboard.

### Security
- **No design regression.** The static daemon bearer is now embedded in IDE `mcp.json` files only when the capability matrix allows http-loopback, and only for loopback URLs (`http://127.0.0.1:<port>/mcp`). The daemon has rejected static bearers over tunnel since Phase 8.2 H11; that invariant is unchanged here. `http-tunnel` continues to emit `{ url }` only — **no `headers` key, ever** — regardless of `bearerKind`.
- **H4 sync-folder detection** now also guards the new `"static"` bearer path (previously only `"local"` triggered it). If a user picks http-loopback for an IDE whose mcp.json lives under a sync folder, the same modal + default-deny still fires.

### Tests
- **742 passed / 86 files** — up from 705 / 83 at v0.8.3 (+37 tests across the patch). Breakdown: 7 http-loopback static-variant + 2 apply-ide-config static-branch error paths (Wave 1), 14 staleness-detector + 7 transport-select-handler + 2 apply-ide-config additional (Wave 2α), 7 cf-named WAF banner (Wave 2γ).

### Release gate
- Typecheck: green across all 4 packages.
- Full suite: 742 passed / 86 files.
- Secret-leak gate: clean on `.test-artifacts/vitest.log`.

## [0.8.3] — 2026-04-24 — Phase 8.6: MCP transport picker

Per-IDE choice between four MCP transports — `stdio-in-process`, `stdio-daemon-proxy` (default), `http-loopback`, `http-tunnel` — with capability-gated availability, security prechecks (H3–H8 from the 8.6 design), and a dashboard picker UI. **All HTTP capability flags start `false` across every IDE**; flipping one to `true` requires a dated `docs/smoke-evidence/*.md` file plus a committed generator golden fixture. As of 0.8.3 every IDE ships stdio-only — the contract, UI, and dispatcher are in place for individual HTTP capabilities to flip as evidence lands.

### Added
- **Four transport builders** at `packages/extension/src/auto-config/transports/`. Pure-function `build(input): McpServerEntry`; shared `TransportBuilder` / `TransportBuildInput` types, `UnsupportedTransportError` + `StabilityGateError` classes, and a `getTransportBuilder(id)` registry. `http-tunnel` emits `{url}` only — **never** a `headers` key, even when called with `bearerKind: "local"` (defense in depth against config leaking a bearer to a public URL). `http-loopback` supports both OAuth (headerless) and scoped-bearer-fallback variants. `stdio-daemon-proxy` (no `PERPLEXITY_NO_DAEMON` env var) is the shipped default.
- **`McpTransportId`, `MCP_TRANSPORT_DEFAULT`, `MCP_TRANSPORT_IDS`, `IdeCapabilities`** exported from `@perplexity-user-mcp/shared`. `IdeMeta.capabilities` populated for every IDE.
- **Three new settings** (`Perplexity.mcpTransportByIde`, `Perplexity.daemonPort`, `Perplexity.syncFolderPatterns`) + one new command (`Perplexity.regenerateStaleConfigs`).
- **Scoped local-bearer primitives** at `packages/mcp-server/src/daemon/local-tokens.ts`: `issueLocalToken` / `verifyLocalToken` / `revokeLocalToken` / `listLocalTokens`. Hash-at-rest at `<configDir>/local-tokens.json` (0600); plaintext returned once on issuance; constant-time compare via `crypto.timingSafeEqual`; revoked entries are returned by `list` but short-circuited in `verify`. `revoke` and `list` propagate disk I/O errors (control-plane paths); `verify` swallows them and returns null (fail-closed) so the auth hot-path can't crash. `lastUsedAt` write-back failures log-and-proceed rather than DOS the verify path. Token format: `pplx_local_<ide-sanitized>_<base64url24>`. Metadata id: `local-<ide>-<base64url8>`.
- **`applyIdeConfig` dispatch rewrite** with a structured `ApplyIdeConfigResult` discriminated union and `ApplyIdeConfigDeps` dependency injection for VS Code modals, git-tracked detection, audit sinks, and daemon-state readers. 11-step pipeline: capability gate → format gate → H4 sync-folder detect (only for http-loopback bearer branch) → H5 confirmation modal (workspaceState-remembered per `(ideTag, transportId)` pair) → bearer-fate decision → H6 port-pin nudge → local-token issuance → builder.build (H7 stability gates delegated to the http-tunnel builder) → **H3 sanitized `.bak`** (strip `bearerToken`/`token`/`secret`/`Authorization` keys + `pplx_*` / `"Bearer "` string values → `"<redacted>"`, write 0600, atomic rename, restore + delete on failure, unconditional delete on success) → H8 audit → return. `removeIdeConfig` got the same `.bak` hygiene. `writeJsonAtomic` + `writeTextAtomic` now open tempfiles 0600 AND call `applyPrivatePermissions` before rename so the pre-rename window is not world-readable.
- **TransportPicker** (`packages/webview/src/components/TransportPicker.tsx`) — radio group per IDE row, capability-gated disabled states with inline reasons, emits `transport:select`. Rendered inside every auto-configurable `IdeCard`.
- **BearerReveal** (`packages/webview/src/components/BearerReveal.tsx`) — extracted the 30s-TTL bearer-reveal row from DaemonStatus into a dedicated component. Props-controlled; returns null when `available === false`.
- **Stale-config banner** in the IDEs tab: when the store's `staleConfigs` slice is non-empty, shows `"N config(s) contain(s) stale auth"` with a **Regenerate all** button dispatching `transport:regenerate-stale`. Per-IDE `Stale` chip in each affected IdeCard header. Slice is hydrated by `transport:staleness` messages from the extension host; `null` = pre-hydrate, `[]` = explicit zero-signal.
- **Command palette entries.** `Perplexity.copyDaemonBearer`, `Perplexity.showDaemonBearer`, and `Perplexity.regenerateStaleConfigs` all reachable from the Command Palette. Phase 8.6.6 is fully covered by prior work — the first two shipped in 8.2 (v0.7.4) and the third in 8.6.2 (this release).

### Changed
- `IdeConfigOptions` gains `transportId?: McpTransportId` (defaults to `MCP_TRANSPORT_DEFAULT`). `configureTargets` is async and returns `{ statuses, results }` instead of just statuses.
- `DaemonStatus.tsx` no longer inlines the bearer-reveal UI — it renders `<BearerReveal>` and keeps the state + TTL tick logic.
- `packages/mcp-server` + `packages/extension` bump to `0.8.3`.

### Security
- **H3** — `.bak` can no longer harbor a bearer across a rotation. Applies to both `applyIdeConfig` and `removeIdeConfig`. Tempfile mode tightened to 0600 POSIX / icacls-restricted Windows so no write-then-rename window exposes the secret.
- **H4** — sync-folder detection fires a modal before any write that embeds a bearer. Well-known dirs (iCloud, OneDrive, Dropbox, Google Drive, Syncthing, pCloud), git-tracked trees (graceful fallback if git is missing), and user-supplied `Perplexity.syncFolderPatterns` regexes. `http-tunnel` and OAuth `http-loopback` are exempt because no secret is written.
- **H7** — `http-tunnel` generation rejects `cf-quick` (ephemeral URL) and `ngrok`-without-reserved-domain via the builder's `StabilityGateError`. Error reasons never include the tunnel URL.
- **H8** — audit line fires on every exit path: `ok`, `rejected-unsupported`, `rejected-sync`, `rejected-cancelled`, `rejected-tunnel-unstable`, `rejected-port-unavailable`, `error`. `configPath` is home-redacted (`~/...`).

### Tests
- **705 passed / 83 files** — up from 581 / 71 at the start of Phase 8.6 (+124 new tests across the sub-phase). Highlights: 14 local-tokens tests (incl. constant-time compare spy + malformed-file resilience + strict-revoke error propagation + resilient verify write-back), 45 transport builder tests (every gate path, URL normalization including the `/mcp/` double-append regression fix, headerless http-tunnel invariant), 18 `applyIdeConfig` tests (every H3–H8 path including sanitized-bak rollback, removeIdeConfig sanitized-bak, bearer-file 0600 mode), 22 UI tests (11 TransportPicker + 11 BearerReveal), 9 staleness-store + banner tests.

### Release gate
- Typecheck: green across all 4 packages.
- Full suite: 705 passed / 83 files.
- Secret-leak gate: clean on `.test-artifacts/vitest.log`.

## [0.8.2] — 2026-04-24 — Phase 8.5: unified diagnostics + legacy debug cleanup

### Added
- **`Perplexity.captureDiagnostics` command + dashboard button.** One-click diagnostics bundle for bug reports. Shows a save dialog defaulted to `~/Downloads/perplexity-mcp-diagnostics-<ISO>.zip`, then writes a redacted zip containing: the extension output channel (last 5000 lines via a new `OutputRingBuffer`), the daemon log, the last 1000 lines of `audit.log`, an inline `runDoctor` report, `daemon.lock.json` (bearer scrubbed), `tunnel-settings.json`, `oauth-clients.json`, a `package-versions.json` manifest, and `REDACTION_NOTES.md` explaining what was scrubbed. The "Show in folder" button on the success toast opens the enclosing directory via `revealFileInOS`. Dashboard button sits in the daemon card alongside the existing kill/restart actions.
- **`packages/extension/src/diagnostics/capture.ts`.** Pure-function `captureDiagnostics({ outputPath, configDir, extensionVersion, vscodeVersion, logsText?, doctorReport?, now?, fs? }): Promise<CaptureResult>`. Single atomic write; bundles through `jszip` (bundled into `dist/extension.js`, not shipped as a separate tree). All file reads dependency-injected for test hermeticity; all content except `package-versions.json` passes through the diagnostics redactor.
- **`packages/extension/src/diagnostics/redact.ts`.** Wraps the existing extension/server redactors with a PEM-block layer (`/-----BEGIN <TYPE>-----…-----END <TYPE>-----/g` with a backreferenced type token so adjacent blocks don't merge; PEM-first so cert bodies aren't half-eaten by the generic long-token rule). Exports `redactDiagnosticsString` / `redactDiagnosticsObject`.
- **`OutputRingBuffer`** at `packages/extension/src/diagnostics/output-buffer.ts`. 5000-line ring; `log()` and `debug()` tee every line into it after the existing `redactMessage` pass so snapshots are already scrubbed. Exposed via `getOutputRingBuffer()` for `captureDiagnostics` consumers.
- **Shared DI flow helper** at `packages/extension/src/diagnostics/flow.ts`. Same pattern as `webview/bearer-reveal-gate.ts` — one `runDiagnosticsCaptureFlow` drives both the command-palette entry and the dashboard message handler so save-dialog / doctor-probe / zip-write / result-post logic lives in one unit-testable place. Returns a discriminated `DiagnosticsFlowOutcome` so callers can signal spinner state correctly.

### Removed
- **Legacy `debugCollector` infrastructure.** Fully superseded by the unified capture path. Deleted: `packages/extension/src/debug/` (collector, exporter, instrumentation, stderr-parser), `packages/shared/src/debug.ts` and its re-export, the `Perplexity Debug Trace` output channel, the `dashboard.setDebugCollector` wiring, and the three commands `Perplexity.debugStartSession` / `Perplexity.debugStopAndExport` / `Perplexity.debugExportAll`. Removed settings: `Perplexity.debugBufferSize` (the new ring buffer is not user-configurable; 5000 lines is enough for a diagnostics snapshot and the ring never grows). `DashboardState.debug` removed from the shared contract.

### Changed
- **`DashboardProvider` routes `diagnostics:capture` inbound messages** to the same flow helper the command uses; posts the typed `diagnostics:capture:result` + maps outcome kind to `postActionResult` so the webview pending-action spinner releases on every outcome (ok / cancelled / error / throw).
- **Webview-side message contract:** inbound `{ type: "diagnostics:capture"; id: string }` on `WebviewMessage`; outbound `diagnostics:capture:result` discriminated union on `ExtensionMessage`. `ACTION_TYPES` registers the inbound so correlation-id tracking clears correctly.
- `packages/mcp-server` + `packages/extension` bump to `0.8.2`.

### Dependencies
- Added `jszip ^3.10.1` as a bundled dep (placed in `devDependencies` per the project's convention that runtime deps bundled into `dist/extension.js` live there, alongside `patchright` et al.; `prepare-package-deps.mjs`'s hardcoded `rootPackages` list controls what ships in `dist/node_modules/` and is unchanged).

### Tests
- **581 passed / 71 files** (up from 539 / 65 at the start of Phase 8.5; +42 new tests across 8.5.1/8.5.2; 8.5.3 was pure deletion — zero tests existed for the removed legacy debug infra). Breakdown: diagnostics-redact 11 (PEM variants + ordering + nested objects), diagnostics-capture 8 (happy path with 9 zip entries + missing-file markers + 1500→1000 audit tail + bearer scrub in daemon.lock + package-versions never-redacted + malformed-lockfile parse-error entry + PEM-in-tunnel-settings + bytesWritten matches `stat.size`), output-buffer 6, diagnostics-command 6, DashboardProvider.diagnostics 8 (baseline 4 + outcome-signalling 4: error → `postActionResult(false)`, cancel → `postActionResult(true)`, happy → `postActionResult(true)`, showSaveDialog throw → outer catch releases spinner), DaemonStatus.diagnostics 3 (button renders + click sends message + action-type registered).

### Release gate
- Typecheck: green across all 4 packages.
- Full suite: 581 passed / 71 files.

## [0.8.1] — 2026-04-24 — Phase 8.4: cloudflared named-tunnel provider

### Added
- **Cloudflare Named Tunnel provider (`cf-named`).** Third tunnel option alongside `cf-quick` (Cloudflare Quick Tunnels) and `ngrok`. Targets users with a Cloudflare-managed domain: one-time `cloudflared tunnel login` writes `~/.cloudflared/cert.pem`, then the dashboard walks through creating a named tunnel, installing a DNS CNAME on the user-chosen `<sub>.<zone>`, and writing a managed YAML config at `<configDir>/cloudflared-named.yml` (0600). Persistent URL, free Cloudflare Access OAuth + WAF + logs on top.
- **Setup helpers** (`daemon/tunnel-providers/cloudflared-named-setup.ts`). All spawn-based, injectable via the existing `dependencies.spawn` DI pattern — zero new npm deps. `runCloudflaredLogin` polls for the cert file on a 250ms tick (cloudflared login doesn't always exit cleanly after emitting the URL) and rejects up front if a cert already exists so we never spawn a stale-account login flow. `createNamedTunnel` parses `Tunnel credentials written to <path>.json` with a `\.json`-anchored regex so cloudflared's same-line advisory prose doesn't pollute the captured credentials path. `writeTunnelConfig` uses the tempfile + rename + icacls/chmod pattern from `ngrok-config.ts` so the managed YAML (references sensitive credentials) lands 0600 atomically.
- **Dashboard setup widget.** New missing-binary / missing-cert / missing-config / missing-credentials / ready states, each with distinct recovery actions (install binary, run cloudflared login, create-new / bind-existing / list-existing forms). The missing-credentials state explicitly offers recovery rather than dead-ending at a red banner — user feedback during smoke showed corrupted `<uuid>.json` pointers hitting a click-nothing screen in the first pass; 843759b added recovery forms + explicit copy naming the managed YAML path.
- **CLI mirrors.** `perplexity-user-mcp daemon cf-named-login` / `cf-named-create` / `cf-named-list` / `cf-named-install` / `cf-named-delete` / `cf-named-unbind`. Each wraps the same runtime helpers the dashboard uses, forwards cloudflared's stderr + stdout to parent stderr so the browser-login URL is visible in the terminal, and preserves stdout JSON discipline.
- **Message transport.** Shared contracts for `daemon:install-cloudflared`, `daemon:cf-named-login`, `daemon:cf-named-create`, `daemon:cf-named-list`, `daemon:cf-named-delete`, `daemon:cf-named-unbind`. ActionTypes now stamps correlation ids on all six so pending-action tracking clears correctly when `…:result` fires.

### Changed
- **`start()` rewrites the managed YAML with the current daemon port on every invocation.** The daemon uses OS-assigned ports and picks a different one on almost every restart, so the persisted port is nearly always stale. Missing this rewrite would route cloudflared to a dead port on each reconnection; idempotent writes are cheap.
- **`deriveCfNamedState` checks credentials-file-not-found before any cert keyword.** The earlier ordering routed a corrupted-credentials-path error containing the substring "origin certificate" to `missing-cert`, putting the UI into a login-button loop (login rejected because cert existed → UI unchanged). Specific-state-wins ordering plus tightening the cert alternation to the exact phrase "origin cert not found" closes that loop.
- **`TunnelProviderId` extended** from `"cf-quick" | "ngrok"` to include `"cf-named"`. Provider registry gains the new entry.
- `packages/mcp-server` + `packages/extension` bump to `0.8.1`.

### Tests
- **539 passed / 65 files** — up from 433 / 60 at the start of Phase 8.4 (+106 new tests). Breakdown: mcp-server daemon (setup helpers + provider lifecycle + port-drift + login flow + CLI paths) ~60; extension dashboard (`DashboardProvider.cf-named.test.ts`) + ActionTypes pin ~10; webview (`DaemonStatus.cf-named.test.tsx` + `DaemonStatus.test.tsx` state-machine regressions + AuthorizedClients harness update) ~36.

### Release gate
- Typecheck: green across all 4 packages.
- Full suite: 539 passed / 65 files (32.88s).

## [0.8.0] — 2026-04-23 — Phase 8.3: stdio launcher → daemon-proxy

### Added
- **`attachToDaemon` programmatic API re-exported from `perplexity-user-mcp`'s main entrypoint.** The bundled `dist/mcp/server.mjs` now exposes it so the extension launcher can reach it via the `bundled-path.json` indirection without adding a CLI child-process.
- **`--fallback-stdio` and `--ensure-timeout-ms <N>` flags on `daemon attach`.** When `--fallback-stdio` is set and the daemon cannot be reached within the ensure-timeout, the CLI writes a single stderr warning (`[perplexity-mcp] daemon unreachable (...); falling back to in-process stdio`) and drops through to the in-process stdio `main()` so the client still gets a working server.
- **`PERPLEXITY_NO_DAEMON` env opt-out.** When set to `1` / `true` (case-insensitive, trimmed), both the stdio launcher AND `daemon attach` CLI bypass the daemon and run a pure in-process stdio server. Warning goes to stderr only (stdout is reserved for MCP JSON-RPC framing).

### Changed
- **Generated stdio launcher (`~/.perplexity-mcp/start.mjs`) now multiplexes every external stdio MCP client (Claude Desktop, Cursor, Cline, Codex CLI, Amp, …) onto the shared daemon via `attachToDaemon({ fallbackStdio: true })`.** Pre-0.8.0, each client spawned its own in-process stdio server + Chromium. Post-0.8.0, N clients = 1 daemon + 1 Chromium. The launcher passes a `runStdioMain` DI shim pointing at the already-loaded `server.main` so the fallback path works correctly in the extension-bundled layout (where `attach.ts` is inlined into `server.mjs` and the default `import("../index.js")` would resolve to a nonexistent sibling).
- **`ensureLauncher` now force-updates stale `start.mjs` content.** Byte-for-byte comparison + rewrite on mismatch. Users upgrading from 0.7.x will automatically migrate to the new daemon-proxy launcher on next activation, without needing to reinstall the extension.
- `packages/mcp-server` + `packages/extension` bump to `0.8.0`.

### Tests
- 13 new tests across the phase (8.3.1–8.3.3): 2 in `packages/mcp-server/test/daemon/attach.test.js` (fallback-stdio path + hard-failure preservation when fallback is disabled), 5 in `packages/mcp-server/test/cli.test.js` (PERPLEXITY_NO_DAEMON opt-out contract + stdout discipline), 6 in `packages/extension/tests/write-launcher.test.ts` (launcher content shape + force-migration from 0.7.x). Total: 433 passed / 60 files (up from 420 / 59 at start of Phase 8.3).

### Release gate
- Typecheck: green across all 4 packages.
- Full suite: 433 passed / 60 files.
- VSIX: `packages/extension/perplexity-vscode-0.8.0.vsix`, ~11.7 MB (12,252,644 bytes), 3419 files. `grep -c "attachToDaemon" dist/mcp/server.mjs` = 2 (confirms the re-export reached the bundle).

## [0.7.4] — 2026-04-23 — Phase 8.2: security hardening + authorized clients panel

### Security
- **H0 — Closed live bearer-in-logs leak.** `DaemonStatusState.bearerToken` is removed; replaced with `bearerAvailable: boolean`. The webview never receives the raw daemon bearer on state pushes. New explicit one-shot channels `daemon:bearer:copy` (extension-host clipboard write; bearer never touches the webview) and `daemon:bearer:reveal` (modal-confirmed 30s-TTL reveal with nonce). A redactor now wraps all log sinks (extension `log` / `debug`, the `log:webview` forwarder, and daemon `[trace]` paths). New CI gate `scripts/assert-no-secret-leak.mjs` scans captured test logs for known secret shapes — zero hits required per release.
- **H11 — Admin surface locked to loopback.** Every `/daemon/*` endpoint now returns `404 Not Found` to tunnel callers regardless of bearer validity. Tunnel path allowlist: `/mcp`, `/`, `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/{oauth-authorization-server,oauth-protected-resource}`, `/robots.txt`, `/favicon.ico`. New `attachRequestSource` middleware derives `loopback` vs `tunnel` from real network indicators only (`X-Forwarded-For`, `CF-Connecting-IP`, `req.ip`); the `x-perplexity-source` header is still captured for audit enrichment but is never consulted for security decisions.
- **H12 — RFC 8707 resource binding.** OAuth tokens now carry a `resource` binding captured at `/authorize`, validated on both code- and refresh-grant exchanges at `/token`, and enforced at `/mcp`. The static daemon bearer is loopback-only. The tunnel rejects OAuth tokens whose bound resource mismatches the incoming request AND tokens with no bound resource; the loopback path accepts unbound tokens (tagged `oauth-unbound`) strictly for migration of pre-0.7.4 clients. SDK-aligned signatures: `exchangeAuthorizationCode(client, code, codeVerifier?, redirectUri?, resource?)` and `exchangeRefreshToken(client, refreshToken, scopes?, resource?)`. One canonical `resolveRequestResource(req)` helper is used by PRM, code/token binding, and `/mcp` verification. Consent cache keys now include the resource so a client that re-authorizes against a different tunnel URL re-prompts.

### Added
- **Authorized OAuth clients dashboard panel.** A new card below daemon status shows every client registered via `/register` with its client ID, last-used timestamp, consent approval timestamp, and active token count. Per-row **Revoke** (modal confirm, invalidates all outstanding tokens for that client) and a card-level **Revoke all** (modal lists every affected client). Local-bearer rows land in Phase 8.6.
- **`Perplexity: Copy Daemon Bearer` command.** Modal-confirm, then `vscode.env.clipboard.writeText` on the extension host — the bearer never leaves the host process.
- **`Perplexity: Show Daemon Bearer (30s)` command.** Modal-confirm, then a one-shot reveal to the dashboard with a 30s TTL and auto-clear.
- **`/daemon/oauth-clients` endpoints.** `GET` lists authorized clients; `DELETE` revokes by `clientId` or wipes all. Static-bearer gated and loopback-only per H11.
- **H12 follow-up: consent-binding.** Cached consents are now keyed by `(client_id, redirect_uri, resource)` so a client re-authorizing against a different tunnel URL re-prompts the modal instead of inheriting the prior consent.
- **`scripts/assert-no-secret-leak.mjs`.** Node (Windows-first) CI gate that scans captured test logs for known secret shapes plus env-provided canary values.

### Changed
- `packages/mcp-server` + `packages/extension` bump to `0.7.4`.
- `AuditEntry.auth` union gains `oauth-cached` (Phase 8.1) and `oauth-unbound` (Phase 8.2) — cached-consent approvals and legacy unbound-token loopback paths are now distinguishable in audit lines.
- `DaemonStatusState` shape change: `bearerToken: string | null` removed, `bearerAvailable: boolean` added. All webview consumers updated; the bearer is requested explicitly via the new copy / reveal channels.

### Tests
- 179 passed (29 files) — up from 43 at the start of Phase 8.2; 136 new tests across the phase. Breakdown: daemon + OAuth conformance + resource binding + consent-cache + tunnel allowlist + admin endpoints (~122), extension-host redaction + bearer-reveal + auto-config + auth-manager + history + doctor (~43), webview AuthorizedClients panel + DaemonStatus bearer-reveal TTL + ActionTypes pin (~14).

### Breaking
- Pre-0.7.4 OAuth tokens minted without a `resource` binding are **rejected over the tunnel** post-upgrade. Legacy external clients (Claude Desktop / Cursor / Cline connected over the tunnel) must re-authorize and include an RFC 8707 `resource` parameter at `/authorize`. Loopback callers are unaffected — the daemon accepts unbound tokens on `127.0.0.1` strictly for migration and tags them `oauth-unbound` in audit.

## [0.7.3] — 2026-04-22 — Phase 8.1: OAuth consent cache

### Added
- **OAuth consent cache.** The daemon now remembers per-(client_id, redirect_uri) consents so Claude Desktop / Cursor / Cline don't re-prompt a VS Code modal on every ~1h token-refresh cycle. Cache lives at `<configDir>/oauth-consent.json` (0600). Default TTL 24h, configurable via the new `Perplexity.oauthConsentCacheTtlHours` setting. `0` disables the cache (modal every time); max 720h (30d).
- **Admin endpoints** for inspecting and clearing the cache:
  - `GET /daemon/oauth-consents` returns `{ consents: [{ clientId, redirectUri, approvedAt, expiresAt }] }`.
  - `DELETE /daemon/oauth-consents` revokes by body `{ clientId, redirectUri? }`; empty body revokes everything. Returns `{ ok, removed }`.
  Static-bearer gated only (no OAuth-token path) so no OAuth client can inspect or wipe another's consents.
- **Launcher helpers** `listOAuthConsents`, `revokeOAuthConsent`, `revokeAllOAuthConsents` (new subpath export `perplexity-user-mcp/daemon`) plus matching `listBundledOAuthConsents` / `revokeBundledOAuthConsent` / `revokeAllBundledOAuthConsents` on the extension runtime.
- **Dashboard message transport** wired for a future 8.2 UI panel — `daemon:oauth-consents-list`, `daemon:oauth-consents-revoke`, `daemon:oauth-consents-revoke-all` inbound, `daemon:oauth-consents` outbound.

### Changed
- `PerplexityOAuthProvider.revokeClient` now also purges that client's cached consents so a future re-registration with the same `client_id` can't silently inherit stale approvals.
- `AuditEntry.auth` gains `oauth-cached` — audit lines for cache-driven auto-approvals are distinguishable from both unauthenticated and fresh-modal approvals.
- `ExtensionSettingsSnapshot` gains `oauthConsentCacheTtlHours` for future UI surfacing.
- `packages/mcp-server` + `packages/extension` bump to `0.7.3`.

### How it wires up
- Extension reads the setting and writes `PERPLEXITY_OAUTH_CONSENT_TTL_HOURS` into the daemon spawn env. The provider reads it live per `/authorize` so toggling the setting takes effect on the next OAuth handshake without a full daemon restart.
- On cache hit: `authorize()` skips the consent modal, logs `[trace] oauth consent cache hit clientId=… redirectUri=…`, fires `onConsentCacheHit` so `server.ts` can flip the audit tag, and issues the authorization code.
- On fresh approval (cache miss + user approves): cache entry written with the current TTL.
- On denial: cache is NOT written.

## [0.7.2] — 2026-04-22 — One-click ERR_NGROK_334 recovery

### Added
- When the tunnel error row shows an `ERR_NGROK_334` message (reserved-domain server-side lockout), two new buttons now appear inline:
  - **Try ephemeral URL** — clears the saved ngrok domain and retries Enable immediately. Use this to unstick the tunnel without losing your authtoken.
  - **Open ngrok endpoints page** — direct link to `dashboard.ngrok.com/endpoints` (the authoritative page for account-level endpoint state, distinct from the Tunnels page which often shows empty while the endpoint is still registered).

### Context
0.7.1 traces confirmed the 334 conflict is **server-side**: a fresh daemon with a different PID + fresh ngrok SDK instance still gets rejected on bind, which means the reservation is held by ngrok's server regardless of what we do locally. The two fixes available to end users are wait out the grace period or stop the endpoint manually — these buttons shortcut both paths.

### Changed
- `packages/mcp-server` + `packages/extension` bump to `0.7.2`.

## [0.7.1] — 2026-04-22 — ngrok lifecycle hardening + Kill daemon button

### Fixed
- **ERR_NGROK_334 ("endpoint already online") now recovers cleanly.** The ngrok provider now calls `ngrok.kill()` immediately before `ngrok.forward()` so any in-process listener from a prior enable cycle is torn down before the new one registers. The remaining ~60s grace period is server-side ngrok state we can't short-circuit, but errors now carry a specific actionable message ("Wait ~60 seconds for ngrok's server to release it, then click Enable again. Or: use the Kill daemon button…") instead of the raw upstream error.
- **Friendly error translations** for the three most common ngrok failure codes:
  - `ERR_NGROK_334` — domain conflict (see above).
  - `ERR_NGROK_105` — invalid authtoken.
  - `ERR_NGROK_108` — free-tier one-session cap violated by another device.

### Added
- **"Kill daemon" button** (`daemon:kill`) next to Restart. Confirmation modal; on approval the extension runs `stopDaemon({ force: true })` which:
  - Attempts graceful `POST /daemon/shutdown`.
  - If the daemon doesn't respond within 3s, signals the lockfile's pid with `SIGTERM` then `SIGKILL`.
  - Releases the lockfile so the next Enable spawns a fresh daemon.
  - Does NOT auto-respawn; the user explicitly controls via Restart afterwards.
- **Auto-prompt to re-enable after ngrok setting changes.** When the user updates the ngrok authtoken or reserved domain while a tunnel is live, a VS Code info-toast offers to disable + re-enable the tunnel so the new settings apply immediately. Pick "Later" to defer.

### Changed
- `packages/mcp-server` + `packages/extension` bump to `0.7.1`.
- `stopDaemon` signature gains an optional `force: boolean` flag; return type adds `forced: boolean`. Existing callers (`restartDaemon`) keep working.

### Known limitation (not fixed here)
- We can't auto-populate the ngrok reserved-domain dropdown from the account — ngrok's agent authtoken and their REST API key are separate credentials. Adding domain-listing would require a second UI field for the API key; deferred until we see whether users actually want that (vs. typing the domain).

## [0.7.0] — 2026-04-22 — Phase 7: pluggable tunnel providers (ngrok) + public-surface hardening

### Added
- **Pluggable tunnel-provider registry** (`packages/mcp-server/src/daemon/tunnel-providers/`):
  - `cf-quick` — existing Cloudflare Quick Tunnel, default, ephemeral `*.trycloudflare.com` URL.
  - `ngrok` — persistent URL via the **official `@ngrok/ngrok` NAPI binding** (no binary download, no child-process management). Free-tier accounts get one reserved `*.ngrok-free.app` domain that persists across daemon restarts.
- **Dashboard provider picker** — new dropdown in the daemon card swaps between providers. When ngrok is selected but unconfigured, an inline setup widget prompts for the authtoken with a direct link to the ngrok dashboard; optional reserved-domain input afterwards.
- **CLI commands** for the same flows:
  - `npx perplexity-user-mcp daemon list-providers [--json]`
  - `npx perplexity-user-mcp daemon set-provider cf-quick|ngrok`
  - `npx perplexity-user-mcp daemon set-ngrok-authtoken <token>`
  - `npx perplexity-user-mcp daemon set-ngrok-domain <domain>`
  - `npx perplexity-user-mcp daemon clear-ngrok`
- **Persistence:** provider choice in `<configDir>/tunnel-settings.json`; ngrok credentials in `<configDir>/ngrok.json` (0600 POSIX / icacls ACL on Windows, mirroring daemon.token).

### Hardening (bundled with Phase 7)
- **`helmet` middleware** on every HTTP request — sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, `X-Download-Options`, `Referrer-Policy`, etc. HSTS deliberately off (our origin is HTTP; the tunnel edge supplies TLS).
- **`trust proxy=1`** set on the express app — resolves the `ValidationError: X-Forwarded-For` warnings the daemon emitted on every tunnel request and lets `express-rate-limit` correctly identify source IPs.
- **Per-IP rate limit on the OAuth endpoints** (`/authorize`, `/register`, `/token`, `/revoke`). Tunnel traffic only; 30 req/min per source IP. Prevents bulk dynamic-client-registration abuse on a leaked tunnel URL.

### Changed
- `packages/mcp-server` + `packages/extension` bump to `0.7.0`.
- New deps: `@ngrok/ngrok` ^1.7.0, `helmet` ^8.1.0. Both added to `prepare-package-deps.mjs` rootPackages so they ship in the VSIX's `dist/node_modules/`.
- New subpath export: `perplexity-user-mcp/daemon/tunnel-providers`.

## [0.6.1] — 2026-04-22 — OAuth flow hotfix: dynamic WWW-Authenticate + root path MCP

### Fixed
- **Claude Desktop OAuth flow now completes.** 0.6.0's `/mcp` bearer middleware did not emit a `resource_metadata` parameter in the `WWW-Authenticate` 401 header (the SDK's `requireBearerAuth` captures `resourceMetadataUrl` at construction time, but our PRM URL is tunnel-host-dependent). Claude Desktop couldn't discover PRM and fell back to POSTing at the bare tunnel URL, which 404'd, producing `Authorization with the MCP server failed` after a successful consent. Replaced with a custom bearer wrapper that reads `req.headers.host` on each 401 and emits `resource_metadata="https://<tunnel>/.well-known/oauth-protected-resource"` dynamically.
- **Bare-URL forgiveness.** The `/mcp` MCP handler is now mounted at `/` as well. Users who paste the tunnel URL into their client config without `/mcp` suffix still work. A sniffer on the root route forwards `POST /` + JSON/SSE `Accept` to the MCP handler and keeps the branded homepage for browser `GET /`.
- **Audit log paths were wrong.** Every request going through `mcpAuthRouter`'s sub-routers was logged as `POST /` or `GET /` because `req.path` is mount-relative. Switched to `req.originalUrl` so `/register`, `/token`, `/authorize`, `/revoke`, `/.well-known/*` appear correctly in `audit.log`.

### Changed
- `packages/mcp-server` and `packages/extension` bump to `0.6.1`.

## [0.6.0] — 2026-04-22 — Phase 6b: OAuth 2.1 authorization server

### Added
- **OAuth 2.1 authorization server**, implementing the MCP `OAuthServerProvider` interface via a new `PerplexityOAuthProvider` (in `packages/mcp-server/src/daemon/oauth-provider.ts`). Exposes the full RFC 6749 / PKCE-required flow:
  - `GET /.well-known/oauth-authorization-server` — RFC 8414 authorization server metadata. Dynamic issuer; tunnel clients see the trycloudflare URL, loopback callers see `127.0.0.1`.
  - `GET /.well-known/oauth-protected-resource` — RFC 9728 protected-resource metadata pointing at the same issuer.
  - `POST /register` — RFC 7591 dynamic client registration (public clients; no client_secret).
  - `GET /authorize` — PKCE `S256` required. Bridges to a VS Code modal via the SSE consent coordinator.
  - `POST /token` — `authorization_code` + `refresh_token` grants. Access tokens are opaque (32-byte base64url) with a 1h TTL; refresh tokens rotate on each exchange.
  - `POST /revoke` — invalidates a given access or refresh token.
- **VS Code consent modal**. When a client hits `/authorize`, the daemon emits a `daemon:oauth-consent-request` SSE event. The extension host shows a native modal with client name, client_id, and redirect_uri. Approval/denial routes back through the new `/daemon/oauth-consent` admin endpoint (static-bearer gated, so OAuth clients cannot approve their own consent).
- **Clients persistence** at `<configDir>/oauth-clients.json` (0600). Access + refresh tokens are kept in memory.
- **`/mcp` accepts both auth shapes** — the static daemon bearer (for loopback + CLI) and OAuth access tokens (for remote MCP clients like Claude Desktop's custom connector). The SDK `requireBearerAuth` middleware is used with our provider as the verifier. A small `promoteCallerClientId` shim promotes a `x-perplexity-client-id` header onto `req.auth.clientId` when the caller authenticated via static bearer, so audit and progress-event filters stay meaningful.

### Changed
- `packages/mcp-server` and `packages/extension` bump to `0.6.0`.
- `StartedDaemonServer` gains `listOAuthClients`, `revokeOAuthClient`, and `resolveOAuthConsent` helpers.
- `StartDaemonServerOptions` gains `onOAuthConsentRequest` and `getTunnelUrl` hooks.

### Security notes
- Consent modal is the only path that issues an authorization code — browser-only flows (just hitting `/authorize`) can't self-approve.
- Consent times out after 2 minutes with implicit deny. Each consent requires re-approval — we do not cache approvals across `/authorize` calls.
- Static-bearer callers are reported as `clientId: "local-static"` in `verifyAccessToken` unless they pass `x-perplexity-client-id`.

## [0.5.1] — 2026-04-22 — Phase 6a: public-exposure hardening

### Added
- **Branded unauthenticated homepage at `GET /`**, `robots.txt` with `Disallow: /`, and a favicon 204. Hitting the tunnel URL in a browser now shows a clear "not a public service" card instead of leaking `Cannot GET /`.
- **Security middleware** (`packages/mcp-server/src/daemon/security.ts`) running before bearer auth on every request:
  - Per-bearer rate limit on tunnel traffic (default 60 req/min, override with `PERPLEXITY_DAEMON_RATELIMIT_RPM`). Loopback traffic is exempt.
  - Suspicious-User-Agent blocklist (`masscan`, `nmap`, `zgrab`, `sqlmap`, `nikto`, `gobuster`, `wpscan`, `hydra`, `Shodan`, `censys`).
  - Slow-401 — every tunnel 401 is delayed 150ms to defeat bearer brute-force timing probes.
- **401-burst auto-disable tripwire** — 20 auth failures within 60s on the tunnel snip the tunnel immediately. The dashboard raises an error banner with recovery guidance (rotate bearer → re-enable).
- **Enriched audit log** — every HTTP request to `/daemon/*`, `/mcp`, `/authorize`, `/token`, `/register` now appends a JSONL entry with `ip`, `userAgent`, `path`, `httpStatus`, `auth`, and `source` in addition to the existing tool-call fields.

### Changed
- `packages/mcp-server` and `packages/extension` bump to `0.5.1`.
- `appendAuditEntry` signature extended with optional `ip`, `userAgent`, `path`, `httpStatus`, `auth` fields (backward compatible — tool-call audit rows still work unchanged).

### Security notes
- Tunnel auto-disable is source-scoped: `x-perplexity-source: loopback` and true 127.0.0.1 traffic without `cf-connecting-ip` never triggers the tripwire.
- Homepage + robots deliberately leak no runtime information (no version, uptime, tool list, or port). The dashboard remains the only authoritative source of that data.

## [0.5.0] — 2026-04-21 — Phase 4 history viewer

### Added
- Markdown-backed history storage under per-profile `history/*.md` with YAML frontmatter, sidecar attachments, and rebuildable `index.json`.
- Native export support for PDF / Markdown / DOCX through the captured Perplexity `/rest/entry/export` flow, exposed via the MCP tool, CLI, and VS Code dashboard.
- External Markdown viewer registry and detection for Obsidian, Typora, and Logseq, including an Obsidian bridge copy path and doctor visibility through `ide.mdViewers`.
- VS Code Rich View overlay, History tab actions, export/download flows, preview/open-with actions, and command-palette entries for `Open Rich View`, `Export History Entry`, and `Rebuild History Index`.
- Operator docs: [docs/export-endpoint-capture.md](docs/export-endpoint-capture.md) and [docs/history-migration.md](docs/history-migration.md).

### Changed
- `perplexity_list_researches` and `perplexity_get_research` now read from the unified Markdown history store instead of a separate JSON research store.
- `packages/mcp-server` and `packages/extension` now ship as `0.5.0`.
- Extension bundling now keeps `keytar` external again so VSIX/extension builds do not try to inline `keytar.node`.

### Migration
- Pre-0.5.0 flat `history.json` and `researches/*.json` files are not auto-converted. New entries populate the Markdown layout only. See [docs/history-migration.md](docs/history-migration.md).

## [0.4.7] — 2026-04-20 — doctor polish: inline fix actions + export parity

### Fixed
- **Doctor `ide-audit` was always `skip` in exported reports.** The `doctor:export` and `doctor:report-issue` handlers called `runDoctor({ baseDir })` without passing `ideStatuses`, so the IDE check always fell through to its "requires the VS Code extension" skip branch. Both handlers now pass the same `ideStatuses` the Run/Deep-check path uses.

### Added
- **One-click fix actions for known-remediable doctor findings.** `DoctorCheck` now carries an optional `action: { label, commandId, args? }` that the webview renders as a button next to the hint. Extension host whitelists the allowed `commandId`s and clears the cached report after running so the next Run shows the now-fixed state.
- Action producers wired for three findings:
  - `config/active-pointer: warn` (no active profile) → **Add account** (`Perplexity.addAccount`).
  - `native-deps/impit: skip` → **Install Speed Boost** (`Perplexity.installSpeedBoost`).
  - `ide/<name>: warn` (detected but not configured or stale) → **Configure** (`Perplexity.generateConfigs`, `args: [id]`).

## [0.4.6] — 2026-04-20 — profile-flow UX and active-profile login fixes

### Fixed
- **Create-account flow:** adding a profile from the dashboard or extension host now creates it, makes it active immediately, and starts the selected login mode in the same flow instead of forcing a second separate login action.
- **Generic login targeting:** the shared `Perplexity.login` path now uses the active profile's saved `loginMode` instead of prompting again and risking a fallback to the old `default` profile.
- **Empty-profile UX:** the webview now shows `No Account Yet` / `Add account` when no active profile exists, and the profile switcher no longer pretends the active profile is `default` after all profiles are deleted.
- **Mode-aware re-login:** dashboard re-login actions now route through the generic profile-aware login path instead of hard-coding manual mode.

## [0.4.5] — 2026-04-20 — manual-login visibility and delete-profile UX

### Fixed
- **Manual login visibility:** the headed manual login runner no longer starts Chrome minimized. It now brings the browser tab to the front and the extension shows an explicit prompt telling the user to complete sign-in there.
- **Delete profile action:** the dashboard no longer relies on `window.confirm(...)` inside the webview. Confirmation now runs on the extension host via a modal VS Code warning, so the delete action reaches the real profile-removal path reliably.
- **Regression coverage:** extension auth tests now cover the `awaiting_user` progress event emitted by the manual login path.

## [0.4.4] — 2026-04-20 — doctor/profile polish

### Fixed
- **Doctor speed-boost detection:** the `native-deps` check now detects `impit` from the actual runtime install under `~/.perplexity-mcp/native-deps/node_modules/impit`, instead of relying on an import path that could miss a valid install and incorrectly report `not installed`.
- **Profile deletion semantics:** deleting a profile now clears or re-points the active profile pointer instead of leaving stale state behind. The dashboard now exposes an explicit `Delete profile…` action for full profile removal.
- **Headed login window behavior:** manual and auto login runners now attempt to start minimized and use a CDP minimize call as a best-effort fallback so the browser is less intrusive on the desktop.
- **Doctor probe false-fail:** when the live probe completes on an authenticated session but Perplexity returns zero citations, doctor now reports a warning instead of a hard auth failure.

## [0.4.3] — 2026-04-20 — live OTP runner release

### Fixed
- **Real-site auto OTP flow:** the auto login runner now drives Perplexity's live NextAuth email+OTP flow (`/api/auth/csrf`, `/api/auth/signin/email`, `/auth/verify-request`, `/api/auth/otp-redirect-link`, `/api/auth/callback/email`) instead of treating the site as unsupported because `/login/email` is absent.
- **Post-login account metadata:** the auto runner, manual runner, and health check now collect session, model, rate-limit, ASI, experiment, and user-info data from the current live endpoints so profile caches and doctor output reflect the authenticated account correctly.
- **Release packaging clarity:** the fixed auth build now ships as `0.4.3`, avoiding stale `0.4.2` installs that still bundle the older mock-only login runner and outdated dashboard fallback copy.

## [0.4.2] — 2026-04-20 — post-Phase 3.1 auth/runtime fix

### Fixed
- **Active profile drift:** dashboard snapshots, live model refresh, and the shared MCP client now resolve profile-specific paths at call time instead of caching `default` at module import. Profile switches and per-profile logins now read/write the selected profile consistently.
- **Webview auth/profile actions now refresh MCP definitions:** the dashboard path (`auth:login-start`, `auth:logout`, `profile:switch`) now triggers the same MCP server definition refresh that the command-palette path already did, so switching or logging into a non-default profile updates the running server instead of leaving it on the old account.
- **Doctor runtime packaged-path crash:** the runtime check now resolves `package.json` from the extension-provided `baseDir` before falling back to `import.meta.url`, which fixes the `runtime-runner -- check crashed: Invalid URL` failure in packaged VSIX builds.
- **VSIX build order:** `packages/extension` now rebuilds `@perplexity-user-mcp/shared` and `perplexity-user-mcp` before bundling `extension.js`, preventing stale workspace dist output from being shipped inside a new VSIX.

## [0.4.1] — 2026-04-20 — Phase 3.1 hotfix

### Fixed
- **Login:** `AuthManager` now derives runner paths from `vscode.ExtensionContext.extensionUri` instead of `globalThis.require.resolve(...)`. The latter doesn't exist in the tsup-bundled CJS extension, so 0.4.0's Login button always threw `"require not available in this runtime"`. Phase 2 regression — not caught because 0.3.0 shipped without a manual VSIX smoke.
- **Doctor false-positive on `native-deps`:** the `patchright` and `got-scraping-chain` checks now accept a `baseDir` opt. `DashboardProvider` passes `<extensionUri>/dist` so the chain resolves against the VSIX's `dist/node_modules/` tree. Previously `createRequire(import.meta.url)` failed because tsup polyfills `import_meta = {}` in CJS bundles.
- **Redactor no longer eats ISO timestamps:** the IPv6 regex used to match any colon-separated hex-chars-and-digits, which included wall-clock `HH:MM:SS` strings. Now requires IPv6-shape (hex groups AND either a double-colon or a group with hex-only chars). Doctor reports now show `Generated: 2026-04-20T10:27:42.278Z` verbatim.
- **Doctor tab moved from position 2 to position 5** — it's not a daily-driver tab.

### Release discipline
- Added Phase 3.1 manual smoke checklist in `docs/smoke-tests.md`. Every future phase's release gate now requires a successful VSIX install + smoke run before tagging.

## [0.4.0] — 2026-04-20 — Phase 3: Doctor

### Added
- `perplexity-user-mcp doctor` CLI subcommand with 10 check categories (runtime, config, profiles, vault, browser, native-deps, network, ide, mcp, probe).
- `--probe` opt-in live search check, `--json` machine-readable output, `--all` multi-profile mode, `--profile` single-profile targeting.
- `perplexity_doctor({probe?, profile?})` MCP tool — same checks, Markdown-rendered output for LLMs.
- VS Code extension **Doctor** dashboard tab with collapsible category cards, inline action buttons, and Run / Deep check / Export / Report-issue toolbar.
- Guided GitHub issue flow with client-side redaction (emails, userIds, cookies, home paths, IPs, long tokens) and opt-out via `reporting.githubIssueButton: false` in `~/.perplexity-mcp/config.json`.
- `.github/ISSUE_TEMPLATE/doctor-report.yml` structured form with consent checkboxes.
- **Regression guard for Phase 2 carry-over #5:** the `native-deps/got-scraping-chain` check walks `header-generator → dot-prop → is-obj` via `createRequire` and warns if the VSIX packaging chain breaks.
- New extension commands `Perplexity.doctor` and `Perplexity.doctorReportIssue`.
- Integration tests covering doctor end-to-end + probe timeout + packaging-chain regression.

### Changed
- `tools-config.json` `read-only` profile now includes `perplexity_doctor`.
- `McpServer` version string advertised as `0.4.0`.
- `packages/extension/scripts/prepare-package-deps.mjs` now has a JSDoc header documenting why `dot-prop` and `is-obj` are in `rootPackages`.

## [0.3.0] — 2026-04-20

### Added
- `packages/mcp-server/src/health-check.js` — spawnable non-persistent session probe
- `packages/mcp-server/src/manual-login-runner.js` — spawnable headed-browser login
- `packages/mcp-server/src/login-runner.js` — spawnable auto-OTP login with IPC prompt + retry
- `packages/mcp-server/src/logout.js` — soft + hard (`--purge`) logout
- `packages/mcp-server/src/reinit-watcher.js` — `.reinit` sentinel watcher with debounce
- `packages/mcp-server/src/tty-prompt.js` — vault passphrase prompt (priority-3 fallback)
- Express-based mock Perplexity server for integration tests
  (`packages/mcp-server/test/integration/mock-server.js`)
- Integration test coverage for all four runners + end-to-end re-auth cycle
- Shared types: `AuthStatus`, `AuthState`, `Profile` + 10 new message variants
  (3 `ExtensionMessage`, 7 `WebviewMessage`)
- Webview components: `ProfileSwitcher`, `OtpModal`, `ExpiredBanner` +
  auth slice on the zustand store
- Extension commands: `Perplexity.logout`, `Perplexity.switchAccount`,
  `Perplexity.addAccount` (+ `Perplexity.login` now routed through the
  new `AuthManager` with per-profile concurrency guards and OTP IPC)
- Manual smoke checklist at [docs/smoke-tests.md](docs/smoke-tests.md)

### Changed
- `packages/mcp-server/src/index.ts`: removed the `clientReady=true`
  one-shot trap; `getClient()` now always awaits the latest init promise,
  and `.reinit` sentinel triggers `client.reinit()` so external runners
  take effect without a server restart (fixes TODO #2, #6).
- `packages/mcp-server/src/client.ts`: `getSavedCookies()` is vault-backed
  and async; `loginViaBrowser` removed (moved to runners).
- `packages/mcp-server/src/config.ts`: cookie / browser-data paths resolve
  through the active profile; new async `hasStoredLogin()`.
- `packages/mcp-server/src/cli.js`: `login` / `logout` / `status` /
  `add-account` / `switch-account` / `list-accounts` are real
  implementations (Phase-1 stubs replaced).
- `packages/extension/src/mcp/auth-manager.ts`: full implementation
  (login, logout, checkSession, concurrency guard, OTP IPC, state machine).
- `packages/extension/src/mcp/secure-permissions.ts`: Windows user
  resolver falls back to `USERPROFILE` basename, then `whoami`.
- `packages/extension/scripts/prepare-package-deps.mjs`: VSIX now ships
  `dot-prop` + `is-obj` so the got-scraping tier works post-install.
- `packages/mcp-server/package.json`: added `./logout` and `./profiles`
  subpath exports for the extension's dynamic imports.

### Fixed
- **TODO #1** — encrypted multi-account login (Phase 1 scaffolding +
  Phase 2 runtime).
- **TODO #2** — `perplexity_login` MCP tool now works end-to-end via
  runner + sentinel re-init.
- **TODO #5** — logout flow exposed via CLI + dashboard + command palette.
- **TODO #6** — MCP server no longer caches `clientReady=true` through a
  login.
- Phase 2 carry-overs #1–#5 from Phase 1 final review: key-cache reset
  on `setActive`, vault JSON corruption errors surfaced via `redact`,
  `secureWindows` user-resolver fallbacks, IPC discipline verified across
  all runners (single stdout write, progress via `process.send`), VSIX
  dot-prop chain included.

### Security
- Runners never write cookies or user IDs to disk in plaintext; vault is
  AES-256-GCM with a 256-bit master key in the OS keychain (or env-var
  passphrase / TTY prompt fallback).
- Extension ↔ webview: user IDs and emails are NOT forwarded to the
  webview (only `tier` + `status`).
- Corrupt vault detection now surfaces a diagnosable error (redacted)
  instead of silently returning empty.
- OTP submissions are routed per-profile so concurrent logins across
  different profiles don't cross-deliver codes.

### Migration
- **No automatic migration from 0.2.0 or earlier flat
  `~/.perplexity-mcp/cookies.json`.** Users must re-login once with
  0.3.0 to populate the per-profile vault. Documented in
  [docs/superpowers/specs/2026-04-19-perplexity-user-mcp-upgrade-design.md](docs/superpowers/specs/2026-04-19-perplexity-user-mcp-upgrade-design.md) §15.

### Verification
- 159/159 automated tests pass (128 unit + 31 integration across 12 test
  files on `perplexity-user-mcp`; 13 on `perplexity-vscode`).
- All 4 package typechecks clean.
- Manual smoke checklist ([docs/smoke-tests.md](docs/smoke-tests.md))
  pending verification on macOS 14+ and Ubuntu 22+; Windows 11 partial
  (automated integration tests exercise the runner + mock flow).

## [0.2.0] — 2026-04-19

### Added
- LICENSE (MIT), NOTICE, SECURITY.md, CHANGELOG.md
- `packages/mcp-server/src/redact.js` — security-critical log redaction
- `packages/mcp-server/src/profiles.js` — multi-account profile CRUD
- `packages/mcp-server/src/vault.js` — disk-backed AES-256-GCM vault with
  OS-keychain-first master key acquisition and documented fallbacks
- `packages/mcp-server/src/cli.js` — subcommand dispatcher (stubs in this
  phase; real behavior arrives in Phases 2-4)
- `packages/extension/src/mcp/secure-permissions.ts` — filesystem hardening
- `packages/extension/src/mcp/auth-manager.ts` — fork harness skeleton
- `keytar` as optional runtime dependency

### Changed
- Initial release as `perplexity-user-mcp`.
- License: UNLICENSED → MIT
- `packages/mcp-server/package.json` `bin` now points at `cli.mjs`

### Phase 1 does NOT change
- Any existing MCP tool behavior
- Any existing dashboard feature
- Any existing IDE auto-config flow

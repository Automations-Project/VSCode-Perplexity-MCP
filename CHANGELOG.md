# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/).

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
- Package renamed from `airtable-user-mcp` to `perplexity-user-mcp`
- License: UNLICENSED → MIT
- `packages/mcp-server/package.json` `bin` now points at `cli.mjs`

### Phase 1 does NOT change
- Any existing MCP tool behavior
- Any existing dashboard feature
- Any existing IDE auto-config flow

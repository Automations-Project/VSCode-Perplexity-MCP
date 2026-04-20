# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/).

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

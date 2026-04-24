# Release process

The gate between "code is merged on main" and "`vX.Y.Z` tag exists". Pre-public repo, direct-to-main applies; once the public remote is set up this flips to PR-based.

## Prerequisites — all must be true before starting

- **Tests green.** `npm test` and `npm run test:coverage` both pass at the candidate HEAD. Per-file thresholds in [vitest.config.ts](../vitest.config.ts) are enforced, not advisory.
- **Typecheck green.** `npm run typecheck` passes across all four packages.
- **No uncommitted work.** `git status` is clean. Pending changes either land before the release commit or defer to the next version.
- **CHANGELOG entry present.** A `## [X.Y.Z] — YYYY-MM-DD — <title>` section for the candidate version exists in [CHANGELOG.md](../CHANGELOG.md) with Added / Changed / Removed / Security / Tests / Release gate sub-sections in the style of the 0.7.x and 0.8.x entries.
- **Secret-leak gate clean.** `node scripts/assert-no-secret-leak.mjs .test-artifacts/vitest.log` exits 0. Zero matches for known bearer / token / OAuth-code shapes.

## Smoke gate — required before tag

A phase-scoped manual checklist lives in [docs/smoke-tests.md](smoke-tests.md). Every versioned release is gated on a three-platform pass (Windows 11, macOS 14+, Ubuntu 22+) OR a recorded waiver per platform.

**Three-platform pass** — preferred path:

- Create three dated evidence files under [docs/smoke-evidence/](smoke-evidence/) in the form `YYYY-MM-DD-vX.Y.Z-<os>.md`, one per target OS. Skeletons for 0.8.6 already exist at `2026-04-XX-v0.8.6-{win11,macos14,ubuntu22}.md` — rename `XX` to the actual day.
- Run the checklist on each OS. Check every applicable box in the evidence file; paste terminal output / screenshots for items that require it.
- Sign-off field filled in on every file.

**Waiver path** — acceptable but must be explicit:

- One fully-green platform is still required. You cannot ship with every platform waived.
- Each waived platform carries a distinct reason in its evidence file AND in the release commit body. Acceptable reasons: hardware unavailability, upstream dependency breakage (e.g. cloudflared auth server down), environment-specific blocker (no Cloudflare zone → can't smoke cf-named). **NOT acceptable**: "no time", "unit tests passed so it's probably fine".
- For external-API smokes (Phase 8.4 cf-named, tunnel providers), the waiver language in the release commit body must be stronger than code-only waivers because the risk is external and can't be regression-caught by CI.

**Consolidated smokes** — when multiple versions defer:

Releases 0.8.2 → 0.8.5 all deferred their smokes per the Phase 8 completion execution design. The smoke for 0.8.6 is therefore a consolidated pass covering Phase 8.5 → 8.8 in a single session. Always prefer a per-release smoke; fall back to a consolidated one only when the accumulated scope is manageable in one sitting.

## VSIX packaging

```bash
npm run package:vsix
```

This runs `npm run build` (shared → mcp-server → webview → extension) followed by `prepare-package-deps` (copies externals into `dist/node_modules/`) and `vsce package`. Verify the output is at `packages/extension/perplexity-vscode-X.Y.Z.vsix`.

Before signing off on the VSIX, spot-check the invariants:

- **Express 4.x.** VS Code extensions depend on the bundled daemon; express 5.x changes middleware promise semantics and breaks the OAuth routes.
  ```bash
  unzip -p packages/extension/perplexity-vscode-X.Y.Z.vsix \
    extension/dist/node_modules/express/package.json | jq -r .version
  ```
  Expect a string starting with `4.`. If it starts with `5.`, halt the release, revert the offending dependency bump, and re-pack.
- **`dist/mcp/server.mjs` contains `attachToDaemon`** (re-export from 0.8.0 — proves the stdio launcher's daemon-proxy path reached the bundle).
- **Size is in the ~11-12 MB band** (significantly larger usually means a new native binary was inadvertently bundled; significantly smaller usually means an external went missing).

## Version bump

Both packages share a version number and must be bumped together.

- `packages/extension/package.json` — `version`
- `packages/mcp-server/package.json` — `version`

Extension's `emit-version.mjs` script copies the version into the bundle at build time, so the bump must land **before** `npm run package:vsix` for the version stamp to be correct.

## Release commit

Use a single commit that carries the CHANGELOG entry + version bumps + any smoke-evidence files. Commit message form:

```
release(X.Y.Z): <short title matching CHANGELOG heading>

<1-3 lines on what shipped + any waivers>
```

If any platform is waived, include a `## Smoke waivers` section in the commit body listing each waived platform with its reason:

```
## Smoke waivers
- ubuntu22: hardware unavailable this cycle; covered by CI integration tests on ubuntu-latest runner.
- macos14: skipped (no macOS hardware available); covered by hermetic unit tests on darwin-arm64 runner.
```

## Tag

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

Pre-public repo: direct-to-main, no PR, no review gate beyond the owner's own smoke + CHANGELOG + evidence files.

Once the public remote is configured, this flips: feature branches + PRs + squash-merge, with the release commit + tag driven from the PR landing.

## Post-release

- Verify the tag appears in the remote.
- If the release is for the npm-published `perplexity-user-mcp` package (not just the VSIX), run `npm publish --workspace packages/mcp-server` from a clean `npm install && npm run build` state. The VSIX and npm package version must match.
- Paste the release commit SHA back into each evidence file's "Release commit SHA" field.
- Close any phase-scoped planning docs under [docs/superpowers/plans/](superpowers/) that are fully delivered by this release.

## When a release fails the smoke gate

- Regressions discovered during smoke ship as the next patch version (e.g. 0.8.3 → 0.8.4 hotfix). Do NOT tag the failed candidate.
- If the failed candidate was already tagged (e.g. you ran the tag before the smoke pass — don't do this), the recovery is: land the fix on main, bump patch, re-run smoke, tag the new patch. Never force-push or delete tags on shared remotes.
- Document the regression + fix in the next version's CHANGELOG `### Fixed` or `### Changed` section so the git history reads clearly.

## Related

- [docs/smoke-tests.md](smoke-tests.md) — the per-phase manual checklist.
- [docs/smoke-evidence/](smoke-evidence/) — dated evidence files from prior smokes.
- [CLAUDE.md](../CLAUDE.md) "Repo-specific working rules" — the canonical per-release policy statement.
- [CHANGELOG.md](../CHANGELOG.md) — the release notes.

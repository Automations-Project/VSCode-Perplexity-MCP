# Smoke-evidence index

## Purpose

This index tracks which (IDE × transport × OS) combinations have *signed*
smoke evidence under `docs/smoke-evidence/`. An entry is "Backed Y" only when
an evidence file (a) explicitly names the IDE, (b) has its OS section signed
off, and (c) has every checkbox for the relevant transport checked. Empty
entries, generic templates, and extrapolations from a single-IDE, single-OS
run do **not** count. If a row is "Backed N", the corresponding capability
claim in `packages/shared/src/constants.ts` is currently asserted without
matching primary evidence — the parent should treat this as a gap to close
before the public-repo cut, not as a green-light to ship.

## Capability claims with evidence (current state, 2026-04-28)

Source of claims: `packages/shared/src/constants.ts` (`IDE_METADATA`).
Evidence files cited in that file: `2026-04-24-http-loopback-static-bearer.md`
(JSON shape, Win11 only) and the new
`2026-04-28-codex-cli-toml-loopback-template.md` (Codex TOML shape, all OSes
unfilled).

| IDE | configFormat | httpBearerLoopback claim | Evidence file currently referenced | Backed Y/N | OS coverage (signed) |
|---|---|---|---|---|---|
| cursor | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only, and the Win11 doc does not name this IDE specifically |
| windsurf | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only; IDE not named |
| windsurfNext | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only; IDE not named |
| claudeDesktop | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only; IDE not named |
| claudeCode | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only; IDE not named |
| cline | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only; IDE not named |
| amp | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only; IDE not named |
| rooCode | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only; IDE not named |
| codexCli | toml | true | 2026-04-24-http-loopback-static-bearer.md (WRONG SHAPE — that doc only shows JSON `headers.Authorization`) | N (wrong-shape reference) | None — the TOML `bearer_token_env_var` indirection is not covered by the cited doc |
| continueDev | yaml | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated; YAML config shape not shown in the doc either) | Win11 only; IDE not named |
| zed | json | true | 2026-04-24-http-loopback-static-bearer.md | N (extrapolated) | Win11 only; IDE not named |
| copilot | ui-only | false | n/a | Y (claim is `false`, no evidence required) | n/a |
| geminiCli | json | false | n/a | Y (claim is `false`, no evidence required) | n/a |
| aider | yaml | false | n/a | Y (claim is `false`, no evidence required) | n/a |
| augment | json | false | n/a | Y (claim is `false`, no evidence required) | n/a |

`httpOAuthLoopback` and `httpOAuthTunnel` are `false` for every IDE in
`IDE_METADATA` and therefore require no evidence today. If either is flipped
to `true` for any IDE, a new dated evidence doc must be added and a new row
appended to this index.

## Pending evidence work

Estimates from the prior audit: ~15 minutes per IDE-specific shape verification
(when batched into a single VS Code session and a single Codex/Cursor/etc.
restart), ~30 minutes per OS for a full sweep across all bearer-loopback IDEs
(setup, install, run, sign off).

### Codex CLI TOML bearer-env (new shape, dedicated template)

Template doc: `docs/smoke-evidence/2026-04-28-codex-cli-toml-loopback-template.md`

- [ ] codexCli × Linux — ~15 min, fills the Linux section
- [ ] codexCli × macOS 14+ — ~15 min, fills the macOS section
- [ ] codexCli × Windows 11 — ~15 min, fills the Windows section

### JSON `headers.Authorization` bearer-loopback (existing shape)

Existing doc: `docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md`
(currently Win11 only, no per-IDE naming). To convert "extrapolated" to
"Backed Y", either (a) extend that doc with explicit per-IDE sub-sections and
sign-offs per OS, or (b) create one new dated doc per OS that enumerates each
IDE name with a checkbox and sign-off line.

Per-OS sweeps (each ~30 min if batched, covers 9 IDEs: cursor, windsurf,
windsurfNext, claudeDesktop, claudeCode, cline, amp, rooCode, zed):

- [ ] JSON sweep × Linux
- [ ] JSON sweep × macOS 14+
- [ ] JSON sweep × Windows 11 (the existing 2026-04-24 doc partially covers this but does not enumerate per-IDE sign-offs)

### YAML bearer-loopback (Continue.dev — separate shape)

The 2026-04-24 doc does not show the YAML shape. Continue.dev consumes a
different config format and needs its own dedicated evidence doc per OS.

- [ ] continueDev × Linux — ~15 min (new doc required first)
- [ ] continueDev × macOS 14+ — ~15 min
- [ ] continueDev × Windows 11 — ~15 min

### Existing template files awaiting fill

These pre-existing files in `docs/smoke-evidence/` are unfilled v0.8.6
release-smoke templates. They are not transport-specific; they are
release-gate checklists. Filling them is part of the release process
(`docs/release-process.md`), not part of the per-IDE evidence backfill above:

- `2026-04-XX-v0.8.6-win11.md`
- `2026-04-XX-v0.8.6-macos14.md`
- `2026-04-XX-v0.8.6-ubuntu22.md`

### Total operator time to fully back the matrix

Lower bound assuming all batched: ~3 hours (3 OSes × 1 hour: one Codex run +
one JSON sweep + one Continue.dev run per OS, with some setup overlap).
Upper bound, treating each cell as independent: 9 IDE-specific runs ×
3 OSes × 15 min = ~7 hours.

## Methodology note

A capability claim is "Backed Y" in this index only when **all three** are true:

1. An evidence doc exists at the path referenced from `IDE_METADATA`.
2. That doc explicitly names the IDE (so a reader can verify the claim
   without inference). A doc that says "every JSON IDE" is generic; it does
   not back any specific IDE row.
3. The OS section relevant to the operator's platform is fully checked and
   signed off (operator name + date). An empty checkbox or a placeholder
   `<name>` does not count.

Generic claims, extrapolations, and template-only files do **not** count as
backing. Treat them as "we believe this works, but we have not actually
verified it for this combination."

## Maintenance

When you add a new evidence doc or sign off on a section:

1. Update the row in the table above (Backed Y, list the OS).
2. Move the corresponding line out of "Pending evidence work".
3. If you flip a capability from `false` to `true` in
   `packages/shared/src/constants.ts`, add the row here in the same commit.

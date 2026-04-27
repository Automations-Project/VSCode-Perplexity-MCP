# Vault v3 — Password-KDF Stretching Design

**Date:** 2026-04-28
**Predecessor spec:** `docs/superpowers/specs/2026-04-27-vault-hkdf-migration-design.md` (v2 — randomized HKDF salt)
**Affected file (future implementation):** `packages/mcp-server/src/vault.js`
**Status:** DESIGN — implementation deferred until approved.
**Audit linkage:** `AUDIT-REPORT.md` §1.3 follow-up (the v2 spec's §11 Open Question 1 explicitly defers KDF stretching to a v3 phase).

---

## 1. Background and goals

### 1.1 What v2 fixed and what it did not

The v2 migration (commit `8511569`, design at `docs/superpowers/specs/2026-04-27-vault-hkdf-migration-design.md`) replaced a hardcoded HKDF salt with a fresh per-vault/per-write 16-byte random salt:

```
v1: [MAGIC "PXVT" 4][VERSION 0x01 1][IV 12][CT n][TAG 16]
v2: [MAGIC "PXVT" 4][VERSION 0x02 1][SALT_LEN 0x10 1][SALT 16][IV 12][CT n][TAG 16]
```

Random per-install salt **defeats rainbow tables** (an attacker with one `vault.enc` can no longer pre-compute a passphrase dictionary once and replay it against every victim). It does **not** defeat targeted brute-force, because HKDF-SHA256 has **zero work factor**: each guess costs a single HMAC-SHA256, which on commodity hardware runs at hundreds of millions of attempts per second per CPU core, billions on a GPU. A weak passphrase like `"perplexity"` is recoverable in seconds even with random salt.

This is acknowledged in the v2 spec at §11 Open Question 1 ("tight scope vs wide scope") and in `vault.js:91-93`:

```js
// NOTE: HKDF is NOT a password KDF — it has no work factor. Weak passphrases
// remain brute-forceable. The randomized per-vault salt thwarts pre-computed
// rainbow tables (the audit's headline fix); a future v3 may add scrypt/argon2id.
```

This spec is that follow-up. v3 swaps the passphrase-derivation step from `hkdfSync("sha256", ...)` to a true password KDF with a tunable cost factor, while preserving every property v2 already provides.

### 1.2 Threat model recap

| Attacker capability | v1 cost per guess | v2 cost per guess | v3 cost per guess (target) |
|---|---|---|---|
| Has stolen `vault.enc` from one user | 1 HMAC-SHA256 + rainbow table reuse across victims | 1 HMAC-SHA256 (no rainbow table reuse) | ≥ 100ms of CPU (or memory-bound for argon2id) |
| Has stolen `vault.enc` from N users | 1 HMAC-SHA256 per (user, guess) tuple | 1 HMAC-SHA256 per (user, guess) tuple | ≥ 100ms per (user, guess) tuple |
| Has live MCP server access (online attack) | Limited by I/O / OS keychain rate | Same | Same — KDF cost is paid once per process lifetime via `_unsealMaterialCache` |

The v3 cost target ("≥100ms per guess") makes a 6-character lowercase passphrase brute-force require ~26⁶ × 0.1 s ≈ **35 years per CPU core** instead of milliseconds. An 8-character mixed-case+digit passphrase becomes infeasible (~65 trillion years per CPU core). This is the industry-standard outcome we are buying.

### 1.3 Goals

- **G1 — Defeat offline brute-force on weak passphrases** at a per-process cost the user does not perceive (≤500ms on a 2020 laptop, paid once at process startup or `__resetKeyCache`).
- **G2 — Backward compatibility forever.** v1 and v2 vaults remain readable. Users who upgrade do not see "vault locked" errors.
- **G3 — No eager migration.** Reads must NEVER mutate disk. v1 → v3 and v2 → v3 conversion happens on the **next legitimate write** after a successful read, identical to the v2 migration discipline.
- **G4 — Atomic-write safety preserved.** `safeAtomicWriteFileSync` continues to bracket every write; a failed v3 write leaves the prior (v1 or v2) blob byte-identical on disk.
- **G5 — Keychain users unaffected.** Users on Windows / macOS / Linux+libsecret resolve their key from `keytar` as a 32-byte random value. The KDF only matters for passphrase users. Keychain users see no perceptible change.
- **G6 — Coverage floor preserved.** `vault.js` stays ≥95% per-file; `vault.test.js` adds v3-specific cases without dropping any v1 or v2 case.
- **G7 — Forward compatibility.** A future v4 (e.g. per-profile keys, FIDO2 hardware unseal) must slot in via the same version-byte dispatch.

### 1.4 Non-goals

- **Not switching cipher.** AES-256-GCM remains. There is no security argument to change it; switching would double the migration surface.
- **Not changing the magic header.** `PXVT` stays. Only the version byte and what follows it change.
- **Not removing the v1 or v2 read paths.** Both remain readable indefinitely. (Forward-only migration: once a profile is rewritten as v3 it is v3 forever, but read compatibility for older formats never drops.)
- **Not "fixing" wrong-passphrase-vs-corrupt-blob indistinguishability.** AES-GCM authentication-tag failure is, by cryptographic design, indistinguishable between "wrong key" and "tampered ciphertext". The structural pre-checks added in v2 (truncated, wrong magic, unsupported version, invalid salt length) remain the discriminators.
- **Not introducing per-profile keys.** Master key remains global per install (one keychain entry, or one passphrase shared across profiles). Per-profile keys are a separate phase.
- **Not changing `Vault.{get,set,delete,deleteAll}` signatures.** Callers in `config.ts`, `cli.js`, `health-check.js`, `login-runner.js`, `manual-login-runner.js`, `logout.js` all continue to work unmodified.
- **Not introducing a TTY re-prompt.** The KDF cost is amortized by `_unsealMaterialCache` and `_keyCache`; the user is not prompted again for the passphrase per vault op.

---

## 2. KDF choice — scrypt vs argon2id

### 2.1 The candidates

| Property | scrypt (Node `crypto.scrypt`) | argon2id (`argon2` npm) |
|---|---|---|
| Built into Node? | Yes — `node:crypto` | No — native module, ~3MB native build per platform |
| Memory-hard? | Yes (configurable via `r`) | Yes (more aggressive; configurable via `memory`) |
| CPU-hard? | Yes (via `N`) | Yes (via `iterations`) |
| Parallelism control | `p` parameter | `parallelism` parameter |
| Pedigree | 2009 (Colin Percival), widely deployed (Litecoin, BIP38, MyEtherWallet) | 2015 (PHC winner), newer but more aggressively analyzed |
| Side-channel resistance | Good | Better (argon2**id** specifically blends data-independent + data-dependent passes for both side-channel and TMTO resistance) |
| Native-build risk on Windows | None — Node built-in | Real — `node-gyp` + `node-pre-gyp` install fail rate is non-trivial on Windows-without-build-tools |
| Native-build risk on Linux ARM (Raspberry Pi, Apple Silicon under Rosetta, etc.) | None | Real — pre-built binaries don't always match the platform |
| Adds tsup external? | No | Yes — would need to be added to `packages/mcp-server/tsup.config.ts` and `packages/extension/scripts/prepare-package-deps.mjs` (per CLAUDE.md "When adding a dependency, decide externalize-vs-bundle and update both tsup configs plus prepare-package-deps.mjs") |
| Failure mode if native build fails | N/A — always present | `import("argon2")` throws → MCP server fails to start, or fallback path needed |
| 2020-laptop perf at recommended params | scrypt N=2¹⁷ r=8 p=1 ≈ 200-500ms single-core | argon2id m=64MiB t=3 p=1 ≈ 150-400ms single-core |

### 2.2 Recommendation: **scrypt**

**Justification:**

1. **Zero new dependency.** `node:crypto.scrypt` ships with every Node ≥10. No tsup external to manage, no `prepare-package-deps.mjs` to update, no native binary to ship in the VSIX, no install-time failures on Windows-without-build-tools. The repo already battles externals carefully (CLAUDE.md documents this); avoiding a new one is an explicit win.

2. **Linux first-class works out of the box.** Per the saved memory and `linux/perplexity-codex-mcp-setup-issue.md`, the highest-friction user is the Linux-without-libsecret operator running Codex CLI. They are precisely the user who is on the passphrase code path (no keychain → falls through to env var or TTY → HKDF today → scrypt under v3). For that user, "extension installs and works" must hold without compiling a native module against `apt`-installed headers. Scrypt removes that risk entirely.

3. **The security delta vs argon2id is small in this threat model.** argon2id's superior side-channel resistance matters most for adversaries with co-tenant CPU cache observation (cloud VMs, browser extensions). The vault decrypts inside a per-user MCP server process on the user's own machine; co-tenant observation is not in our threat model. For pure offline brute-force on a stolen `vault.enc`, both KDFs are work-factor-equivalent at equal-cost parameters.

4. **scrypt's params are simpler to explain.** `(N, r, p) = (2^17, 8, 1)` reads as "131072 iterations of a 1MiB-block hash, single-threaded, ~128MiB memory peak, ~300ms on a 2020 laptop." argon2id's `(memory, iterations, parallelism)` triplet plus `version` is more variables to misconfigure.

5. **Operationally it is what the user mentioned first.** The task spec explicitly listed scrypt and argon2id as alternatives and asked us to pick one with rationale. Node-builtin-no-extra-dep is the dominant criterion in this codebase.

If the user prefers argon2id (Open Question Q1), the spec's file format and migration discipline are unchanged — only the KDF identifier byte and parameter encoding differ. Section 3 reserves `KDF_ID = 0x02` for argon2id explicitly so a future swap is a clean version-bump-plus-readers-add-an-arm change.

### 2.3 Recommended scrypt parameters

```
N (cost factor)     = 2^17 = 131072
r (block size)      = 8
p (parallelism)     = 1
maxmem              = 256 MiB  (Node's default 32MiB rejects N=2^17; must raise)
output length       = 32 bytes (AES-256-GCM key)
```

**Memory cost:** `128 * N * r * p` bytes = `128 * 131072 * 8 * 1` = **128 MiB peak** during derivation.
**CPU cost:** ~300ms on a 2020 i5-1135G7 single-core (measured in the OWASP Cheat Sheet baseline; recheck on the actual baseline before locking in).
**Maxmem rationale:** 256MiB is 2× the actual peak to absorb interpreter overhead and avoid spurious "memory limit exceeded" errors across Node minor versions.

These are the **floor**. The encoded params travel with each vault blob (§3); a future re-tune (e.g. doubling `N` to 2¹⁸ when 2030-class laptops make it cheap) is a one-byte change with no version bump and no migration ceremony — old blobs continue to decrypt with their embedded params, new blobs use the new floor.

### 2.4 Why this cost target is right

The KDF runs:

- **At most once per MCP server process startup** (cached in `_keyCache` and `_unsealMaterialCache`).
- **Plus once per `__resetKeyCache()` call**, which fires only on profile-state changes (account switch, login, logout — see `profiles.js:setActive` / `deleteProfile` callers).
- **NOT once per `Vault.get` or `Vault.set` call.** The cache covers steady-state operation.

A 300ms one-time cost at server startup is invisible. A 300ms cost on every account switch is barely noticeable (less than the IDE webview redraw). The user trade-off is: pay 300ms once per session for an attacker who needs 35 CPU-years to brute-force a 6-char passphrase. That is the right shape of trade.

The keychain path (Windows, macOS, Linux+libsecret) does **not** incur this cost — keychain returns the 32-byte key directly with no KDF.

---

## 3. File format v3

### 3.1 Byte layout

```
v3:
  offset       bytes  meaning
  0            4      MAGIC = "PXVT"
  4            1      VERSION = 0x03
  5            1      KDF_ID                  (0x01 = scrypt, 0x02 = argon2id reserved)
  6            1      KDF_PARAMS_LEN          (n; 3 for scrypt, 6 for argon2id)
  7            n      KDF_PARAMS              (per §3.3 below)
  7+n          1      SALT_LEN                (always 0x10 in this spec; reserved for future flex)
  8+n          16     SALT                    (random per write)
  24+n         12     IV                      (random per write)
  36+n         m      CIPHERTEXT              (variable)
  36+n+m       16     AUTH TAG
```

**Header overhead with scrypt params (n=3):** 7 + 3 + 1 + 16 + 12 = **39 bytes** plus 16 bytes auth tag.
**Header overhead with argon2id params (n=6):** 7 + 6 + 1 + 16 + 12 = **42 bytes** plus 16 bytes auth tag.

For comparison: v1 = 17 bytes header + 16 tag = 33 bytes overhead; v2 = 34 bytes header + 16 tag = 50 bytes overhead. v3 adds 5 bytes over v2 (scrypt) or 8 bytes (argon2id). The cookies-JSON payload is ~1-4 KB; this overhead is rounding error.

### 3.2 Why each field exists

- **`MAGIC` (4)** — same as v1/v2. Lets non-vault files be rejected with a structural error before any cryptographic work.
- **`VERSION` (1)** — `0x03`. Drives the dispatch in `parseVaultHeader`.
- **`KDF_ID` (1)** — distinguishes scrypt (`0x01`) from a future argon2id swap (`0x02`) without bumping the version byte. Reserved values: `0x00` (invalid, rejected as corruption), `0x03..0xFF` (future).
- **`KDF_PARAMS_LEN` (1)** — variable-length params let scrypt and argon2id share the format. Reader reads this byte, then reads exactly that many bytes for params. A v3 reader that doesn't recognize `KDF_ID` can still skip the params block via `KDF_PARAMS_LEN` and report a clean "unsupported KDF" error rather than a parse misalignment.
- **`KDF_PARAMS` (variable)** — see §3.3. Parameters travel with the blob so re-tuning at write time doesn't need a format change.
- **`SALT_LEN` (1)** — kept for symmetry with v2's design (the v2 spec §5.5 calls this out explicitly as "cheap forward-compatibility"). Pinned to `0x10` in this spec; any other value rejected as corruption. A future v3.1 could allow `0x20` for a 256-bit salt without a version bump.
- **`SALT` (16)** — fed to the KDF along with the passphrase. Random per write, exactly as in v2. Defeats rainbow tables; complements the KDF's work factor.
- **`IV` (12)** — AES-GCM nonce. Random per write. Standard.
- **`CIPHERTEXT` + `AUTH TAG` (16)** — AES-256-GCM output, identical to v1/v2.

### 3.3 KDF_PARAMS encoding

**For `KDF_ID = 0x01` (scrypt), `KDF_PARAMS_LEN = 3`:**

```
offset  bytes  meaning                  default  floor
0       1      logN     (uint8)         17       16
1       1      r        (uint8)         8        8
2       1      p        (uint8)         1        1
```

Encoding `logN` instead of `N` lets us fit the cost factor in one byte (max value `logN=255` → `N=2^255`, which is absurdly safe for the next several decades). The decoder computes `N = 1 << logN` at decrypt time. Reject `logN < 16` (= N < 65536) at decrypt time as "KDF parameters below security floor; refuse to use."

**For `KDF_ID = 0x02` (argon2id) — reserved, not implemented in this phase, `KDF_PARAMS_LEN = 6`:**

```
offset  bytes  meaning                       default  floor
0       4      memory_kib    (uint32 BE)     65536    19456  (per OWASP min)
4       1      iterations    (uint8)         3        2
5       1      parallelism   (uint8)         1        1
```

Reserved here so a future argon2id phase doesn't need a v4 format bump. This phase emits scrypt only.

### 3.4 Why parameters travel with the blob (and not in a sidecar JSON)

The same arguments from the v2 spec §5.1 (Option A vs Option B) apply: a separate `kdf-params.json` would create a tearing window, two-file backup hazards, and a discovery probe per read. Embedding the params in the blob keeps `safeAtomicWriteFileSync` covering everything in one rename, keeps backup/restore self-contained, and lets `parseVaultHeader` produce all the structural errors with one cursor walk.

### 3.5 Worked example — the first 39 bytes of a v3 blob with scrypt defaults

```
50 58 56 54 03 01 03 11 08 01 10 [16 bytes salt] [12 bytes iv] [ct...] [16 byte tag]
\_______/  \  \  \  \  \  \  \   \                 \
 "PXVT"   v3 sc 3 N=17 r=8 p=1 sl=16
```

`xxd vault.enc | head -1` for a v3 vault begins `5058 5654 0301 0311 0801 10` — easily distinguishable from v1 (`5058 5654 01...`) and v2 (`5058 5654 0210 ...`) for smoke-test verification.

---

## 4. Migration story (v1 → v2 → v3 cascade)

### 4.1 The dispatch table

`parseVaultHeader` currently handles `VERSION_V1` and `VERSION_V2`. v3 adds a third arm:

```
switch (version) {
  case 0x01: parseV1Header(blob)   // legacy — decrypt only
  case 0x02: parseV2Header(blob)   // v2 — decrypt only after v3 ships
  case 0x03: parseV3Header(blob)   // current — encrypt + decrypt
  default:   throw "Vault uses unsupported version byte"
}
```

`parseVaultHeader` gains a `kdfId` and `kdfParams` field on its return shape **only when version === 0x03**:

```
{ version, salt, iv, ct, tag, kdfId?, kdfParams? }
```

For v1 and v2, `kdfId` and `kdfParams` are `null`/`undefined`.

### 4.2 Key-derivation dispatch

`deriveKeyForHeader(header, unseal)` (currently a small helper in `vault.js:271-275`) gains a third branch:

| header.version | unseal.kind | Derivation |
|---|---|---|
| 0x01 | "key" | Use `unseal.key` directly (keychain users) |
| 0x01 | "passphrase" | `hkdfSync("sha256", passphrase, LEGACY_STATIC_SALT, HKDF_INFO, 32)` |
| 0x02 | "key" | Use `unseal.key` directly |
| 0x02 | "passphrase" | `hkdfSync("sha256", passphrase, header.salt, HKDF_INFO, 32)` |
| 0x03 | "key" | Use `unseal.key` directly (keychain users) |
| 0x03 | "passphrase" | `scrypt(passphrase, header.salt, 32, { N: 1<<header.kdfParams.logN, r, p, maxmem: 256*1024*1024 })` |

The keychain path bypasses the KDF in **all three versions**. This is the same property v2 already has, extended naturally.

### 4.3 Write path

`writeVaultObject` always emits v3:

```
1. unseal = await getUnsealMaterial()
2. salt   = randomBytes(16)
3. iv     = randomBytes(12)
4. params = { logN: 17, r: 8, p: 1 }   // current floor; recheck against §2.3
5. key    = unseal.kind === "key"
              ? unseal.key
              : await scryptAsync(unseal.passphrase, salt, 32, { N: 1 << params.logN, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 })
6. cipher = createCipheriv("aes-256-gcm", key, iv)
7. ct, tag = encrypt(plaintext)
8. blob   = MAGIC || [0x03, 0x01, 0x03, params.logN, params.r, params.p, 0x10] || salt || iv || ct || tag
9. safeAtomicWriteFileSync(paths.vault, blob)
```

There is no opt-out, no "preserve previous version" mode. Once a vault is rewritten, it is v3.

### 4.4 Cascade behavior

| Starting state | First op after upgrade | On-disk after | Notes |
|---|---|---|---|
| v1 vault, never read since upgrade | `Vault.get` | v1 (unchanged) | G3 — reads don't migrate |
| v1 vault | `Vault.set` | v3 | Read decodes v1 with HKDF+legacy salt; write emits v3 with scrypt |
| v2 vault | `Vault.get` | v2 (unchanged) | G3 |
| v2 vault | `Vault.set` | v3 | Read decodes v2 with HKDF+embedded salt; write emits v3 with scrypt |
| v3 vault | any | v3 | steady state |
| Mixed (profile A v3, profile B v1) | per-profile basis | each profile migrates on its own first write | No cross-profile coupling |

This is identical in shape to v2's migration discipline, extended one layer.

### 4.5 The `_unsealMaterialCache` carries forward correctly

The `_unsealMaterialCache` stores the `unseal` discriminated union (either `{kind:"key", key:Buffer}` or `{kind:"passphrase", passphrase:string}`). For passphrase users, the **passphrase string itself** is what's cached, NOT a derived key. This is critical: it means a v2 → v3 transition uses the **same passphrase** as input to the new KDF, with the **new salt** and **new params**. The user's stored passphrase never changes; only the derivation function does.

The legacy `_keyCache` (the actual derived 32-byte key) is no longer the right thing to cache for passphrase users in v3, because the per-blob salt forces re-derivation per blob. **However**: in steady state a single MCP server process reads and writes one profile's vault, so the (passphrase, salt, params) tuple is stable across reads-of-the-same-blob. A small additional cache keyed on `(passphrase, salt, logN, r, p)` would amortize the KDF cost across the few reads-without-write that happen between cache resets. This is a perf optimization, NOT a correctness requirement; defer to the implementation phase. The simple version: re-derive on every read; with caching, only on the first read after `__resetKeyCache`.

### 4.6 Linux-without-libsecret scenario (explicit walkthrough)

This is the user from `linux/perplexity-codex-mcp-setup-issue.md` and the saved-memory item "Linux is first-class". Walk:

1. Ubuntu 24.04 fresh install, no gnome-keyring, no libsecret.
2. User installs the VSCode extension → daemon spawns → daemon imports `keytar` → keytar throws because libsecret is absent.
3. Daemon falls through to `PERPLEXITY_VAULT_PASSPHRASE` env var (set via the extension's `vault-passphrase.ts` SecretStorage prompt).
4. `getUnsealMaterial` returns `{kind: "passphrase", passphrase: "<user's choice>"}`.
5. **First operation** (e.g. login completes, login-runner calls `vault.set("default", "cookies", ...)`):
   - The profile dir is freshly created → no existing vault.enc.
   - `writeVaultObject` runs scrypt with the user's passphrase + fresh random salt + default params (logN=17). **One-shot cost: ~300ms** on the user's CPU. User's UI shows "logging in..." regardless; this is invisible.
   - Resulting vault.enc is v3.
6. **Subsequent operations** in the same process: `_unsealMaterialCache` and (with the optional optimization) the derived-key cache cover them. **Zero scrypt cost.**
7. **MCP server restart** (e.g. user restarts Cursor, or the `.reinit` watcher fires after an account switch): caches reset, next vault op pays scrypt cost once. ~300ms. Invisible to user.
8. **Account switch** in the dashboard: triggers `__resetKeyCache()` via `.reinit`. Same as restart.

For this user, the v3 upgrade is invisible at typical interaction cadence. They never compile a native module, they never see a "vault locked" error from a missing dependency, and their weak passphrase becomes computationally expensive to attack offline.

---

## 5. Public API impact

### 5.1 Externally observable signatures (must NOT change)

The seven callers in `config.ts`, `cli.js`, `health-check.js`, `login-runner.js`, `manual-login-runner.js`, `logout.js`, plus tests, all go through:

```ts
class Vault {
  get(profile: string, key: string): Promise<string | null>;
  set(profile: string, key: string, value: string): Promise<void>;
  delete(profile: string, key: string): Promise<void>;
  deleteAll(profile: string): Promise<void>;
}
```

These do not change. The async-ness is preserved; scrypt is invoked via `crypto.scrypt`'s callback wrapped in a Promise (or `crypto.scryptSync` if the codebase prefers — both are Node built-in).

### 5.2 Lower-level primitive signatures (must also NOT change)

```ts
function encryptBlob(plaintext: Buffer, key: Buffer): Buffer;
function decryptBlob(blob: Buffer, key: Buffer): Buffer;
```

These are the format-versioned helpers consumed by tests and by the keychain code path. Their signatures stay; internally:

- `encryptBlob` always emits v3. The KDF is **NOT invoked** because the caller passes a 32-byte key directly (this is the keychain-style API; the salt embedded in the v3 blob is generated and stored but the KDF isn't used because the key is already material).
- `decryptBlob` accepts v1, v2, and v3 blobs. For v3 blobs decrypted via `decryptBlob(blob, key)`, the KDF is **not** invoked — the 32-byte key is used directly (analogous to the v2 keychain-key-on-v2-blob case in `vault.js:120-130`). The embedded KDF params are parsed and validated structurally but ignored for derivation.

This deliberate split keeps the public primitive testable with a deterministic key and free of KDF cost in unit tests, while the higher-level `readVaultObject` / `writeVaultObject` (which know whether the unseal is keychain-key or passphrase) are the ones that invoke scrypt.

### 5.3 Unseal-material API (NO breaking change)

```ts
type UnsealMaterial =
  | { kind: "key"; key: Buffer }
  | { kind: "passphrase"; passphrase: string };

function getUnsealMaterial(): Promise<UnsealMaterial>;
function getMasterKey(): Promise<Buffer>;
```

Both signatures preserved verbatim. `getMasterKey()` continues to return a 32-byte Buffer for back-compat — for passphrase users it derives via HKDF + legacy static salt (the existing v2 behavior in `vault.js:255-264`), which is **intentionally not the v3 derivation**. This is fine because:

- `getMasterKey` is consumed by the test harness and by the `decryptBlob`/`encryptBlob` keychain-style path.
- Real read/write traffic goes through `readVaultObject` / `writeVaultObject` which call a new internal `deriveKeyForHeader(header, unseal)` that does the right thing per version.

### 5.4 New internal helper (not exported)

```js
async function deriveKeyForHeader(header, unseal) {
  if (unseal.kind === "key") return unseal.key;
  switch (header.version) {
    case VERSION_V1:
      return hkdfFromPassphrase(unseal.passphrase, LEGACY_STATIC_SALT);
    case VERSION_V2:
      return hkdfFromPassphrase(unseal.passphrase, header.salt);
    case VERSION_V3:
      if (header.kdfId !== KDF_ID_SCRYPT) {
        throw new Error(`Vault uses unsupported KDF id: 0x${header.kdfId.toString(16)}.`);
      }
      const { logN, r, p } = header.kdfParams;
      if (logN < SCRYPT_LOGN_FLOOR) {
        throw new Error(`Vault scrypt parameters below security floor (logN=${logN} < ${SCRYPT_LOGN_FLOOR}).`);
      }
      return scryptAsync(unseal.passphrase, header.salt, 32, {
        N: 1 << logN,
        r,
        p,
        maxmem: 256 * 1024 * 1024,
      });
    default:
      throw new Error(`Vault uses unsupported version byte: ${header.version}.`);
  }
}
```

This is the **only** new function with non-trivial logic. Everything else in `vault.js` is incrementally extended, not restructured.

### 5.5 Updated `vault.d.ts`

No changes required. The discriminated union and signatures remain exactly as they are after v2. The KDF identifier and parameters are internal-only.

---

## 6. Performance / parameter tuning

### 6.1 Where the cost is paid (and isn't)

| Scenario | Frequency | Cost on passphrase user | Cost on keychain user |
|---|---|---|---|
| MCP server cold start, first vault op | Once per process | ~300ms (one scrypt) | ~10ms (keytar lookup) |
| Subsequent vault ops same process | Per-op | <1ms (cache hit) | <1ms (cache hit) |
| `__resetKeyCache()` then next vault op (account switch, login, logout, `.reinit` event) | Per state change | ~300ms (one scrypt) | ~10ms (keytar lookup) |
| `Vault.get` followed by `Vault.set` (e.g. cookie refresh) | Internal to `set()` | One scrypt for the read, one for the write — but `_unsealMaterialCache` covers them, so really one scrypt total per process (or per the optional derived-key cache window) | One keytar |
| `encryptBlob` / `decryptBlob` direct call with explicit key | Test / direct API | Zero KDF cost (key is passed in) | Same |

### 6.2 Target

**≤ 500ms per cold-start scrypt invocation on a 2020-class laptop** (Intel i5-1135G7 / Apple M1 or equivalent). This is the OWASP Cheat Sheet recommendation for "user-interactive" KDF latency. The `_unsealMaterialCache` keeps the user from feeling this cost more than once per process / state-change.

### 6.3 Tuning floor and ceiling

- **Floor (refuse to use):** `logN < 16` → throws `"Vault scrypt parameters below security floor"`. This protects against an attacker who tampers with disk to force `logN=8` and offers a sub-millisecond derivation. Floor is checked at decrypt time, not just encrypt.
- **Ceiling (advisory):** `logN > 22` → log a warning ("scrypt cost factor above 4M iterations may exceed MCP server startup time budgets") but proceed. We do not refuse high values; the user might be running on a beefy server.
- **Default:** `logN = 17` (N=131072), `r = 8`, `p = 1`. Re-evaluate annually against the OWASP recommendation.

### 6.4 CI runner caveat

CI runners (especially shared GitHub Actions runners) are often 5-10× slower than a developer laptop. A 300ms-on-laptop scrypt becomes 1.5-3s on CI. This is **fine** — vault tests run a handful of times per suite, not in tight loops. But:

- Tests that call `Vault.set`/`Vault.get` MUST NOT use the production default `logN=17`. Instead, tests should set `PERPLEXITY_VAULT_SCRYPT_LOGN` (a new env var read at write time) to a low value like `12` (N=4096, ~5ms) for fast test iteration. The decrypt-time floor check at `logN < 16` would then need an explicit test-mode bypass — see Open Question Q2.
- The new derivation path's ~300ms cost adds up across all the new v3-from-scratch test cases. If even with the env-var override the suite gets >30s slower, we may need a process-wide test seam (`__setKdfParams({logN: 12})`) instead of an env var.

This is a real constraint but a fixable one. The full design choice is captured in §10 Q2.

### 6.5 Memory cost on small devices

128 MiB peak memory during scrypt is significant on a Raspberry Pi (1-4 GiB total RAM) or a small WSL allocation. The `maxmem: 256MiB` cap prevents runaway, but a Pi-class device with other workloads might OOM during the derivation. Options for that case:

- Reduce `logN` to 16 (64 MiB peak) or 15 (32 MiB peak) — still well above the security floor for short-term use.
- Document the trade-off; let the operator override via env var if needed.

This is not blocking; it's a docs item.

---

## 7. Test plan

Each bullet is one `it(...)` case. Existing v1 and v2 tests stay; these are additions. Coverage floor for `vault.js` remains ≥95% — every new branch must be exercised.

### 7.1 v3 from scratch

- **(v3.1)** Empty profile dir + `Vault.set` → resulting `vault.enc` has version byte `0x03`, KDF_ID `0x01`, KDF_PARAMS_LEN `0x03`, valid params, 16-byte salt. Read returns the same plaintext.
- **(v3.2)** Two independent profiles get independent salts. (Same property as v2; re-asserted at v3 layer.)
- **(v3.3)** Two writes to the same profile produce two different salts (fresh-per-write).
- **(v3.4)** `encryptBlob(plaintext, KEY)` (the keychain-style API) produces a v3 blob with `KDF_ID = 0x01` and embedded params, but the KDF is **not** invoked (verified by mocking `crypto.scrypt` to throw — call must succeed). The salt and params are still embedded for format uniformity.
- **(v3.5)** `decryptBlob(v3blob, KEY)` (the keychain-style API) decodes a v3 blob without invoking scrypt.

### 7.2 v1 → v3 migration

- **(mig.1)** Build a v1 blob with the legacy static-salt HKDF derivation and a known passphrase. Read with the same passphrase via `Vault.get`. Returns the original plaintext. **File on disk unchanged.** (G3)
- **(mig.2)** After a v1 read, call `Vault.set("foo", "bar")`. New on-disk vault has version `0x03`, `KDF_ID = 0x01`, valid scrypt params.
- **(mig.3)** After mig.2, both the original v1-stored value AND the new v3-set value are readable.
- **(mig.4)** Multi-step cascade: v1 vault → `Vault.get` (still v1) → `Vault.set` (now v3) → another `Vault.get` (uses v3 path).

### 7.3 v2 → v3 migration

- **(mig.5)** Build a v2 blob using HKDF + embedded salt. Read with the same passphrase via `Vault.get`. Returns the original plaintext. **File unchanged.**
- **(mig.6)** After a v2 read, call `Vault.set`. New on-disk vault is v3.
- **(mig.7)** Cascade: v2 vault → `Vault.get` (still v2) → `Vault.set` (now v3) → another `Vault.get` (uses v3 path with scrypt).

### 7.4 Wrong passphrase distinguishability

- **(err.1)** v3 vault written with passphrase A; read attempt with passphrase B throws `/decrypt|passphrase|wrong key|corrupted ciphertext/i`. **File unchanged.** Must NOT match `/truncated|wrong magic|unsupported version|invalid salt length|kdf|scrypt parameters/i` (those are structural, distinguishable errors).
- **(err.2)** v3 vault: the wrong-passphrase derivation must complete successfully (scrypt always succeeds; only AES-GCM fails). The error origin is the AES-GCM tag mismatch, not the KDF. (Implicit; no separate test, but the err.1 flow exercises this.)

### 7.5 Corrupted KDF parameters

- **(err.3)** v3 blob with `logN = 8` (below floor) → throws `/scrypt parameters below security floor/i`. Distinct from wrong-passphrase.
- **(err.4)** v3 blob with `KDF_ID = 0x99` (unrecognized) → throws `/unsupported KDF/i`. Distinct from wrong-passphrase.
- **(err.5)** v3 blob with `KDF_PARAMS_LEN = 0x05` but `KDF_ID = 0x01` (scrypt expects len=3) → throws `/invalid KDF params length/i` or `/KDF params|kdf parameters/i`.
- **(err.6)** v3 blob with valid header but `r = 0` (invalid) → throws (scrypt itself rejects), distinguishable from wrong-passphrase.
- **(err.7)** v3 blob with truncated KDF_PARAMS region (e.g. KDF_PARAMS_LEN says 3 but blob is too short to contain them) → throws `/truncated|too short/i`.

### 7.6 Tampered v3 blob

- **(err.8)** v3 blob with one byte flipped in ciphertext → AES-GCM tag fails → `/decrypt|passphrase|wrong key|corrupted ciphertext/i`. NOT structural.
- **(err.9)** v3 blob with one byte flipped in salt → scrypt produces a different key → AES-GCM tag fails → `/decrypt|passphrase|wrong key|corrupted ciphertext/i`. (This is correct: tampered salt is indistinguishable from wrong passphrase, by construction.)
- **(err.10)** v3 blob with one byte flipped in KDF_PARAMS (e.g. logN bumped to 18) → scrypt produces a different key → AES-GCM tag fails. Same outcome as err.9.

### 7.7 Keychain users with v3 blobs

- **(kc.1)** With keytar mocked to return a fixed 32-byte key, write a v3 vault. `crypto.scrypt` is **not invoked** during the write (verified by mocking it to throw — must not be called on the keychain path). Read succeeds, ignoring the embedded KDF params.
- **(kc.2)** Keychain-mocked process reading a v3 vault written by a passphrase-mocked process (cross-mode) → succeeds. (Conceptual: in practice users don't switch between modes mid-vault, but the format must support it because the same `vault.enc` could in principle be opened via either path if the unseal material happens to match. In practice: a vault written by passphrase has a key derived from `scrypt(passphrase, salt)`, NOT a random 32-byte keychain key — so this scenario only succeeds if you happen to copy the keychain key into the passphrase env var, which is contrived. Cover this with a test that shows the keychain-written v3 blob (where the embedded salt is unused at write) can be read by the same keychain. The cross-mode case is moot — assert via comment.)

### 7.8 Re-tuning

- **(retune.1)** Process emits a v3 blob with `logN=17`. A second process (mocked to use `logN=18` at write time via env var or `__setKdfParams`) reads the first's blob (uses logN=17 from the embedded params) and writes its own (uses logN=18). Both blobs round-trip.
- **(retune.2)** A v3 blob with `logN=18` read by a process configured with `logN=17` write defaults — read succeeds (uses embedded params, not write defaults).

### 7.9 Atomicity

- **(atom.1)** Mock `safeAtomicWriteFileSync` to throw on first call. Existing v2 vault → `Vault.set` throws → v2 vault on disk is **byte-identical** to before. (Same property as v2 spec §9 case 7, repeated for v3 layer.)
- **(atom.2)** Same with v1 vault.

### 7.10 Cache reset

- **(cache.1)** After a v3 write migrates a v2 vault, `__resetKeyCache()` then re-resolve master key still produces a working decrypt path. (Sanity for the cache wiring.)

### 7.11 Doctor regression

- **(doc.1)** `checks/vault.js` `run()` against a config dir containing a v3 vault.enc reports `encryption: pass`. (Same as v1/v2 — the doctor doesn't probe format details.)

### 7.12 Coverage probes

- **(cov.1)** `parseVaultHeader` v3 truncation branches: blob length < 7 (no KDF_ID_LEN), blob length < 7+kdfParamsLen (no params), blob length < salt offset (no salt), blob length < iv offset (no iv), blob length < auth-tag offset (no tag). Each → distinguishable structural error.
- **(cov.2)** `KDF_ID = 0x00` → `/unsupported KDF|invalid KDF id/i`.
- **(cov.3)** `KDF_PARAMS_LEN = 0x00` (no params at all) → `/invalid KDF params length|KDF params/i`.

---

## 8. Implementation plan (for the FUTURE implementation task — NOT this task)

### 8.1 File scope

| File | Change | Effort |
|---|---|---|
| `packages/mcp-server/src/vault.js` | Add `VERSION_V3 = 0x03`, `KDF_ID_SCRYPT = 0x01`, `SCRYPT_LOGN_DEFAULT = 17`, `SCRYPT_LOGN_FLOOR = 16`, `SCRYPT_R_DEFAULT = 8`, `SCRYPT_P_DEFAULT = 1`, `SCRYPT_MAXMEM = 256*1024*1024`. Extend `parseVaultHeader` with a v3 arm returning `{version, salt, iv, ct, tag, kdfId, kdfParams}`. Add `deriveKeyForHeader` (replacing the inline branch). Promisify `crypto.scrypt`. Update `encryptBlob` to emit v3 with embedded KDF params (the KDF is NOT invoked from `encryptBlob` — it accepts a pre-derived 32-byte key). Update `writeVaultObject` to invoke scrypt for passphrase users. | Medium |
| `packages/mcp-server/src/vault.d.ts` | No external-API changes. Possibly export `VERSION_V3` for test introspection. | Tiny |
| `packages/mcp-server/test/vault.test.js` | Add §7 cases. Re-use the existing v1 fixture builder pattern; add v2 + v3 fixture builders. Add a fast-test-mode for KDF cost (env var or seam). Existing v1 and v2 tests stay unchanged (their fixture builders are version-pinned). | Medium |
| `packages/mcp-server/test/checks/vault.test.js` | Add one regression case (doc.1). | Tiny |

**Out of scope for this commit:**

- All seven vault callers (`config.ts`, `cli.js`, `health-check.js`, `login-runner.js`, `manual-login-runner.js`, `logout.js`) — unchanged.
- `packages/extension/src/auth/vault-passphrase.ts` — unchanged.
- `packages/mcp-server/src/checks/vault.js` doctor — unchanged.
- `tsup.config.ts` (mcp-server and extension) and `prepare-package-deps.mjs` — unchanged because the chosen KDF (scrypt) has zero new dependencies. **If the user picks argon2id** (Open Question Q1), this row becomes a real change: add `argon2` to `packages/mcp-server/package.json` dependencies, add to externals in both tsup configs, add to `prepare-package-deps.mjs` copy list.

### 8.2 Suggested commit messages

This is one logical change. Suggest a single commit:

```
feat(vault): add v3 KDF stretching with scrypt

Adds vault format v3 with scrypt-based key derivation for passphrase
users (logN=17, r=8, p=1; ~300ms one-shot cost cached for the process
lifetime). Rainbow tables defeated since v2; this commit adds the
work-factor that defeats targeted offline brute-force on weak
passphrases.

v1 and v2 vaults remain readable; first write after v1/v2 read rewrites
as v3. Keychain users (Windows/macOS/Linux+libsecret) bypass the KDF
and see no perceptible change.

Format: [MAGIC 4][VERSION 0x03][KDF_ID 1][KDF_PARAMS_LEN 1][KDF_PARAMS n][SALT_LEN 1][SALT 16][IV 12][CT m][TAG 16].

Spec: docs/superpowers/specs/2026-04-28-vault-v3-kdf-stretch-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

### 8.3 Validation gates (in order)

1. `npm run -w @perplexity-user-mcp/shared build` (always first per CLAUDE.md).
2. `npm run typecheck` — both `mcp-server` and `extension`.
3. `npx vitest run packages/mcp-server/test/vault.test.js` — full vault suite, must include all v1, v2, v3 cases.
4. `npx vitest run packages/mcp-server/test/checks/vault.test.js` — doctor regression.
5. `npm run test:coverage` — confirm `vault.js` ≥95% per-file (enforced).
6. `npm run test` — full suite, catch any incidental break.
7. **Manual smoke** per `docs/release-process.md`:
   - Build VSIX. Install on a Linux box (Ubuntu 24.04, no libsecret) with a v1 vault from a previous install.
   - `xxd ~/.perplexity-mcp/profiles/default/vault.enc | head -1` shows `5058 5654 01...` (v1).
   - Open VSCode, trigger any auto-vault-write (e.g. account-switch in dashboard).
   - `xxd` again shows `5058 5654 0301 0311 0801 10...` (v3 with default params).
   - Restart VSCode, login still works (caches were cleared).
8. **Perf smoke:** time the first `Vault.get` in a fresh process — must be ≤500ms on the dev laptop (instrument with `console.time` temporarily; remove before commit).

### 8.4 Documentation deliverables

Out of scope for the source commit; queue for a separate docs commit:

- `CHANGELOG.md` — entry for v3.
- `packages/mcp-server/README.md` — security note paragraph (forward-only migration).
- `docs/vault-unseal.md` (if it exists) — note the new KDF and its cost on first unseal.

---

## 9. Risks and mitigations

### R1. Performance regression on slow CI runners

**Risk:** Default `logN=17` is ~300ms on dev laptop, ~3s on shared GitHub Actions runner. Multiplied across the new test cases that exercise real write paths, the test suite could grow by 30+ seconds.

**Mitigation:**

- Fast-test-mode env var `PERPLEXITY_VAULT_SCRYPT_LOGN` (default = 17, set to 12 in tests for ~5ms derivations).
- Decrypt-time floor check (`logN < 16` rejected) gets a test-mode bypass via the same env var to avoid the floor rejecting test-written blobs. (See Q2.)
- Alternative: pure module-level seam `__setKdfParamsForTest({logN: 12})` instead of env var. Cleaner, no env-var sprawl.

### R2. Argon2id native build issues on Windows (only if user picks argon2id over scrypt)

**Risk:** `argon2` npm uses `node-gyp`. Windows users without Build Tools see install-time failure. The MCP server fails to start with a cryptic `Cannot find module 'argon2'` error.

**Mitigation: pick scrypt.** This is the recommendation. If the user picks argon2id (Q1), mitigations include shipping pre-built binaries via `node-pre-gyp` (the `argon2` package does this for major platforms but coverage is incomplete), and adding a fallback path to scrypt if `import("argon2")` throws (which complicates the v3 dispatch table — would need `KDF_ID = 0x03 = scrypt-fallback-from-argon2id` and bidirectional read support).

### R3. Operator misconfiguration of KDF params

**Risk:** Operator sets `PERPLEXITY_VAULT_SCRYPT_LOGN=8` in their `mcp.json` to "speed things up." Vault becomes weak.

**Mitigation:** Hard-coded floor at `SCRYPT_LOGN_FLOOR = 16`. The env var override clamps to floor and logs a warning. The floor check at decrypt time prevents an attacker from tampering with disk to force weak params.

### R4. 128 MiB memory peak on small devices (Raspberry Pi class)

**Risk:** On a 1 GiB Raspberry Pi running the MCP server alongside other workloads, scrypt's 128 MiB peak could OOM.

**Mitigation:** Documented trade-off; operator may override `PERPLEXITY_VAULT_SCRYPT_LOGN` down to 16 (64 MiB) or 15 (32 MiB) at the cost of a smaller work factor. Both still far above the historical HKDF zero-cost.

### R5. Process-level cache invalidation race during the migration

**Risk:** Two MCP server processes (extension daemon + standalone Cursor stdio server) concurrently write to the same v2 vault, both deciding to migrate to v3.

**Mitigation:** Same as v2 (spec §7 "Concurrent migration races"). `safeAtomicWriteFileSync` rename gives last-write-wins. Both blobs are valid v3 blobs derived from the same passphrase but with different salts and (potentially) different KDF params. The losing write's update to the JSON content is overwritten — same race as today's any-concurrent-writer scenario, no new failure mode.

### R6. The new error messages break existing test assertions

**Risk:** Test cases use `.toThrow(/regex/)` patterns that the new error wording could miss.

**Mitigation:** Reviewed against `vault.test.js` (per the v2 spec's R6 review). The new error wording for v3 (`/scrypt parameters below security floor/`, `/unsupported KDF/`, `/invalid KDF params length/`) is **additive**, not replacing existing strings. Existing assertions like `/decrypt/i`, `/magic/i`, `/version/i`, `/corrupt|unreadable/i`, `/truncated|too short/i`, `/salt.*length|invalid salt/i` continue to pass against v3 blobs that exhibit those failure modes.

### R7. Coverage drop below 95%

**Risk:** Adding `deriveKeyForHeader`'s v3 branch + the parameter-validation paths without testing every branch could drop coverage.

**Mitigation:** Test plan §7.5, §7.6, §7.12 cover every new branch (KDF_ID rejection, params-length validation, floor check, malformed params, truncation in each new region). Confirm via `npm run test:coverage` before commit.

### R8. The `_keyCache` semantics now subtly wrong for v3 passphrase users

**Risk:** `_keyCache` historically held a single 32-byte derived key for the whole process. With v3, the per-blob salt means a single derived key is no longer valid across blobs.

**Mitigation:** The optional derived-key cache (§4.5) is keyed on `(passphrase, salt, logN, r, p)` and reads the cache key from the parsed header on each blob open. For the simple version (no derived-key cache), re-derive on every read — accept the cost. The `_unsealMaterialCache` is the load-bearing cache; the derived-key cache is opt-in optimization.

### R9. Forward-compatibility constraint on `KDF_ID` namespace

**Risk:** A future v4 might want a wholly new format (per-profile keys, FIDO2 hardware unseal). If we only have a 1-byte `KDF_ID`, we have 256 slots — not unlimited but plenty.

**Mitigation:** v4 can bump the version byte (we have 252 unused version values) rather than reusing v3's KDF_ID namespace. The KDF_ID stays scoped to "what KDF is used to derive a key from a passphrase" within the v3 format.

---

## 10. Open questions for the user

These need resolution before implementation begins.

### Q1. scrypt or argon2id?

**Recommendation: scrypt.**

- **Pro scrypt:** Node built-in (no native build, no Windows install-tools risk, no extra tsup external, no extra `prepare-package-deps.mjs` entry). Linux-without-libsecret users are unaffected. Pedigree solid since 2009.
- **Pro argon2id:** Strictly better side-channel resistance and memory-hardness profile. Industry recommendation for new systems (PHC winner 2015, OWASP recommends argon2id for new applications when feasible).
- **Why I land on scrypt:** the security delta is small in this threat model (no co-tenant adversary), and the operational delta is large (zero new dep vs. native module that breaks on Windows-without-VS-Build-Tools). The format reserves `KDF_ID = 0x02` for argon2id so a future swap is clean.

**Question:** override to argon2id? If yes, the implementation grows by one tsup-config row + one prepare-package-deps row + one fallback path for missing native build, and the format `KDF_ID` byte becomes `0x02` instead of `0x01`.

### Q2. Test-mode override for the KDF cost — env var or module seam?

The new test cases write real v3 blobs through the production write path. With `logN=17`, each one costs 300ms+ (more on CI). Across ~30 new test cases, that's 10+ seconds added to the suite.

- **Option A — env var `PERPLEXITY_VAULT_SCRYPT_LOGN`** (recommended): tests set it to `12` (~5ms). Production never sets it, defaults to 17. Floor check (`< 16` rejected) needs a test-mode bypass: either via a separate env var `PERPLEXITY_VAULT_SCRYPT_FLOOR_BYPASS=1`, or by suppressing the floor check when the env override is present.
- **Option B — module-level seam `__setKdfParamsForTest({logN: 12})`** (cleaner): no env vars. Floor check stays unconditional in prod; tests call the seam to override. Downside: requires a new exported test-only function, which has historically been frowned on in this codebase (vault.js has `__resetKeyCache` already, so precedent exists).

**Question:** A or B? I lean B for cleanliness; A if the user prefers to avoid test-only exports.

### Q3. Per-process startup unseal cost — confirm ≤500ms is acceptable, or relax?

The recommended `logN=17` targets ~300ms on a 2020 laptop. The user's spec mentioned "≤500ms on a 2020 laptop" as the target. On a 2024 laptop it's closer to 150-200ms; on a 2026 laptop, even less. This headroom suggests we **could** push `logN=18` (N=262144, ~600ms on 2020 laptop, ~300ms on 2024 laptop) and still feel snappy on modern hardware while doubling the work factor.

**Question:** stick with `logN=17` (300ms / 35-CPU-year resistance for 6-char passphrase) or push to `logN=18` (600ms / 70-CPU-year)? I recommend 17 for the immediate ship and a re-tune to 18 in the next annual review.

### Q4. Should the spec also document a **mandatory** future per-profile key migration?

Per-profile keys (each profile's vault uses a key derived from `scrypt(passphrase, salt) || profile_name`) close the "compromise of one profile leaks all profiles" threat. v3 doesn't address this. Should the spec mention it as a planned v4, or leave it out of scope entirely?

**Recommendation: mention as a v4 candidate in §1.4 "Non-goals" (already there in skeleton form), no design work in this spec.**

---

## Appendix A — Quick byte-layout reference

```
v1 (legacy, decrypt-only):
  PXVT 01 [iv 12] [ct n] [tag 16]                                    headers: 17 + 16 = 33 bytes

v2 (legacy, decrypt-only after v3 ships):
  PXVT 02 10 [salt 16] [iv 12] [ct n] [tag 16]                       headers: 34 + 16 = 50 bytes

v3 (current, written by all upgraded clients):
  PXVT 03 01 03 [logN 1] [r 1] [p 1] 10 [salt 16] [iv 12] [ct n] [tag 16]   headers: 39 + 16 = 55 bytes
       ^^ ^^ ^^                       ^^
       |  |  |                        SALT_LEN
       |  |  KDF_PARAMS_LEN
       |  KDF_ID = scrypt
       VERSION_V3
```

## Appendix B — `xxd` smoke verification

```
xxd packages/.../profiles/<name>/vault.enc | head -1
# v1: 5058 5654 01...
# v2: 5058 5654 0210 [16 salt] [12 iv]...
# v3: 5058 5654 0301 0311 0801 10 [16 salt] [12 iv]...
#     PXVT |  |  |  |  |  |  |
#          |  |  |  |  |  |  SALT_LEN = 16
#          |  |  |  |  |  p = 1
#          |  |  |  |  r = 8
#          |  |  |  logN = 17 (N = 131072)
#          |  |  KDF_PARAMS_LEN = 3
#          |  KDF_ID = 0x01 = scrypt
#          VERSION = 0x03
```

## Appendix C — Linux-without-libsecret end-to-end

The single highest-friction user (per `linux/perplexity-codex-mcp-setup-issue.md`) on a fresh Ubuntu without gnome-keyring / libsecret:

1. `apt install code` then install the Perplexity MCP extension VSIX.
2. Extension daemon spawns. `import("keytar")` throws (no libsecret).
3. Extension's `vault-passphrase.ts` prompts in the SecretStorage UI: "Choose a vault passphrase." User enters (let's say) `"hunter2hunter2"`.
4. Extension stores in SecretStorage and injects as `PERPLEXITY_VAULT_PASSPHRASE` env var into every spawned MCP child + the daemon process itself.
5. User clicks "Login" in the dashboard. Login completes. `login-runner.js` calls `vault.set("default", "cookies", ...)`.
6. `writeVaultObject` runs. `getUnsealMaterial` returns `{kind:"passphrase", passphrase:"hunter2hunter2"}`. Random salt generated. `crypto.scrypt("hunter2hunter2", salt, 32, {N: 131072, r: 8, p: 1, maxmem: 256*1024*1024})` runs for ~300ms. Result is the AES-256-GCM key. `vault.enc` is written as v3.
7. User issues their first `perplexity_search`. `getSavedCookies` calls `vault.get("default", "cookies")`. Cache miss on first call → `_unsealMaterialCache` populates → `parseVaultHeader` reads v3 → `scrypt(...)` runs again for ~300ms (cache miss on derived key for this specific (passphrase, salt, params) tuple) → returns cookies.
8. Subsequent `perplexity_search` calls hit the derived-key cache (or, in the simple no-cache implementation, re-derive each time — at which point we should add the cache or accept ~300ms per tool call, which is unacceptable; **derived-key cache is therefore strongly recommended for v3 implementation**).
9. Account switch in dashboard → `.reinit` → `__resetKeyCache()` → next vault op pays the scrypt cost once.

The total user-perceptible scrypt cost over a typical 8-hour work session: ~300ms × (1 startup + 1 login + ~3 account switches) ≈ 1.5 seconds spread across the day. Worth ~100,000× attacker-cost amplification.

---

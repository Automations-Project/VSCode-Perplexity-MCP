import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const mcpServerRoot = join(repoRoot, "packages", "mcp-server");
const extensionRoot = join(repoRoot, "packages", "extension");
const extensionNodeModules = join(extensionRoot, "dist", "node_modules");

/**
 * Supported @ngrok/ngrok native platform variants shipped in the VSIX.
 *
 * 0.8.5 tried to bundle EVERY variant that the parent declared in
 * optionalDependencies (13 of them), which inflated the VSIX from 12.7 MB to
 * 60.5 MB. Almost none of those variants are covered by our smoke-test matrix
 * and we have no realistic plan to validate them, so we explicitly pick the
 * four we support and ship only those. Users on any other (os, cpu) land on
 * the lazy-load fix in packages/mcp-server/src/daemon/tunnel-providers/ngrok.js
 * which surfaces a clean `NgrokNativeMissingError` + "native-missing" setup
 * state rather than a crash.
 *
 * Smoke-test matrix alignment (docs/smoke-tests.md):
 *   - Ubuntu 22+          → @ngrok/ngrok-linux-x64-gnu
 *   - Windows 11          → @ngrok/ngrok-win32-x64-msvc
 *   - macOS 14+ (Intel)   → @ngrok/ngrok-darwin-x64
 *   - macOS 14+ (Apple Si)→ @ngrok/ngrok-darwin-arm64
 *
 * If this matrix ever changes, update BOTH this constant AND the matching
 * constant in packages/extension/tests/ngrok-cross-platform-packaging.test.ts.
 */
const SUPPORTED_NGROK_VARIANTS = [
  { name: "@ngrok/ngrok-linux-x64-gnu", os: "linux", cpu: "x64" },
  { name: "@ngrok/ngrok-darwin-x64", os: "darwin", cpu: "x64" },
  { name: "@ngrok/ngrok-darwin-arm64", os: "darwin", cpu: "arm64" },
  { name: "@ngrok/ngrok-win32-x64-msvc", os: "win32", cpu: "x64" },
];

/**
 * Root packages the extension loads at runtime. We do NOT include bundled-by-tsup
 * pure-JS deps (like got-scraping) — those are inlined into dist/extension.js by
 * the esbuild bundler. This list is only for packages that must ship with their
 * own node_modules tree at runtime (native binaries, dynamic requires, etc.).
 */
/**
 * IMPORTANT: The `dot-prop` and `is-obj` entries below are NOT there by accident.
 * Phase 2 carry-over #5 tracked a VSIX packaging gap where
 * `header-generator → dot-prop → is-obj` wasn't hoisted, causing got-scraping's
 * HTTP tier to silently fall back to the browser tier.
 *
 * The Phase 3 doctor check `native-deps/got-scraping-chain` audits this chain
 * at runtime. If you remove dot-prop or is-obj here, doctor will warn users
 * and their installs will work — but slower.
 *
 * See packages/mcp-server/src/checks/native-deps.js and docs/doctor.md.
 */
/**
 * Explicit source map for daemon runtime deps. We resolve these from
 * `packages/mcp-server/node_modules` FIRST, then fall back to the repo root.
 *
 * Why: keep all daemon-runtime deps resolving from the mcp-server workspace
 * first so the version mcp-server pins wins over any hoisted repo-root copy
 * (got, helmet, keytar, express, …). Daemon code is written against and
 * tested with the express version mcp-server pins; shipping a different
 * major from the VSIX would silently break the daemon on end-user machines.
 */
const rootPackages = [
  { name: "patchright", preferMcpServer: true },
  { name: "patchright-core", preferMcpServer: true },
  { name: "got-scraping", preferMcpServer: true },
  { name: "got", preferMcpServer: true, optional: true },
  { name: "tough-cookie", preferMcpServer: true, optional: true },
  { name: "header-generator", preferMcpServer: true, optional: true },
  { name: "fingerprint-generator", preferMcpServer: true, optional: true },
  { name: "keytar", preferMcpServer: true },
  { name: "dot-prop", preferMcpServer: true },
  { name: "is-obj", preferMcpServer: true },
  { name: "gray-matter", preferMcpServer: true },
  { name: "express", preferMcpServer: true },
  { name: "@ngrok/ngrok", preferMcpServer: true },
  { name: "helmet", preferMcpServer: true },
];

rmSync(extensionNodeModules, { recursive: true, force: true });
mkdirSync(extensionNodeModules, { recursive: true });

/**
 * Walk a package's dependency graph and copy each one into the extension's
 * runtime node_modules. Flat layout (npm 7+ hoist convention) — we look up
 * deps from the repo root's node_modules.
 */
// Resolve a package by walking up from a starting directory looking for
// node_modules/<pkg> (mirrors Node's own resolution). Falls back to the
// workspace-package node_modules trees for packages pinned there by npm.
function resolveFrom(startDir, packageName) {
  let current = startDir;
  while (true) {
    const candidate = join(current, "node_modules", packageName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const fallbacks = [
    join(repoRoot, "node_modules", packageName),
    join(mcpServerRoot, "node_modules", packageName),
    join(extensionRoot, "node_modules", packageName),
  ];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Copy a package and walk its deps. Transitive deps resolve relative to the
// SOURCE package's location so a nested `gray-matter/node_modules/js-yaml`
// wins over a hoisted root `js-yaml` of a different major version.
function copyRecursive(packageName, fromDir = repoRoot, seen = new Set()) {
  const source = resolveFrom(fromDir, packageName);
  if (!source) {
    throw new Error(`Required package "${packageName}" not found (searched from ${fromDir})`);
  }

  if (seen.has(source)) return;
  seen.add(source);

  const target = join(extensionNodeModules, packageName);
  if (!existsSync(target)) {
    cpSync(source, target, { recursive: true });
  }

  const manifestPath = join(source, "package.json");
  if (!existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const dep of Object.keys(deps)) {
      if (!resolveFrom(source, dep)) continue;
      // Transitive deps resolve from the source package's own dir so nested
      // node_modules (correct version) wins over hoisted mismatches.
      copyRecursive(dep, source, seen);
    }
  } catch {
    // malformed package.json — don't recurse further
  }
}

for (const entry of rootPackages) {
  const { name, preferMcpServer, optional } = entry;
  // preferMcpServer: start resolution from packages/mcp-server so the
  // mcp-server-pinned version wins over any hoisted repo-root copy. See
  // the rootPackages doc block above for the express 4 vs 5 rationale.
  const startDir = preferMcpServer ? mcpServerRoot : repoRoot;
  if (optional && !resolveFrom(startDir, name)) {
    console.warn(`[prepare-package-deps] optional package "${name}" not installed — skipping`);
    continue;
  }
  copyRecursive(name, startDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform native shipping for @ngrok/ngrok
// ─────────────────────────────────────────────────────────────────────────────
//
// @ngrok/ngrok uses the optionalDependencies-per-platform pattern (same as
// esbuild/swc/rollup): one subpackage per (os, cpu) triple, and npm only
// installs the one matching the BUILDER's platform. That means a VSIX packed
// on Windows ships only `@ngrok/ngrok-win32-x64-msvc` and crashes on Linux/
// macOS at activation when `@ngrok/ngrok/index.js` tries to require the
// matching subpackage.
//
// Fix: for every variant in the SUPPORTED_NGROK_VARIANTS matrix (see the top
// of this file), either copy it from the builder's node_modules (if present
// by luck) or pull it down fresh via `npm pack` and extract into
// dist/node_modules/@ngrok/. Results are cached by `<name>@<version>` under
// node_modules/.cache/ so repeat runs are fast.
//
// We ship ONLY the explicit supported matrix (4 variants), not every variant
// the parent declares (13 variants). Users on unsupported platforms land on
// the lazy-load path in packages/mcp-server/src/daemon/tunnel-providers/ngrok.js
// which surfaces a clean "native-missing" setup state rather than crashing
// activation. Going from 13 → 4 variants keeps the VSIX near its pre-0.8.5
// size (~12.7 MB) instead of ballooning to 60.5 MB.

const ngrokSource = resolveFrom(mcpServerRoot, "@ngrok/ngrok");
if (!ngrokSource) {
  throw new Error(
    `[prepare-package-deps] @ngrok/ngrok not found in mcp-server or repo root. ` +
      `Cannot materialize supported native subpackages.`
  );
}
const ngrokManifest = JSON.parse(readFileSync(join(ngrokSource, "package.json"), "utf8"));
const ngrokOptionalDeps = ngrokManifest.optionalDependencies ?? {};

// Cache directory for `npm pack` tarballs. Lives under node_modules/.cache
// (already git-ignored via the top-level node_modules rule) so repeat runs
// don't re-download.
const packCacheDir = join(repoRoot, "node_modules", ".cache", "prepare-package-deps");
mkdirSync(packCacheDir, { recursive: true });

function readVariantVersion(variantName) {
  // Prefer the installed subpackage's actual version; fall back to the parent's
  // declared range (typical npm pattern is to pin subpackages to parent version).
  const installed = resolveFrom(mcpServerRoot, variantName);
  if (installed) {
    try {
      const v = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version;
      if (v) return v;
    } catch {
      // fall through
    }
  }
  const declared = ngrokOptionalDeps[variantName];
  // Strip common semver operators so `npm pack` gets a concrete version.
  if (declared) return declared.replace(/^[\^~>=<\s]+/, "");
  return ngrokManifest.version;
}

function copyInstalledVariant(variantName) {
  const source = resolveFrom(mcpServerRoot, variantName);
  if (!source) return false;
  const target = join(extensionNodeModules, variantName);
  if (existsSync(target)) return true;
  cpSync(source, target, { recursive: true });
  console.log(`[prepare-package-deps] copied ${variantName} from local node_modules`);
  return true;
}

/**
 * Minimal synchronous tar.gz extractor. Handles the subset of the tar format
 * that `npm pack` emits: regular files (typeflag '0' / '\0'), directories
 * (typeflag '5'), and pax-extended-header long-name records (typeflag 'x',
 * keys `path=` and `linkpath=`). Ignores symlinks (npm packages don't ship
 * them) and hardlinks. Paths are stripped of a trailing `package/` prefix is
 * NOT done here — the caller handles that by consuming `<cacheDir>/package/`.
 */
function extractTarGzSync(tarballPath, destDir) {
  const buf = gunzipSync(readFileSync(tarballPath));
  const BLOCK = 512;
  let offset = 0;
  let longNameOverride = null;

  const parseOctal = (slice) => {
    const s = slice.toString("ascii").replace(/\0.*$/, "").trim();
    if (!s) return 0;
    return parseInt(s, 8) || 0;
  };
  const parseString = (slice) => slice.toString("utf8").replace(/\0.*$/, "");

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks = end of archive.
    if (header.every((b) => b === 0)) {
      offset += BLOCK;
      continue;
    }

    const name = parseString(header.subarray(0, 100));
    const size = parseOctal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0);
    const prefix = parseString(header.subarray(345, 500));
    let fullName = longNameOverride ?? (prefix ? `${prefix}/${name}` : name);
    longNameOverride = null;

    const dataSize = size;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + dataSize;
    const padded = Math.ceil(dataSize / BLOCK) * BLOCK;
    offset = dataStart + padded;

    if (!fullName) continue;

    if (typeflag === "x" || typeflag === "g") {
      // PAX extended header. Parse `<len> <key>=<value>\n` records.
      const paxData = buf.subarray(dataStart, dataEnd).toString("utf8");
      let cursor = 0;
      while (cursor < paxData.length) {
        const spaceIdx = paxData.indexOf(" ", cursor);
        if (spaceIdx < 0) break;
        const recLen = parseInt(paxData.slice(cursor, spaceIdx), 10);
        if (!Number.isFinite(recLen) || recLen <= 0) break;
        const record = paxData.slice(spaceIdx + 1, cursor + recLen - 1); // minus trailing \n
        const eqIdx = record.indexOf("=");
        if (eqIdx > 0) {
          const key = record.slice(0, eqIdx);
          const value = record.slice(eqIdx + 1);
          if (key === "path") longNameOverride = value;
        }
        cursor += recLen;
      }
      continue;
    }

    if (typeflag === "L") {
      // GNU long-name extension. Next header's name is the content of this block.
      longNameOverride = buf
        .subarray(dataStart, dataEnd)
        .toString("utf8")
        .replace(/\0.*$/, "");
      continue;
    }

    // Refuse path traversal.
    const normalized = fullName.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.includes("../")) {
      throw new Error(`[prepare-package-deps] refusing unsafe tar entry: ${fullName}`);
    }

    const outPath = join(destDir, normalized);

    if (typeflag === "5" || fullName.endsWith("/")) {
      mkdirSync(outPath, { recursive: true });
      continue;
    }
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf.subarray(dataStart, dataEnd));
      continue;
    }
    // Skip symlinks, hardlinks, device nodes, etc. — not used by npm packs.
  }
}

function fetchVariantViaNpmPack(variantName, version) {
  const specifier = `${variantName}@${version}`;
  const variantCacheDir = join(packCacheDir, variantName.replace(/[@/]/g, "_") + "-" + version);
  const extractedMarker = join(variantCacheDir, "package", "package.json");

  if (!existsSync(extractedMarker)) {
    mkdirSync(variantCacheDir, { recursive: true });
    console.log(`[prepare-package-deps] npm pack ${specifier}`);
    // `shell: true` needed on Windows so `npm` (npm.cmd) resolves correctly;
    // it's a no-op harm-free on POSIX. We pass argv as a single string to
    // avoid per-platform PATHEXT quoting issues — specifier is a fixed semver
    // pattern (no user input), so shell-injection is not a concern here.
    const packResult = spawnSync(
      `npm pack "${specifier}" --pack-destination="${variantCacheDir}" --no-audit --no-fund --prefer-offline --silent`,
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        shell: true,
      }
    );
    if (packResult.status !== 0) {
      throw new Error(
        `[prepare-package-deps] npm pack ${specifier} failed ` +
          `(exit ${packResult.status}): ${packResult.stderr || packResult.stdout || packResult.error?.message || "unknown"}`
      );
    }
    // Find the produced tarball (npm pack prints the filename to stdout, but
    // reading the directory is more robust across npm versions).
    const tarballs = readdirSync(variantCacheDir).filter((f) => f.endsWith(".tgz"));
    if (tarballs.length === 0) {
      throw new Error(
        `[prepare-package-deps] npm pack ${specifier} produced no .tgz in ${variantCacheDir}`
      );
    }
    const tarball = join(variantCacheDir, tarballs[0]);
    // Extract with a minimal built-in tar reader. The ustar/pax format is
    // trivial (512-byte header + padded data), and doing this ourselves dodges
    // the GNU-tar-vs-bsdtar-vs-Git-Bash path-escaping mess on Windows.
    extractTarGzSync(tarball, variantCacheDir);
  }

  const extractedPackageDir = join(variantCacheDir, "package");
  if (!existsSync(extractedPackageDir)) {
    throw new Error(
      `[prepare-package-deps] extracted package dir not found at ${extractedPackageDir}`
    );
  }
  const target = join(extensionNodeModules, variantName);
  if (!existsSync(target)) {
    cpSync(extractedPackageDir, target, { recursive: true });
  }
  console.log(`[prepare-package-deps] materialized ${specifier} from registry`);
}

for (const { name: variantName } of SUPPORTED_NGROK_VARIANTS) {
  // Sanity-check that the variant we're about to ship is still declared by
  // the parent @ngrok/ngrok as an optionalDependency. If upstream drops one
  // of our smoke-matrix variants, fail loudly so we don't silently ship a
  // mismatched native binary.
  if (!(variantName in ngrokOptionalDeps)) {
    throw new Error(
      `[prepare-package-deps] ${variantName} is in SUPPORTED_NGROK_VARIANTS but not in ` +
        `@ngrok/ngrok's optionalDependencies map. Either upstream dropped it or the matrix ` +
        `in ${fileURLToPath(import.meta.url)} is out of date.`
    );
  }
  if (copyInstalledVariant(variantName)) continue;
  const version = readVariantVersion(variantName);
  fetchVariantViaNpmPack(variantName, version);
}

// Programmatic assertion: the bundled daemon expects the express major
// declared by packages/mcp-server/package.json. If the hoist-order in the
// workspace ever changes and a different major slips into the VSIX, the
// daemon will fail at runtime on end-user machines. Fail the build here.
const expressManifestPath = join(extensionNodeModules, "express", "package.json");
if (!existsSync(expressManifestPath)) {
  throw new Error(
    `[prepare-package-deps] express/package.json missing at ${expressManifestPath}. ` +
      `Expected express to be copied into dist/node_modules. Check rootPackages in this file.`
  );
}
const mcpServerManifest = JSON.parse(
  readFileSync(join(mcpServerRoot, "package.json"), "utf8"),
);
const expectedExpressRange = mcpServerManifest.dependencies?.express ?? "";
const expectedExpressMajor = expectedExpressRange.replace(/^[\^~>=<\s]+/, "").split(".")[0];
const expressVersion = JSON.parse(readFileSync(expressManifestPath, "utf8")).version ?? "";
const expressMajor = expressVersion.split(".")[0];
if (!expectedExpressMajor) {
  throw new Error(
    `[prepare-package-deps] could not parse express dependency from ${join(mcpServerRoot, "package.json")}. ` +
      `Expected packages/mcp-server/package.json to declare "express" in dependencies.`
  );
}
if (expressMajor !== expectedExpressMajor) {
  throw new Error(
    `[prepare-package-deps] express major version mismatch: got ${expressVersion}, expected ^${expectedExpressMajor}. ` +
      `The bundled MCP daemon is pinned to the version declared in packages/mcp-server/package.json. ` +
      `Check rootPackages resolution order in ${fileURLToPath(import.meta.url)} — ` +
      `express must resolve from packages/mcp-server/node_modules, not the repo root.`
  );
}
console.log(`[prepare-package-deps] express ${expressVersion} OK`);

// Programmatic assertion: every variant in SUPPORTED_NGROK_VARIANTS must be
// materialized under dist/node_modules/@ngrok/ and its package.json os/cpu
// fields must match the matrix entry. A missing or mismatched variant means
// a VSIX packed on one smoke-test platform would crash on activation on the
// others (the 0.8.5 ship-blocker).
for (const { name: variantName, os: expectedOs, cpu: expectedCpu } of SUPPORTED_NGROK_VARIANTS) {
  const variantManifestPath = join(extensionNodeModules, variantName, "package.json");
  if (!existsSync(variantManifestPath)) {
    throw new Error(
      `[prepare-package-deps] ${variantName}/package.json missing at ${variantManifestPath}. ` +
        `The cross-platform native-shipping step in ${fileURLToPath(import.meta.url)} did not ` +
        `materialize this variant. VSIX would crash on activation on that platform.`
    );
  }
  const variantManifest = JSON.parse(readFileSync(variantManifestPath, "utf8"));
  const actualOs = Array.isArray(variantManifest.os) ? variantManifest.os : [];
  const actualCpu = Array.isArray(variantManifest.cpu) ? variantManifest.cpu : [];
  if (!actualOs.includes(expectedOs)) {
    throw new Error(
      `[prepare-package-deps] ${variantName} os mismatch: expected "${expectedOs}" in ` +
        `${JSON.stringify(actualOs)}. The tarball content does not match the SUPPORTED_NGROK_VARIANTS ` +
        `matrix entry — investigate in ${fileURLToPath(import.meta.url)}.`
    );
  }
  if (!actualCpu.includes(expectedCpu)) {
    throw new Error(
      `[prepare-package-deps] ${variantName} cpu mismatch: expected "${expectedCpu}" in ` +
        `${JSON.stringify(actualCpu)}. Investigate in ${fileURLToPath(import.meta.url)}.`
    );
  }
}
const variantShortNames = SUPPORTED_NGROK_VARIANTS.map((v) =>
  v.name.replace(/^@ngrok\/ngrok-/, "")
).join(", ");
console.log(
  `[prepare-package-deps] @ngrok/ngrok ${ngrokManifest.version} ` +
    `+ ${SUPPORTED_NGROK_VARIANTS.length} supported platform variants OK (${variantShortNames})`
);

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const extensionNodeModules = join(__dirname, "..", "dist", "node_modules");

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
const rootPackages = ["patchright", "patchright-core", "got-scraping", "keytar", "dot-prop", "is-obj", "gray-matter", "express"];

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
    join(repoRoot, "packages", "mcp-server", "node_modules", packageName),
    join(repoRoot, "packages", "extension", "node_modules", packageName),
  ];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePackageSource(packageName) {
  return resolveFrom(repoRoot, packageName);
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

for (const root of rootPackages) copyRecursive(root);

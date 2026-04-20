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
const rootPackages = ["patchright", "patchright-core", "got-scraping", "keytar", "dot-prop", "is-obj"];

rmSync(extensionNodeModules, { recursive: true, force: true });
mkdirSync(extensionNodeModules, { recursive: true });

/**
 * Walk a package's dependency graph and copy each one into the extension's
 * runtime node_modules. Flat layout (npm 7+ hoist convention) — we look up
 * deps from the repo root's node_modules.
 */
function copyRecursive(packageName, seen = new Set()) {
  if (seen.has(packageName)) return;
  seen.add(packageName);

  const source = join(repoRoot, "node_modules", packageName);
  const target = join(extensionNodeModules, packageName);

  if (!existsSync(source)) {
    throw new Error(`Required package "${packageName}" not found at ${source}`);
  }

  if (existsSync(target)) return; // already copied (diamond dep)
  cpSync(source, target, { recursive: true });

  // Pick up transitive deps from the package's own manifest.
  const manifestPath = join(source, "package.json");
  if (!existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const dep of Object.keys(deps)) {
      // Skip optional deps that weren't actually installed (platform-gated, etc.)
      const depDir = join(repoRoot, "node_modules", dep);
      if (!existsSync(depDir)) continue;
      copyRecursive(dep, seen);
    }
  } catch {
    // malformed package.json — don't recurse further
  }
}

for (const root of rootPackages) copyRecursive(root);

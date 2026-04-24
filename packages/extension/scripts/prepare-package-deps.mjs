import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const mcpServerRoot = join(repoRoot, "packages", "mcp-server");
const extensionRoot = join(repoRoot, "packages", "extension");
const extensionNodeModules = join(extensionRoot, "dist", "node_modules");

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
 * Why: @modelcontextprotocol/sdk hoists `express@5.x` to the repo-root
 * node_modules, but the bundled MCP server code (daemon/server.ts etc.) is
 * written against express 4.x route/error-handler semantics and `req.path`
 * behaviour. A blind repo-root-first resolution (the 0.8.5 behaviour) ships
 * express 5 in the VSIX and breaks the daemon on end-user machines. Same
 * risk exists for any dep shared between mcp-server and the SDK's transitive
 * graph (got, helmet, keytar, …), so we funnel all daemon-runtime deps
 * through the mcp-server workspace first.
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

// Programmatic assertion: the bundled daemon code is written against express 4
// (route signatures, 4-arity error handlers, req.path semantics). If the
// hoist-order in the workspace ever changes and express 5 slips into the VSIX,
// the daemon will fail at runtime on end-user machines. Fail the build here.
const expressManifestPath = join(extensionNodeModules, "express", "package.json");
if (!existsSync(expressManifestPath)) {
  throw new Error(
    `[prepare-package-deps] express/package.json missing at ${expressManifestPath}. ` +
      `Expected express to be copied into dist/node_modules. Check rootPackages in this file.`
  );
}
const expressVersion = JSON.parse(readFileSync(expressManifestPath, "utf8")).version ?? "";
const expressMajor = expressVersion.split(".")[0];
if (expressMajor !== "4") {
  throw new Error(
    `[prepare-package-deps] express major version mismatch: got ${expressVersion}, expected ^4. ` +
      `The bundled MCP daemon is written against express 4.x semantics. ` +
      `Check rootPackages resolution order in ${fileURLToPath(import.meta.url)} — ` +
      `express must resolve from packages/mcp-server/node_modules, not the repo root (SDK hoists express 5).`
  );
}
console.log(`[prepare-package-deps] express ${expressVersion} OK`);

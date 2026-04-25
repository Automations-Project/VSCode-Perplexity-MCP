#!/usr/bin/env node
// Smart patch-version bumper for the monorepo.
// Bumps only packages whose files changed since the last git tag (or --base).
// Also bumps downstream dependents that bundle/embed changed packages.
//
// Usage:
//   node scripts/bump-version.mjs              # bump since latest tag
//   node scripts/bump-version.mjs --dry-run      # preview only
//   node scripts/bump-version.mjs --base v0.8.0  # bump since specific ref
//   node scripts/bump-version.mjs --no-deps      # skip dependent bumps

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const PACKAGES = {
  shared: {
    dir: "packages/shared",
    name: "@perplexity-user-mcp/shared",
  },
  mcpServer: {
    dir: "packages/mcp-server",
    name: "perplexity-user-mcp",
  },
  webview: {
    dir: "packages/webview",
    name: "@perplexity-user-mcp/webview",
  },
  extension: {
    dir: "packages/extension",
    name: "perplexity-vscode",
  },
};

// When a package changes, these dependents should also bump
// because they bundle / embed the changed code.
const DEPENDENTS = {
  shared: ["webview", "extension"],
  mcpServer: ["extension"],
  webview: ["extension"],
  extension: [],
};

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
}

function getLatestTag() {
  try {
    return run("git describe --tags --abbrev=0");
  } catch {
    return null;
  }
}

function getChangedFiles(base) {
  const cmd = base
    ? `git diff --name-only ${base}...HEAD`
    : `git diff --name-only HEAD~1 HEAD`;
  return run(cmd)
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

function loadVersion(key) {
  const pkgPath = join(ROOT, PACKAGES[key].dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

function bumpPatch(version) {
  const parts = version.split(".").map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}

function writeVersion(key, newVersion) {
  const pkgPath = join(ROOT, PACKAGES[key].dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function collectDependents(changed) {
  const toBump = new Set(changed);
  let added;
  do {
    added = false;
    for (const key of toBump) {
      for (const dep of DEPENDENTS[key] || []) {
        if (!toBump.has(dep)) {
          toBump.add(dep);
          added = true;
        }
      }
    }
  } while (added);
  return toBump;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const noDeps = args.includes("--no-deps");
  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : getLatestTag();

  if (!base) {
    console.error("Error: no git tag found. Pass --base <ref> explicitly.");
    process.exit(1);
  }

  console.log(`Comparing against base: ${base}\n`);

  const changedFiles = getChangedFiles(base);
  if (changedFiles.length === 0) {
    console.log("No file changes detected. Nothing to bump.");
    process.exit(0);
  }

  const directChanges = new Set();
  for (const file of changedFiles) {
    for (const [key, pkg] of Object.entries(PACKAGES)) {
      const prefix = pkg.dir.replace(/\\/g, "/") + "/";
      if (file.replace(/\\/g, "/").startsWith(prefix)) {
        directChanges.add(key);
      }
    }
  }

  if (directChanges.size === 0) {
    console.log("No package source changes detected. Nothing to bump.");
    process.exit(0);
  }

  const toBump = noDeps ? directChanges : collectDependents(directChanges);

  const results = [];
  for (const key of toBump) {
    const oldVersion = loadVersion(key);
    const newVersion = bumpPatch(oldVersion);
    if (!dryRun) {
      writeVersion(key, newVersion);
    }
    results.push({
      key,
      name: PACKAGES[key].name,
      oldVersion,
      newVersion,
      reason: directChanges.has(key) ? "changed files" : "dependency bumped",
    });
  }

  const label = dryRun ? "[DRY RUN] Would bump:" : "Bumped:";
  console.log(label);
  for (const r of results) {
    const marker = r.reason === "changed files" ? "*" : " ";
    console.log(`  ${marker} ${r.name}  ${r.oldVersion} -> ${r.newVersion}  (${r.reason})`);
  }

  if (dryRun) {
    console.log("\nRun without --dry-run to apply.");
  } else {
    console.log("\nDone. Commit and tag as needed.");
  }
}

main();

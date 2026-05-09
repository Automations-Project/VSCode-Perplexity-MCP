#!/usr/bin/env node
// install-git-hooks: configure this clone to use scripts/git-hooks/.
//
// Run via `npm install`'s postinstall (silent) or directly:
//   node scripts/install-git-hooks.mjs
//
// Why: the pre-push hook in scripts/git-hooks/pre-push refuses to publish
// private planning artifacts under docs/superpowers/. The hook only fires
// after `git config core.hooksPath scripts/git-hooks` runs once per clone;
// this script does that automatically.
//
// Safe to run when not in a git repo (e.g. when this package is consumed
// as a dependency by something else): the script no-ops with a quiet log.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOKS_DIR = "scripts/git-hooks";

function log(msg) {
  // Single-line stderr output; doesn't disrupt npm-install progress meters.
  process.stderr.write(`[install-git-hooks] ${msg}\n`);
}

function isGitRepo() {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function currentHooksPath() {
  try {
    return execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function setHooksPath() {
  execFileSync("git", ["config", "core.hooksPath", HOOKS_DIR], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function main() {
  if (!isGitRepo()) {
    log("not a git repo; skipping (this is normal when consumed as a dependency).");
    return;
  }
  if (!existsSync(resolve(REPO_ROOT, HOOKS_DIR, "pre-push"))) {
    log(`hook directory '${HOOKS_DIR}' missing pre-push script; skipping.`);
    return;
  }
  const current = currentHooksPath();
  if (current === HOOKS_DIR) {
    return; // already configured; silent no-op.
  }
  if (current && current !== HOOKS_DIR) {
    log(`core.hooksPath is currently '${current}', not '${HOOKS_DIR}'.`);
    log(`leaving alone — set manually if you want repo hooks: git config core.hooksPath ${HOOKS_DIR}`);
    return;
  }
  setHooksPath();
  log(`activated repo hooks (core.hooksPath = ${HOOKS_DIR}).`);
}

try {
  main();
} catch (err) {
  log(`error: ${err.message}; continuing.`);
  // Never fail npm install over a hook setup hiccup.
}

// Profile path resolution and name validation.
// CRUD / active-pointer / rename arrive in subsequent phase-1 tasks.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function getConfigDir() {
  return process.env.PERPLEXITY_CONFIG_DIR || join(homedir(), ".perplexity-mcp");
}

export function getProfilesDir() {
  return join(getConfigDir(), "profiles");
}

export function getProfilePaths(name) {
  const dir = join(getProfilesDir(), name);
  return {
    dir,
    meta: join(dir, "meta.json"),
    vault: join(dir, "vault.enc"),
    vaultPlain: join(dir, "vault.json"),
    browserData: join(dir, "browser-data"),
    modelsCache: join(dir, "models-cache.json"),
    history: join(dir, "history"),
    attachments: join(dir, "attachments"),
    researches: join(dir, "researches"),
    reinit: join(dir, ".reinit"),
  };
}

/**
 * Validate a profile name. Returns null when valid, or an error string
 * (suitable for throwing) when invalid. The slug format [a-z0-9_-]{1,32}
 * structurally excludes @ and . so email-shaped names are impossible.
 */
export function validateName(name) {
  if (!name || typeof name !== "string") return "Profile name is required.";
  if (name.length > 32) return "Profile name must be 32 characters or fewer.";
  if (name !== name.toLowerCase()) return "Profile name must be lowercase.";
  if (!NAME_RE.test(name)) {
    return "Profile name must contain only lowercase letters, digits, hyphens, and underscores. Invalid characters detected.";
  }
  return null;
}

// Helper: read meta.json safely, return null on missing or parse error
function readMeta(name) {
  const p = getProfilePaths(name).meta;
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Helper: write meta.json atomically via .tmp+rename
function writeMeta(name, meta) {
  const paths = getProfilePaths(name);
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.meta + ".tmp", JSON.stringify(meta, null, 2) + "\n");
  renameSync(paths.meta + ".tmp", paths.meta);
}

export function createProfile(name, opts = {}) {
  const err = validateName(name);
  if (err) throw new Error(err);
  const paths = getProfilePaths(name);
  if (existsSync(paths.dir)) throw new Error(`Profile '${name}' already exists.`);
  mkdirSync(paths.dir, { recursive: true });
  const meta = {
    name,
    displayName: opts.displayName ?? name,
    createdAt: new Date().toISOString(),
    loginMode: opts.loginMode ?? "manual",
  };
  writeMeta(name, meta);
  return meta;
}

export function listProfiles() {
  const dir = getProfilesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readMeta(d.name))
    .filter(Boolean);
}

export function getProfile(name) {
  return readMeta(name);
}

export function deleteProfile(name) {
  const dir = getProfilePaths(name).dir;
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function getActivePointerPath() {
  return join(getConfigDir(), "active");
}

export function getActiveName() {
  const p = getActivePointerPath();
  if (!existsSync(p)) return null;
  try {
    const name = readFileSync(p, "utf8").trim();
    return name || null;
  } catch {
    return null;
  }
}

export function getActive() {
  const name = getActiveName();
  if (!name) return null;
  return getProfile(name);
}

export function setActive(name) {
  if (!getProfile(name)) throw new Error(`Profile '${name}' not found.`);
  const cfg = getConfigDir();
  if (!existsSync(cfg)) mkdirSync(cfg, { recursive: true });
  const p = getActivePointerPath();
  writeFileSync(p + ".tmp", name + "\n");
  renameSync(p + ".tmp", p);
}

export function suggestNextDefaultName() {
  const names = listProfiles().map((p) => p.name);
  let n = 1;
  while (names.includes(`account-${n}`)) n++;
  return `account-${n}`;
}

export function renameProfile(oldName, newName) {
  const err = validateName(newName);
  if (err) throw new Error(err);
  const oldPaths = getProfilePaths(oldName);
  const newPaths = getProfilePaths(newName);
  if (!existsSync(oldPaths.dir)) throw new Error(`Profile '${oldName}' not found.`);
  if (existsSync(newPaths.dir)) throw new Error(`Profile '${newName}' already exists.`);
  renameSync(oldPaths.dir, newPaths.dir);
  const meta = readMeta(newName);
  if (meta) {
    meta.name = newName;
    if (meta.displayName === oldName) meta.displayName = newName;
    writeMeta(newName, meta);
  }
  if (getActiveName() === oldName) setActive(newName);
}

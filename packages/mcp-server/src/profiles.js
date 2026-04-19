// Profile path resolution and name validation.
// CRUD / active-pointer / rename arrive in subsequent phase-1 tasks.

import { homedir } from "node:os";
import { join } from "node:path";

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

import { existsSync, writeFileSync, rmSync } from "node:fs";
import { Vault } from "./vault.js";
import { getProfilePaths, getProfile, getActiveName, setActive, listProfiles, createProfile } from "./profiles.js";

export async function softLogout(name) {
  const vault = new Vault();
  await vault.delete(name, "cookies").catch(() => {});
  const paths = getProfilePaths(name);
  const meta = getProfile(name);
  if (meta) {
    delete meta.lastLogin;
    writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + "\n");
  }
  // Clear login-browser-data so the next login attempt starts with a fresh context.
  if (existsSync(paths.loginBrowserData)) rmSync(paths.loginBrowserData, { recursive: true, force: true });
  // Clear the stale account snapshots too. Leaving models-cache.json behind
  // kept the dashboard claiming the old tier (and `loggedIn`) after logout;
  // a dead daemon-status.json pinned an obsolete auth badge the same way.
  if (existsSync(paths.modelsCache)) rmSync(paths.modelsCache, { force: true });
  if (existsSync(paths.daemonStatus)) rmSync(paths.daemonStatus, { force: true });
  // ponytail: browser-data (Chromium profile with its own cookie DB) is left
  // in place — it is daemon-single-owner (issue #8 singleton lock) and an
  // in-process rmSync on a live profile throws EBUSY on Windows. The .reinit
  // touch below makes the daemon reload with an empty vault, so the session
  // is dead either way; wipe browser-data via daemon teardown if cookie
  // residue on disk ever matters.
  if (existsSync(paths.dir)) writeFileSync(paths.reinit, String(Date.now()));
}

export async function hardLogout(name) {
  const paths = getProfilePaths(name);
  if (existsSync(paths.dir)) rmSync(paths.dir, { recursive: true, force: true });
  if (getActiveName() === name) {
    const remaining = listProfiles();
    if (remaining.length > 0) {
      setActive(remaining[0].name);
    } else {
      createProfile("default");
      setActive("default");
    }
  }
}

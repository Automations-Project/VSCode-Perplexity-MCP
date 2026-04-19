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

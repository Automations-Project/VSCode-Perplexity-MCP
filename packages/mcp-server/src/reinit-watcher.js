import { existsSync, mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir, getProfilePaths } from "./profiles.js";

export function watchReinit(profileName, callback, opts = {}) {
  const { debounceMs = 200 } = opts;
  const target = getProfilePaths(profileName).reinit;
  const parent = dirname(target);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  let timer = null;
  const w = watch(parent, { persistent: false }, (event, filename) => {
    if (!filename) return;
    if (!String(filename).endsWith(".reinit")) return;
    if (!existsSync(target)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; try { callback(); } catch {} }, debounceMs);
  });

  return {
    dispose() {
      if (timer) { clearTimeout(timer); timer = null; }
      try { w.close(); } catch {}
    },
  };
}

/**
 * Watch the `<configDir>/active` pointer file for profile switches.
 *
 * The per-profile `watchReinit` is bound to a single profile's `.reinit` file
 * captured at daemon startup; if the user switches the active profile, that
 * watcher will never see anything (the new profile's `.reinit` is in a
 * different directory). This second watcher fires whenever `setActive()`
 * rewrites the active-pointer atomically, letting the daemon call
 * `client.reinit()` on profile switches AND rebind its per-profile watcher
 * to the newly-active profile so subsequent login events propagate.
 */
export function watchActiveProfile(configDirOverride, callback, opts = {}) {
  const { debounceMs = 200 } = opts;
  const configDir = configDirOverride ?? getConfigDir();
  const target = join(configDir, "active");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  let timer = null;
  const w = watch(configDir, { persistent: false }, (event, filename) => {
    if (!filename) return;
    // setActive writes via `<active>.tmp` then renames; both events surface
    // here, but only the final `active` rename is meaningful.
    if (String(filename) !== "active") return;
    if (!existsSync(target)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; try { callback(); } catch {} }, debounceMs);
  });

  return {
    dispose() {
      if (timer) { clearTimeout(timer); timer = null; }
      try { w.close(); } catch {}
    },
  };
}

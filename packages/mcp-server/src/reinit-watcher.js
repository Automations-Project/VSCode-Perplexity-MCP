import { existsSync, mkdirSync, watch } from "node:fs";
import { dirname } from "node:path";
import { getProfilePaths } from "./profiles.js";

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

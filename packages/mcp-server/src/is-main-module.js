// Direct-run guard helper shared between cli.js and index.ts. Both entrypoints
// historically used `import.meta.url === pathToFileURL(process.argv[1]).href`,
// which silently returns false when the bin is invoked through a symlink
// (Homebrew's `Cellar/...` layout, npm's `node_modules/.bin/<name>` symlink,
// or any user-created symlink): the LHS resolves to the realpath of the built
// `dist/cli.mjs` file while the RHS still points at the symlink. The result
// was a CLI that silently exited 0 with no output for any user whose `bin`
// path was symlinked — confirmed by issue #6.
//
// We resolve both sides through `realpathSync` so symlink layers don't matter,
// and fall back to the unresolved URL comparison when realpath rejects (rare:
// virtual filesystems, missing-file races on uninstall, restricted sandboxes).

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Returns true when the importing module is the process entrypoint (i.e. was
 * invoked as `node <script>` or via a bin symlink), false when it was imported
 * by another module.
 *
 * @param {string} metaUrl - The caller's `import.meta.url`
 * @returns {boolean}
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    const moduleReal = realpathSync(fileURLToPath(metaUrl));
    const argvReal = realpathSync(process.argv[1]);
    return moduleReal === argvReal;
  } catch {
    // Defensive fallback to the original (broken-on-symlinks) comparison.
    // Kept so a realpath failure on an exotic platform degrades to the
    // pre-fix behavior rather than crashing the CLI outright.
    return metaUrl === pathToFileURL(process.argv[1]).href;
  }
}

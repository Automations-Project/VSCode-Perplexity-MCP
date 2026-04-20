import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CATEGORY = "native-deps";

/**
 * Build a `require` that resolves as if invoked from `baseDir`. Falls back
 * to this module's own file when no baseDir is supplied. The fallback works
 * in plain Node ESM (CLI mode). In tsup-bundled CJS, `import.meta.url` is
 * polyfilled to undefined, so the extension MUST pass a baseDir derived
 * from `vscode.ExtensionContext.extensionUri` (e.g. `<extensionUri>/dist`).
 */
function makeRequire(baseDir) {
  if (baseDir) {
    return createRequire(join(baseDir, "_resolver.js"));
  }
  const self = import.meta.url ?? null;
  if (!self) return null;
  try {
    // Resolve against this module's own file, which works in native Node ESM.
    return createRequire(self);
  } catch {
    return null;
  }
}

function resolveGotScrapingChain(baseDir) {
  const req = makeRequire(baseDir);
  if (!req) throw new Error("no resolver context (pass baseDir)");
  const hg = req.resolve("header-generator");
  const hgReq = createRequire(hg);
  const dp = hgReq.resolve("dot-prop");
  const dpReq = createRequire(dp);
  const io = dpReq.resolve("is-obj");
  return { hg, dp, io };
}

export async function run(opts = {}) {
  const results = [];
  const baseDir = opts.baseDir;

  // patchright — required
  try {
    const req = makeRequire(baseDir);
    if (!req) throw new Error("no resolver context");
    const pkgPath = req.resolve("patchright/package.json");
    const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
    results.push({ category: CATEGORY, name: "patchright", status: "pass", message: `patchright ${version}` });
  } catch {
    results.push({
      category: CATEGORY,
      name: "patchright",
      status: "fail",
      message: "patchright not resolvable",
      hint: "Run `pnpm install` or reinstall the VSIX.",
    });
  }

  // got-scraping packaging chain — carry-over #5 detector
  const resolveChain = opts.resolveChainOverride ?? (() => resolveGotScrapingChain(baseDir));
  try {
    const chain = resolveChain();
    results.push({
      category: CATEGORY,
      name: "got-scraping-chain",
      status: "pass",
      message: "header-generator -> dot-prop -> is-obj resolves",
      detail: chain,
    });
  } catch (err) {
    results.push({
      category: CATEGORY,
      name: "got-scraping-chain",
      status: "warn",
      message: "got-scraping packaging chain is broken — runtime will fall back to browser tier",
      detail: { chainError: err.message },
      hint: "Add the missing package to rootPackages in packages/extension/scripts/prepare-package-deps.mjs and rebuild the VSIX.",
    });
  }

  // impit (optional speed boost)
  let impitStatus = opts.impitStatusOverride;
  if (!impitStatus) {
    try {
      const { getImpitRuntimeDir } = await import("../config.js");
      const marker = join(getImpitRuntimeDir(), "native-deps-state.json");
      if (existsSync(marker)) {
        impitStatus = JSON.parse(readFileSync(marker, "utf8"));
      } else {
        impitStatus = { installed: false, version: null };
      }
    } catch {
      impitStatus = { installed: false, version: null };
    }
  }
  if (impitStatus.installed) {
    results.push({
      category: CATEGORY,
      name: "impit",
      status: "pass",
      message: `impit ${impitStatus.version ?? "(unknown version)"}`,
    });
  } else {
    results.push({
      category: CATEGORY,
      name: "impit",
      status: "skip",
      message: "not installed (optional — gives HTTP tier speed boost)",
      hint: "Install via the dashboard's 'Install Speed Boost' button.",
    });
  }

  return results;
}

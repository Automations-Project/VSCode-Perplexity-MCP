import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CATEGORY = "native-deps";

/**
 * Walks header-generator → dot-prop → is-obj by creating a per-package
 * `createRequire` at each step so a missing link surfaces the same way
 * it would at runtime. Throws if any link fails.
 *
 * Carry-over #5 from Phase 2: the VSIX previously shipped header-generator
 * without its dot-prop → is-obj transitive chain, forcing got-scraping to
 * fall back to the browser tier silently. prepare-package-deps.mjs now
 * includes both packages in rootPackages; this check is the regression guard.
 */
function resolveGotScrapingChain() {
  const req = createRequire(import.meta.url);
  const hg = req.resolve("header-generator");
  const hgReq = createRequire(hg);
  const dp = hgReq.resolve("dot-prop");
  const dpReq = createRequire(dp);
  const io = dpReq.resolve("is-obj");
  return { hg, dp, io };
}

export async function run(opts = {}) {
  const results = [];

  // patchright — required
  try {
    const req = createRequire(import.meta.url);
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
  const resolveChain = opts.resolveChainOverride ?? resolveGotScrapingChain;
  try {
    const chain = resolveChain();
    results.push({
      category: CATEGORY,
      name: "got-scraping-chain",
      status: "pass",
      message: "header-generator → dot-prop → is-obj resolves",
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

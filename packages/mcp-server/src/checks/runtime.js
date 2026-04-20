import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { join } from "node:path";

const CATEGORY = "runtime";

function parseMajor(v) {
  const m = /^v?(\d+)\./.exec(v);
  return m ? Number(m[1]) : NaN;
}

function defaultGitShaResolver(cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 2000 });
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    child.on("error", () => resolve(null));
  });
}

function getPackageJsonCandidates(baseDir) {
  const candidates = [];
  if (baseDir) {
    candidates.push(join(baseDir, "mcp", "package.json"));
    candidates.push(join(baseDir, "package.json"));
  }
  const metaUrl = import.meta.url ?? null;
  if (metaUrl) {
    try {
      candidates.push(fileURLToPath(new URL("../../package.json", metaUrl)));
    } catch {}
    try {
      candidates.push(fileURLToPath(new URL("../package.json", metaUrl)));
    } catch {}
  }
  return candidates;
}

export async function run(opts = {}) {
  const results = [];
  const nodeVersion = opts.nodeVersionOverride ?? process.version;
  const major = parseMajor(nodeVersion);
  results.push({
    category: CATEGORY,
    name: "node-version",
    status: major >= 20 ? "pass" : "fail",
    message: `Node.js ${nodeVersion}`,
    hint: major >= 20 ? undefined : "Upgrade to Node 20 or later (https://nodejs.org).",
  });
  results.push({ category: CATEGORY, name: "platform", status: "pass", message: `${process.platform} ${process.arch}` });
  results.push({ category: CATEGORY, name: "arch", status: "pass", message: process.arch });

  let version = "0.0.0";
  for (const pkgPath of getPackageJsonCandidates(opts.baseDir)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name === "perplexity-user-mcp" && pkg.version) {
        version = pkg.version;
        break;
      }
    } catch {}
  }
  results.push({
    category: CATEGORY,
    name: "package-version",
    status: "pass",
    message: `perplexity-user-mcp ${version}`,
    detail: { version },
  });

  const gitDir = opts.gitDirOverride ?? join(process.cwd(), ".git");
  const resolver = opts.gitShaResolverOverride ?? defaultGitShaResolver;
  if (!existsSync(gitDir)) {
    results.push({ category: CATEGORY, name: "git-sha", status: "skip", message: "not a git checkout" });
  } else {
    const sha = await resolver(process.cwd());
    if (sha) {
      results.push({ category: CATEGORY, name: "git-sha", status: "pass", message: sha });
    } else {
      results.push({ category: CATEGORY, name: "git-sha", status: "skip", message: "git not on PATH" });
    }
  }

  return results;
}

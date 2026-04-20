import { getConfigDir } from "./profiles.js";

export const CATEGORIES = [
  "runtime", "config", "profiles", "vault", "browser",
  "native-deps", "network", "ide", "mcp", "probe",
];

const RANK = { skip: 0, pass: 1, warn: 2, fail: 3 };
const INV = ["skip", "pass", "warn", "fail"];

export function rollupStatus(statuses) {
  if (statuses.length === 0) return "skip";
  const rank = statuses.reduce((acc, s) => Math.max(acc, RANK[s] ?? 0), 0);
  return INV[rank];
}

export function exitCodeFor(report) {
  return report.overall === "fail" ? 10 : 0;
}

async function loadCheck(name) {
  const mod = await import(`./checks/${name}.js`);
  return mod.run;
}

export async function runAll(opts = {}) {
  const t0 = Date.now();
  const configDir = opts.configDir ?? getConfigDir();
  const { getActiveName } = await import("./profiles.js");
  const activeProfile = opts.profile ?? getActiveName() ?? "default";
  const probe = !!opts.probe;
  const allProfiles = !!opts.allProfiles;

  const tasks = CATEGORIES.map(async (cat) => {
    // When probe is disabled and no injected probe data, synthesise a skip entry
    if (cat === "probe" && !probe && !opts.injected?.[cat]) {
      return [cat, [{ category: "probe", name: "probe-search", status: "skip", message: "skipped (use --probe to enable)" }]];
    }
    if (opts.injected?.[cat]) return [cat, opts.injected[cat]];
    try {
      const runFn = await loadCheck(cat);
      const results = await runFn({
        configDir,
        profile: activeProfile,
        allProfiles,
        probe,
        ideStatuses: opts.ideStatuses,
      });
      return [cat, results];
    } catch (err) {
      return [cat, [{ category: cat, name: `${cat}-runner`, status: "fail", message: `check crashed: ${err.message}` }]];
    }
  });

  const settled = await Promise.all(tasks);
  const byCategory = {};
  for (const [cat, checks] of settled) {
    const rollup = rollupStatus(checks.map((c) => c.status));
    byCategory[cat] = { status: rollup, checks };
  }
  const overall = rollupStatus(Object.values(byCategory).map((b) => b.status));

  return {
    overall,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    activeProfile,
    probeRan: probe,
    byCategory,
  };
}

export function formatReportMarkdown(report) {
  const lines = [];
  const dot = { pass: "[OK]", warn: "[!]", fail: "[X]", skip: "[-]" };
  lines.push(`# Perplexity Doctor report -- ${dot[report.overall]} **${report.overall.toUpperCase()}**`);
  lines.push(`Generated ${report.generatedAt} in ${report.durationMs}ms`);
  lines.push(`Active profile: \`${report.activeProfile}\`${report.probeRan ? " (probe ran)" : ""}`);
  lines.push("");
  for (const cat of CATEGORIES) {
    const bucket = report.byCategory[cat];
    if (!bucket) continue;
    lines.push(`## ${dot[bucket.status]} ${cat} -- ${bucket.status}`);
    for (const c of bucket.checks) {
      lines.push(`- ${dot[c.status]} **${c.name}** -- ${c.message}${c.hint ? `\n  - *Hint:* ${c.hint}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

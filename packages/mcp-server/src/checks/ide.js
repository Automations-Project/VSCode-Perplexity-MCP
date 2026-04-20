const CATEGORY = "ide";

export async function run(opts = {}) {
  const results = [];
  const statuses = opts.ideStatuses;

  if (!statuses) {
    results.push({
      category: CATEGORY,
      name: "ide-audit",
      status: "skip",
      message: "IDE audit requires the VS Code extension (or pass ideStatuses explicitly).",
    });
    return results;
  }

  for (const [id, s] of Object.entries(statuses)) {
    if (!s.detected) {
      results.push({ category: CATEGORY, name: id, status: "skip", message: `${s.displayName} not installed` });
      continue;
    }
    if (!s.configured) {
      results.push({
        category: CATEGORY,
        name: id,
        status: "warn",
        message: `${s.displayName} installed but Perplexity MCP is not configured.`,
        hint: "Open the IDEs dashboard tab and click Configure.",
      });
      continue;
    }
    if (s.health === "stale") {
      results.push({
        category: CATEGORY,
        name: id,
        status: "warn",
        message: `${s.displayName} config is stale.`,
        hint: "Click Configure to refresh.",
      });
      continue;
    }
    results.push({ category: CATEGORY, name: id, status: "pass", message: `${s.displayName} configured` });
  }

  return results;
}

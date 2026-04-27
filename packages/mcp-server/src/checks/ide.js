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
        action: { label: "Configure", commandId: "Perplexity.generateConfigs", args: [id] },
      });
      continue;
    }
    // Order of evaluation: stale-args (the launcher path no longer exists)
    // wins over a bad-command warning. A stale launcher is the higher-impact
    // breakage — the IDE will fail to spawn anything at all — so the doctor
    // surfaces that first and elides the command-health note for the same row.
    if (s.health === "stale") {
      results.push({
        category: CATEGORY,
        name: id,
        status: "warn",
        message: `${s.displayName} config is stale.`,
        hint: "Click Configure to refresh.",
        action: { label: "Refresh config", commandId: "Perplexity.generateConfigs", args: [id] },
      });
      continue;
    }
    if (s.commandHealth && s.commandHealth !== "ok") {
      results.push({
        category: CATEGORY,
        name: id,
        status: "warn",
        message: `${s.displayName} configured but command path is ${s.commandHealth} — re-run 'Configure for All' to refresh.`,
        hint: "The MCP config's `command` field doesn't look like a Node.js binary. Re-running Configure rewrites it with a resolved Node path.",
        action: { label: "Refresh config", commandId: "Perplexity.generateConfigs", args: [id] },
      });
      continue;
    }
    results.push({ category: CATEGORY, name: id, status: "pass", message: `${s.displayName} configured` });
  }

  try {
    const { detectAllViewers } = await import("../viewer-detect.js");
    const viewers = await detectAllViewers();
    const detected = Object.entries(viewers)
      .filter(([, present]) => present)
      .map(([id]) => id);
    results.push({
      category: CATEGORY,
      name: "mdViewers",
      status: "pass",
      message: detected.length > 0
        ? `Detected MD viewers: ${detected.join(", ")}`
        : "No external MD viewers detected (VS Code preview and Rich View remain available).",
      detail: { viewers },
    });
  } catch (err) {
    results.push({
      category: CATEGORY,
      name: "mdViewers",
      status: "warn",
      message: `Viewer detection failed: ${(err instanceof Error ? err.message : String(err))}`,
    });
  }

  return results;
}

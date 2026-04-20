import { redact } from "./redact.js";

const SIZE_THRESHOLD = 6 * 1024;

export function buildIssueBody({ report, stderrTail, extVersion, nodeVersion, os, activeTier }) {
  const lines = [];
  lines.push(`# Doctor report`);
  lines.push("");
  lines.push(`- Overall: **${report.overall}**`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Duration: ${report.durationMs}ms`);
  lines.push(`- Active profile tier: ${activeTier ?? "unknown"}`);
  lines.push(`- Extension version: ${extVersion}`);
  lines.push(`- Node: ${nodeVersion}`);
  lines.push(`- OS: ${os}`);
  lines.push("");
  for (const [cat, bucket] of Object.entries(report.byCategory)) {
    lines.push(`## ${cat} -- ${bucket.status}`);
    for (const c of bucket.checks) {
      lines.push(`- \`${c.status}\` **${c.name}** -- ${c.message}`);
      if (c.hint) lines.push(`  - Hint: ${c.hint}`);
    }
    lines.push("");
  }
  lines.push("## stderr tail");
  lines.push("```");
  lines.push(stderrTail ?? "(no stderr captured)");
  lines.push("```");
  return lines.join("\n");
}

export function redactIssueBody(md) {
  // Additional pattern set not covered by redact.js: backendUuid-like tokens.
  const extra = md.replace(/\bbackendUuid[\s:=]+[A-Za-z0-9-]{20,}\b/g, "backendUuid=<redacted>");
  return redact(extra);
}

export function decideTransport({ bodyBytes }) {
  return bodyBytes > SIZE_THRESHOLD ? "file" : "inline";
}

export function buildIssueUrl({ owner, repo, category, check, body }) {
  const title = `[auto] Doctor failure: ${category}/${check}`;
  const labels = ["bug", "doctor", "auto-report", category].join(",");
  const params = new URLSearchParams({
    template: "doctor-report.yml",
    title,
    labels,
    body,
  });
  return `https://github.com/${owner}/${repo}/issues/new?${params.toString()}`;
}

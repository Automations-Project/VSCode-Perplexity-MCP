import type { DoctorReport } from "@perplexity/shared";
import { buildIssueBody, redactIssueBody, buildIssueUrl, decideTransport } from "perplexity-user-mcp";

export interface Diagnostics {
  markdown: string;
  bodyBytes: number;
  transport: "inline" | "file";
}

export function collectDiagnostics(input: {
  report: DoctorReport;
  stderrTail: string;
  extVersion: string;
  nodeVersion: string;
  os: string;
  activeTier: string | null;
}): Diagnostics {
  const raw = (buildIssueBody as Function)({ ...input, activeTier: input.activeTier ?? "unknown" });
  const markdown = (redactIssueBody as Function)(raw);
  const bodyBytes = Buffer.byteLength(markdown, "utf8");
  return { markdown, bodyBytes, transport: (decideTransport as Function)({ bodyBytes }) };
}

export async function renderPreview(opts: {
  markdown: string;
  showInformationMessage: (msg: string, options: { modal: boolean; detail?: string }, ...items: string[]) => Thenable<string | undefined>;
}): Promise<string | undefined> {
  return opts.showInformationMessage(
    "Perplexity Doctor — Report issue",
    { modal: true, detail: opts.markdown.slice(0, 4000) + (opts.markdown.length > 4000 ? "\n\n…(truncated — full payload goes to GitHub)" : "") },
    "Open GitHub issue",
    "Copy to clipboard",
  );
}

export async function openIssue(opts: {
  url: string;
  optOut: boolean;
  openExternal: (url: unknown) => Thenable<boolean>;
}): Promise<boolean> {
  if (opts.optOut) return false;
  return Boolean(await opts.openExternal(opts.url));
}

export { buildIssueUrl };

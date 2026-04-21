import type { SearchResult } from "./config.js";

export interface HistoryEntry {
  tool: string;
  query: string;
  model: string | null;
  mode: string | null;
  language: string | null;
  answerPreview: string;
  sourceCount: number;
  threadUrl?: string;
  error?: string;
}

function getThreadSlug(result: SearchResult | undefined): string | null {
  const slug = result?.followUp?.threadUrlSlug ?? null;
  if (slug) return slug;
  if (!result?.threadUrl) return null;
  const match = result.threadUrl.match(/\/search\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export function formatResponse(result: SearchResult): string {
  const parts: string[] = [];

  if (result.answer) {
    parts.push(result.answer);
  }

  if (result.reasoning) {
    parts.push(`\n\n---\n**Reasoning:**\n${result.reasoning}`);
  }

  if (result.sources.length > 0) {
    parts.push("\n\n---\n**Sources:**");
    for (const [index, source] of result.sources.slice(0, 15).entries()) {
      parts.push(`${index + 1}. [${source.title}](${source.url})`);
    }
  }

  if (result.media.length > 0) {
    parts.push("\n\n**Media:**");
    for (const item of result.media.slice(0, 10)) {
      parts.push(`- [${item.name || "Media"}](${item.url})`);
    }
  }

  if (result.files?.length) {
    parts.push("\n\n**Generated Files:**");
    for (const file of result.files) {
      if (file.localPath) {
        parts.push(`- **${file.filename}** (${file.assetType}) -> \`${file.localPath}\``);
      } else if (file.url) {
        parts.push(`- **${file.filename}** (${file.assetType}) -> [Download](${file.url})`);
      }
    }
  }

  if (result.suggestedFollowups.length > 0) {
    parts.push("\n\n**Suggested follow-ups:**");
    for (const followUp of result.suggestedFollowups.slice(0, 5)) {
      parts.push(`- ${followUp}`);
    }
  }

  if (result.threadUrl) {
    parts.push(`\n\n**Full thread:** ${result.threadUrl}`);
  }

  return parts.join("\n");
}

export function buildAnswerPreview(result: SearchResult | null, error?: string): string {
  if (error) {
    return error.slice(0, 220);
  }

  const answer = result?.answer ?? "";
  return answer.replace(/\s+/g, " ").trim().slice(0, 220);
}

export function buildHistoryEntry(options: {
  tool: string;
  query: string;
  model: string | null;
  mode: string | null;
  language: string | null;
  result?: SearchResult;
  error?: string;
}): HistoryEntry {
  return {
    tool: options.tool,
    query: options.query,
    model: options.model,
    mode: options.mode,
    language: options.language,
    answerPreview: buildAnswerPreview(options.result ?? null, options.error),
    sourceCount: options.result?.sources.length ?? 0,
    threadUrl: options.result?.threadUrl,
    error: options.error
  };
}

export function buildHistoryBody(result: SearchResult | undefined, error?: string): string {
  if (error && !result) {
    return `# Request failed\n\n${error}`;
  }

  if (!result) {
    return error ? `# Request failed\n\n${error}` : "";
  }

  return formatResponse(result);
}

export function buildStoredHistoryEntry(options: {
  tool: string;
  query: string;
  model: string | null;
  mode: string | null;
  language: string | null;
  tier?: "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous";
  status?: "completed" | "pending" | "failed";
  createdAt?: string;
  completedAt?: string;
  result?: SearchResult;
  error?: string;
}): HistoryEntry & {
  createdAt: string;
  body: string;
  status?: "completed" | "pending" | "failed";
  completedAt?: string;
  tier?: "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous";
  threadSlug?: string | null;
  backendUuid?: string | null;
  readWriteToken?: string | null;
  sources?: Array<{ n: number; title: string; url: string; snippet?: string }>;
} {
  const base = buildHistoryEntry(options);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const status = options.status ?? (options.error ? "failed" : "completed");
  const sources = (options.result?.sources ?? []).map((source, index) => ({
    n: index + 1,
    title: source.title,
    url: source.url,
    ...(source.snippet ? { snippet: source.snippet } : {}),
  }));

  return {
    ...base,
    createdAt,
    body: buildHistoryBody(options.result, options.error),
    ...(status ? { status } : {}),
    ...(options.completedAt
      ? { completedAt: options.completedAt }
      : status === "completed"
        ? { completedAt: createdAt }
        : {}),
    ...(options.tier ? { tier: options.tier } : {}),
    ...(getThreadSlug(options.result) !== null ? { threadSlug: getThreadSlug(options.result) } : {}),
    ...(options.result?.followUp?.backendUuid ? { backendUuid: options.result.followUp.backendUuid } : {}),
    ...(options.result?.followUp?.readWriteToken !== undefined
      ? { readWriteToken: options.result.followUp.readWriteToken }
      : {}),
    ...(sources.length > 0 ? { sources } : {}),
  };
}

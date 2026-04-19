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

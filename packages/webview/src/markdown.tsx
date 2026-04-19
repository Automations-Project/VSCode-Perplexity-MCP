/**
 * Lightweight markdown renderer for the webview sidebar.
 * Handles: headers, bold, italic, inline code, code blocks,
 * links, unordered/ordered lists, horizontal rules, blockquotes.
 * No external dependencies — pure React.
 */
import { createElement, memo, type ReactNode } from "react";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Regex handles: **bold**, *italic*, `code`, [text](url), [N] citation refs
  const pattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)]+?)\))|(\[\d+\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(escapeHtml(text.slice(lastIndex, match.index)));
    }

    if (match[1]) {
      // **bold**
      nodes.push(<strong key={key++}>{escapeHtml(match[2])}</strong>);
    } else if (match[3]) {
      // *italic*
      nodes.push(<em key={key++}>{escapeHtml(match[4])}</em>);
    } else if (match[5]) {
      // `inline code`
      nodes.push(<code key={key++} className="md-inline-code">{escapeHtml(match[6])}</code>);
    } else if (match[7]) {
      // [text](url)
      nodes.push(
        <a key={key++} href={match[9]} className="md-link" target="_blank" rel="noopener noreferrer">
          {escapeHtml(match[8])}
        </a>
      );
    } else if (match[10]) {
      // [N] citation reference
      nodes.push(<sup key={key++} className="md-cite">{match[10]}</sup>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(escapeHtml(text.slice(lastIndex)));
  }

  return nodes;
}

interface MarkdownProps {
  content: string;
  maxLines?: number;
  className?: string;
}

export const Markdown = memo(function Markdown({ content, maxLines, className }: MarkdownProps) {
  const lines = content.split("\n");
  const elements: ReactNode[] = [];
  let key = 0;
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines: string[] = [];
  let lineCount = 0;
  const limit = maxLines ?? Infinity;

  function pushElement(el: ReactNode) {
    if (lineCount >= limit) return;
    elements.push(el);
    lineCount++;
  }

  for (let i = 0; i < lines.length; i++) {
    if (lineCount >= limit) break;

    const line = lines[i];

    // Code block fence
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        pushElement(
          <pre key={key++} className="md-code-block">
            {codeBlockLang && <div className="md-code-lang">{codeBlockLang}</div>}
            <code>{codeLines.join("\n")}</code>
          </pre>
        );
        inCodeBlock = false;
        codeLines = [];
        codeBlockLang = "";
        continue;
      }
      inCodeBlock = true;
      codeBlockLang = line.trimStart().slice(3).trim();
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
      pushElement(<hr key={key++} className="md-hr" />);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const tag = `h${level}`;
      pushElement(
        createElement(tag, { key: key++, className: `md-h${level}` }, ...renderInline(headingMatch[2]))
      );
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith("> ")) {
      pushElement(
        <blockquote key={key++} className="md-blockquote">
          {renderInline(line.replace(/^>\s*/, ""))}
        </blockquote>
      );
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (ulMatch) {
      const depth = Math.floor(ulMatch[1].length / 2);
      pushElement(
        <div key={key++} className="md-li" style={{ paddingLeft: `${12 + depth * 14}px` }}>
          <span className="md-bullet">&#x2022;</span>
          <span>{renderInline(ulMatch[2])}</span>
        </div>
      );
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      const depth = Math.floor(olMatch[1].length / 2);
      const num = line.match(/^(\s*)(\d+)\./)?.[2] ?? "1";
      pushElement(
        <div key={key++} className="md-li" style={{ paddingLeft: `${12 + depth * 14}px` }}>
          <span className="md-bullet">{num}.</span>
          <span>{renderInline(olMatch[2])}</span>
        </div>
      );
      continue;
    }

    // Regular paragraph
    pushElement(<p key={key++} className="md-p">{renderInline(line)}</p>);
  }

  // Unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    pushElement(
      <pre key={key++} className="md-code-block">
        {codeBlockLang && <div className="md-code-lang">{codeBlockLang}</div>}
        <code>{codeLines.join("\n")}</code>
      </pre>
    );
  }

  const truncated = lineCount >= limit && lines.length > limit;

  return (
    <div className={`md-root ${className ?? ""}`}>
      {elements}
      {truncated && <div className="md-truncated">... content truncated</div>}
    </div>
  );
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { DashboardState } from "@perplexity-user-mcp/shared";

function createNonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function renderWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  state: DashboardState
): string {
  const webviewRoot = vscode.Uri.joinPath(extensionUri, "media", "webview");
  const htmlPath = join(webviewRoot.fsPath, "index.html");
  const nonce = createNonce();

  let html = readFileSync(htmlPath, "utf8");
  html = html.replace(/(src|href)="([^"]+)"/g, (match, attribute, resourcePath) => {
    if (
      resourcePath.startsWith("http://") ||
      resourcePath.startsWith("https://") ||
      resourcePath.startsWith("data:") ||
      resourcePath.startsWith("#")
    ) {
      return match;
    }

    const assetUri = vscode.Uri.joinPath(webviewRoot, resourcePath);
    return `${attribute}="${webview.asWebviewUri(assetUri)}"`;
  });

  const initialState = JSON.stringify(state).replace(/</g, "\\u003c");
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`
  ].join("; ");

  const bootstrapScript = `<script nonce="${nonce}">window.__PERPLEXITY_INITIAL_STATE__ = ${initialState};</script>`;
  html = html.replace("</head>", `<meta http-equiv="Content-Security-Policy" content="${csp}">${bootstrapScript}</head>`);
  html = html.replace(/<script type="module"/g, `<script nonce="${nonce}" type="module"`);
  return html;
}

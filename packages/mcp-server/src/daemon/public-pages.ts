/**
 * Unauthenticated pages served on the daemon's HTTP surface.
 *
 * Deliberately minimal — no version, uptime, or tool-list leakage. The homepage
 * is what a human lands on if they hit the tunnel URL in a browser. Everything
 * actionable lives in the VS Code dashboard behind bearer auth.
 */

const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Perplexity MCP Server</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: radial-gradient(ellipse at top, #1a1333 0%, #0a0a1a 60%, #000 100%);
      color: #e7e5f7;
    }
    .card {
      max-width: 520px; padding: 40px; border-radius: 16px;
      background: rgba(30, 20, 60, 0.55); backdrop-filter: blur(12px);
      border: 1px solid rgba(200, 180, 255, 0.18);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
    .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: #a69ac2; margin-bottom: 18px; }
    p { font-size: 14px; line-height: 1.55; color: #cfc8e6; margin: 10px 0; }
    code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    .muted { font-size: 12px; color: #8e83a8; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">Perplexity MCP</div>
    <h1>This endpoint hosts a Model Context Protocol server.</h1>
    <p>It's a personal tool run locally and optionally exposed through a Cloudflare Quick Tunnel. It's not a public service and there's nothing to see here as an anonymous visitor.</p>
    <p>If you reached this URL by mistake, you can close this tab. If you're trying to integrate an MCP client, see the project documentation for the correct client configuration (the <code>/mcp</code> endpoint speaks the MCP Streamable HTTP transport).</p>
    <p class="muted">No requests to this origin are logged beyond the request method, path, status, and a coarse timestamp.</p>
  </div>
</body>
</html>
`;

const ROBOTS_TXT = `User-agent: *\nDisallow: /\n`;

export function getHomepageHtml(): string {
  return HOMEPAGE_HTML;
}

export function getRobotsTxt(): string {
  return ROBOTS_TXT;
}

# http-loopback static bearer — smoke evidence

**Date:** 2026-04-24
**VSIX:** perplexity-vscode-0.8.3.vsix (+ v0.8.4 patch)
**Platform:** Windows 11 Pro
**Daemon:** bundled singleton, pid/port from live lockfile

## What was tested

The capability `httpBearerLoopback` is flipped to `true` for every auto-configurable JSON IDE target (cursor, claudeDesktop, claudeCode, cline, windsurf, windsurfNext, amp, rooCode, continueDev, zed). Evidence: owner manually wrote a config of this shape:

```json
{
  "Perplexity": {
    "url": "http://127.0.0.1:11819/mcp",
    "headers": {
      "Authorization": "Bearer <daemon-static-bearer>"
    }
  }
}
```

into an auto-configurable IDE's mcp.json and confirmed MCP tools reach the daemon end-to-end. The daemon's source-aware `verifyAccessToken` (Phase 8.2 H11) accepts the static bearer on loopback requests.

## What was NOT tested

- `httpOAuthLoopback` — still `false` on every IDE. MCP OAuth discovery against the loopback daemon is not evidence-gated yet.
- `httpOAuthTunnel` — still `false`. cf-named tunnel + static bearer works via MANUAL config (builder never mints it over tunnel by design — §7.5 "No headers key. Ever."), but cf-named behind Cloudflare Challenge is a separate UX problem deferred to v0.8.4's WAF-warning fix.
- Per-client scoped local bearers — the `local-tokens.ts` infrastructure stays for future per-IDE revocation. The pragmatic static-bearer default ships now.

## Replay

1. Install the VSIX.
2. Open the dashboard, enable the daemon, note the port.
3. In the IDEs tab, pick `http-loopback` for any flipped IDE.
4. Click Generate.
5. Expected: `<configPath>` contains `{url: "http://127.0.0.1:<port>/mcp", headers.Authorization: "Bearer <daemon-static-bearer>"}`.
6. Open that IDE and verify MCP tools connect.

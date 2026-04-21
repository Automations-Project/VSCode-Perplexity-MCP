# Cloudflare Quick Tunnel

Phase 5 adds an optional `cloudflared` child process that can expose the local MCP daemon through a Cloudflare Quick Tunnel.

## Install

`cloudflared` is not bundled into the VSIX or npm package. Install it on demand:

```bash
npx perplexity-user-mcp daemon install-tunnel
```

The installer:

- Downloads the pinned release for the current platform into `~/.perplexity-mcp/bin/`.
- Verifies the SHA-256 hash against `packages/mcp-server/src/daemon/cloudflared-pins.json`.
- Extracts the Darwin tarball into a single `cloudflared` binary.

## Enable

Start the daemon with tunnel mode:

```bash
npx perplexity-user-mcp daemon start --tunnel
```

Or enable it on an already-running daemon:

```bash
npx perplexity-user-mcp daemon enable-tunnel
```

When the tunnel comes up, the daemon publishes a `https://<random>.trycloudflare.com` URL through `/daemon/events` and includes it in `/daemon/health`.

## Disable

```bash
npx perplexity-user-mcp daemon disable-tunnel
```

This only tears down `cloudflared`. The local daemon keeps running on loopback.

## Security

- Quick Tunnel is opt-in only. It is never enabled from config files or environment variables.
- Bearer auth remains mandatory even when the tunnel is public.
- If `cloudflared` crashes, the daemon stays alive on loopback and reports `tunnel.status = "crashed"`.
- Rotate the daemon token after any accidental tunnel URL or token exposure:

```bash
npx perplexity-user-mcp daemon rotate-token
```

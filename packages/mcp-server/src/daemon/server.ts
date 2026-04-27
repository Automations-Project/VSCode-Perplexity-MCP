import { createServer, type Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — helmet is CJS; express-shim.d.ts doesn't declare it
import helmet from "helmet";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type RequestLike, type Response } from "express";
import { PerplexityClient } from "../client.js";
import { registerPrompts } from "../prompts.js";
import { registerResources } from "../resources.js";
import { getEnabledTools, loadToolConfig } from "../tool-config.js";
import { registerTools } from "../tools.js";
import { getPackageVersion } from "../package-version.js";
import { appendAuditEntry, getAuditLogPath, readAuditTail } from "./audit.js";
import {
  ConsentCoordinator,
  PerplexityOAuthProvider,
  type AuthorizedClientSummary,
} from "./oauth-provider.js";
import type { ConsentEntry } from "./oauth-consent-cache.js";
import { getHomepageHtml, getRobotsTxt } from "./public-pages.js";
import { createSecurity, type SecurityMiddlewareResult } from "./security.js";
import { ensureToken, getTokenPath, rotateToken, type DaemonTokenRecord } from "./token.js";

type EventPayload = Record<string, unknown>;

export interface DaemonTunnelHealth {
  status: "disabled" | "starting" | "enabled" | "crashed";
  url: string | null;
  pid?: number | null;
  error?: string | null;
}

export interface StartDaemonServerOptions {
  host?: string;
  port?: number;
  uuid?: string;
  version?: string;
  bearerToken?: string;
  configDir?: string;
  createClient?: () => PerplexityClient;
  onShutdown?: () => Promise<void> | void;
  onTokenRotated?: (token: DaemonTokenRecord) => Promise<void> | void;
  getTunnelState?: () => DaemonTunnelHealth;
  onEnableTunnel?: () => Promise<void> | void;
  onDisableTunnel?: () => Promise<void> | void;
  onTunnelAutoDisable?: (info: { failures: number; windowMs: number }) => Promise<void> | void;
  /**
   * Called when an MCP client hits `/authorize` and we need the local user
   * to approve the consent. Host (the VS Code extension) resolves true to
   * approve, false to deny. Called with a fresh consent id that the host
   * posts back to `/daemon/oauth-consent` with its decision.
   */
  onOAuthConsentRequest?: (info: {
    consentId: string;
    clientId: string;
    clientName: string;
    redirectUri: string;
    /**
     * RFC 8707 resource the authorize request is targeting. `undefined` when
     * the client did not include a `resource` param (legacy / loopback).
     * The extension-host modal MUST display this when present so users can
     * spot cross-resource replay attempts at consent time.
     */
    resource?: string;
  }) => Promise<void> | void;
  /** When tunnel is enabled we advertise this as the OAuth issuer. */
  getTunnelUrl?: () => string | null;
}

export interface StartedDaemonServer {
  host: string;
  port: number;
  url: string;
  bearerToken: string;
  auditPath: string;
  tokenPath: string;
  close: () => Promise<void>;
  publishEvent: (event: string, payload: EventPayload) => void;
  getHealth: () => Record<string, unknown>;
  readAuditTail: (limit?: number) => ReturnType<typeof readAuditTail>;
  /** Returns registered OAuth clients with their current token counts. */
  listOAuthClients: () => AuthorizedClientSummary[];
  /** Deletes an OAuth client and all its outstanding tokens. */
  revokeOAuthClient: (clientId: string) => boolean;
  /** Deletes every registered OAuth client and invalidates all outstanding tokens. */
  revokeAllOAuthClients: () => number;
  /** Extension host resolves a pending /authorize consent. */
  resolveOAuthConsent: (consentId: string, approved: boolean) => boolean;
  /** Live non-expired cached consents. */
  listOAuthConsents: () => ConsentEntry[];
  /** Revoke cached consents. No args → revoke all. */
  revokeOAuthConsents: (filter?: { clientId?: string; redirectUri?: string }) => number;
}

export async function startDaemonServer(options: StartDaemonServerOptions = {}): Promise<StartedDaemonServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const version = options.version ?? getPackageVersion();
  const auditPath = getAuditLogPath(options.configDir);
  const tokenPath = getTokenPath(options.configDir);
  const initialToken = options.bearerToken
    ? {
        bearerToken: options.bearerToken,
        version: 1,
        createdAt: new Date().toISOString(),
        rotatedAt: new Date().toISOString(),
      }
    : ensureToken({ tokenPath });

  let currentToken = initialToken;
  let closed = false;
  let client: PerplexityClient | undefined;
  let clientInitPromise: Promise<void> | null = null;

  // OAuth 2.1 authorization-server wiring. The provider persists clients to
  // <configDir>/oauth-clients.json and holds codes/tokens in memory. Consent
  // flows route through the host-supplied onOAuthConsentRequest callback.
  //
  // Consent-cache TTL is read live per /authorize via the env var — the
  // extension host writes it from `Perplexity.oauthConsentCacheTtlHours`
  // when it spawns the daemon. `0` disables the cache.
  const consentCoordinator = new ConsentCoordinator();
  const oauthProvider = new PerplexityOAuthProvider({
    configDir: options.configDir ?? ".",
    getStaticBearer: () => currentToken.bearerToken,
    getConsentCacheTtlMs: () => {
      const raw = Number(process.env.PERPLEXITY_OAUTH_CONSENT_TTL_HOURS);
      const hours = Number.isFinite(raw) && raw >= 0 ? raw : 24;
      return Math.floor(hours * 60 * 60_000);
    },
    onConsentCacheHit: ({ res }) => {
      // Flip the audit tag so cache-driven auto-approvals are distinguishable
      // from both unauthenticated traffic and fresh modal approvals.
      const req = (res as any).req;
      if (req) {
        req._pplx = req._pplx ?? {};
        req._pplx.authOverride = "oauth-cached";
      }
    },
    requestConsent: ({ clientId, clientName, redirectUri, consentId, resource }) => {
      return consentCoordinator.request({
        id: consentId,
        clientId,
        clientName,
        redirectUri,
        resource,
        timeoutMs: 2 * 60_000,
        onRequest: () => {
          // H12 consent-binding: resource is propagated to both the extension
          // host (showWarningMessage modal) and the SSE event for any webview
          // subscriber. `undefined` is passed through verbatim so downstream
          // callers can distinguish unbound (legacy) from bound requests.
          void options.onOAuthConsentRequest?.({ consentId, clientId, clientName, redirectUri, resource });
          publishEvent("daemon:oauth-consent-request", { consentId, clientId, clientName, redirectUri, resource });
        },
      });
    },
  });
  let httpServer: HttpServer | undefined;
  const startedAt = Date.now();
  const heartbeatMap = new Map<string, number>();
  const sseClients = new Set<any>();
  const activeMcpClosers = new Set<() => Promise<void>>();
  const expressFactory = express as any;
  const app = expressFactory();

  const getClient = async () => {
    if (!client) {
      client = options.createClient ? options.createClient() : new PerplexityClient();
    }
    if (!clientInitPromise) {
      const pending = client.init();
      // On rejection, drop the cached client + promise so the NEXT getClient()
      // call constructs a fresh client and retries init(). In-flight awaiters
      // still see the original rejection (we await `pending`, not the catch).
      // Without this, a single transient init failure (e.g. browser launch)
      // poisons the daemon for its lifetime — every subsequent tool call
      // re-awaits the same rejected promise.
      pending.catch(() => {
        client = undefined;
        clientInitPromise = null;
      });
      clientInitPromise = pending;
    }
    await clientInitPromise;
    return client;
  };

  // trust proxy=1: when the daemon is tunneled, cloudflared/ngrok are
  // reverse proxies adding X-Forwarded-For. Without this, express-rate-limit
  // logs a ValidationError on every request and falls back to the loopback
  // IP (which defeats per-source tracking). Safe because the daemon only
  // ever listens on 127.0.0.1; no untrusted network can reach it directly.
  (app as any).set?.("trust proxy", 1);

  // H11 (attachRequestSource): FIRST middleware on the stack. Stamps every
  // request with req._pplx.source computed from real network indicators
  // (X-Forwarded-For, CF-Connecting-IP, socket IP). The self-reported
  // `x-perplexity-source` header is captured into req._pplx.declaredSource
  // for audit enrichment only — it is NEVER consulted for the allowlist
  // check below. Runs before helmet / json / trace / security.middleware so
  // downstream consumers always see a populated source.
  app.use((req: Request, _res: Response, next: NextFunction): void => {
    req._pplx = req._pplx ?? {};
    req._pplx.source = computeRequestSource(req);
    const declared = req.headers?.["x-perplexity-source"];
    if (typeof declared === "string") req._pplx.declaredSource = declared;
    next();
  });

  // H11 (tunnelAllowlist): SECOND middleware. Tunnel callers are restricted
  // to the MCP + OAuth surface (plus homepage / robots / favicon). Any other
  // path returns 404 (not 403) so the admin surface is invisible to probes.
  // Loopback requests pass through unchanged.
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req._pplx?.source !== "tunnel") {
      next();
      return;
    }
    const path = (typeof req.originalUrl === "string" ? req.originalUrl : req.url ?? "");
    if (!pathIsTunnelAllowed(path)) {
      res.status(404).end();
      return;
    }
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: false, // SDK's OAuth handlers + our homepage serve inline styles; CSP would need a full policy pass
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
      // Tunnel front (Cloudflare / ngrok) supplies TLS; our origin is HTTP.
      // HSTS from the origin would be inaccurate; let the edge control it.
      hsts: false,
    }) as any,
  );
  app.use(expressFactory.json({ limit: "1mb" }));

  // Security middleware: IP/UA capture, per-bearer rate limit (tunnel only),
  // User-Agent blocklist, slow-401, 401-burst tripwire. Runs before bearer
  // auth so it can gate unauthenticated requests too.
  const security: SecurityMiddlewareResult = createSecurity({
    onTripwireTriggered: async (info) => {
      console.error(`[trace] 401-burst tripwire fired: ${info.failures} failures in ${info.windowMs}ms`);
      try {
        publishEvent("daemon:tunnel-auto-disabled", {
          failures: info.failures,
          windowMs: info.windowMs,
          ip: info.ip ?? null,
        });
      } catch {
        // publishEvent isn't wired yet at this point during init; safe to ignore.
      }
      await options.onTunnelAutoDisable?.({ failures: info.failures, windowMs: info.windowMs });
    },
  });

  // Trace every admin/mcp request + write an audit line.
  app.use((req: Request, res: Response, next: NextFunction): void => {
    const startedAtReq = Date.now();
    const ctx = req._pplx ?? {};
    res.on("finish", () => {
      const durationMs = Date.now() - startedAtReq;
      // originalUrl preserves the full client-visible path even after sub-routers
      // (mcpAuthRouter) strip their mount prefix from req.url / req.path.
      const rawPath = typeof req.originalUrl === "string" && req.originalUrl.length > 0
        ? req.originalUrl
        : (typeof req.path === "string" ? req.path : (req.url ?? ""));
      const path = rawPath.split("?")[0] ?? rawPath;
      const status = res.statusCode;
      const hasAuth = typeof req.headers?.authorization === "string";
      console.error(`[trace] http ${req.method} ${path} auth=${hasAuth ? "yes" : "no"} status=${status} dur=${durationMs}ms ip=${ctx.ip ?? "?"} ua=${(ctx.userAgent ?? "").slice(0, 40)}`);
      // Only audit admin + /mcp endpoints, not homepage/static.
      if (path.startsWith("/daemon") || path.startsWith("/mcp") || path.startsWith("/authorize") || path.startsWith("/token") || path.startsWith("/register")) {
        try {
          const latestCtx = req._pplx ?? ctx;
          const authTag = latestCtx.authOverride ?? (hasAuth ? "bearer" : "none");
          appendAuditEntry(
            {
              timestamp: new Date(startedAtReq).toISOString(),
              clientId: ctx.bearer ? "bearer-client" : "anon",
              tool: `http:${req.method} ${path}`,
              durationMs,
              source: ctx.source ?? (hasAuth ? "loopback" : "tunnel"),
              ok: status >= 200 && status < 400,
              ip: ctx.ip ?? undefined,
              userAgent: ctx.userAgent || undefined,
              path,
              httpStatus: status,
              auth: authTag,
            },
            { auditPath },
          );
        } catch {
          // audit is best-effort
        }
      }
    });
    next();
  });
  app.use(security.middleware);

  const requireBearer = (req: any, res: any, next: any) => {
    const header = readAuthorizationHeader(req.headers?.authorization);
    if (header !== currentToken.bearerToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // H12 source-of-truth: read the computed source from req._pplx (stamped
    // by attachRequestSource + preserved by security.middleware) rather than
    // the self-reported `x-perplexity-source` header. A tunnel caller could
    // otherwise forge `x-perplexity-source: loopback` to mark their request
    // as trusted for downstream consumers.
    const computedSource: "loopback" | "tunnel" = req._pplx?.source === "tunnel" ? "tunnel" : "loopback";
    req.auth = {
      token: currentToken.bearerToken,
      clientId: readSingleHeader(req.headers?.["x-perplexity-client-id"]) ?? "daemon-client",
      scopes: [],
      extra: {
        source: computedSource,
      },
    };
    next();
  };

  const getHealth = () => ({
    ok: true,
    pid: process.pid,
    uuid: options.uuid ?? null,
    version,
    port: getBoundPort(httpServer),
    uptimeMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    heartbeatCount: heartbeatMap.size,
    tunnel: options.getTunnelState?.() ?? {
      status: "disabled",
      url: null,
      pid: null,
      error: null,
    },
  });

  const publishEvent = (event: string, payload: EventPayload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of sseClients) {
      response.write(frame);
    }
  };

  // OAuth 2.1 authorization-server endpoints (discovery, register, authorize,
  // token, revoke). Mounted BEFORE the bearer-guarded routes so discovery and
  // dynamic client registration are reachable unauthenticated. The SDK router
  // emits its own /.well-known/* responses — we replace them below with
  // dynamic handlers so the issuer matches the request's Host (which differs
  // between loopback and tunnel).
  // Placeholder issuer for mcpAuthRouter's internal checks. The actual issuer
  // served in /.well-known responses is computed per request from req.headers.host.
  const oauthIssuer = new URL("http://localhost");
  // Dynamic metadata — recomputes issuer per request so that tunnel clients
  // see the tunnel URL and loopback clients see 127.0.0.1.
  app.get("/.well-known/oauth-authorization-server", (req: any, res: any) => {
    const issuer = resolveIssuer(req, oauthIssuer);
    const body = {
      issuer: issuer.href.replace(/\/$/, ""),
      authorization_endpoint: new URL("/authorize", issuer).href,
      token_endpoint: new URL("/token", issuer).href,
      registration_endpoint: new URL("/register", issuer).href,
      revocation_endpoint: new URL("/revoke", issuer).href,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  });
  app.get("/.well-known/oauth-protected-resource", (req: any, res: any) => {
    const issuer = resolveIssuer(req, oauthIssuer);
    const resource = resolveRequestResource(req, oauthIssuer);
    res.json({
      resource,
      authorization_servers: [issuer.href.replace(/\/$/, "")],
      scopes_supported: ["mcp"],
      resource_name: "Perplexity MCP",
    });
  });
  // Rate-limit the unauthenticated OAuth endpoints (/authorize, /register,
  // /token, /revoke). The global security middleware only rate-limits bearer-
  // authenticated traffic; these endpoints are entered WITHOUT a bearer, so
  // they'd otherwise be wide open. Per-IP cap is deliberately generous
  // (fits any human-initiated client registration loop) but low enough to
  // deter bulk-registration scripts from a leaked tunnel URL.
  const oauthPathRe = /^\/(authorize|register|token|revoke)\b/;
  const oauthIpHits = new Map<string, number[]>();
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (!oauthPathRe.test(req.path ?? "")) {
      next();
      return;
    }
    const ctx = req._pplx ?? {};
    if (ctx.source === "loopback") {
      next();
      return;
    }
    const key = ctx.ip ?? "?";
    const now = Date.now();
    const bucket = (oauthIpHits.get(key) ?? []).filter((ts) => ts >= now - 60_000);
    bucket.push(now);
    oauthIpHits.set(key, bucket);
    if (bucket.length > 30) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too Many Requests" });
      return;
    }
    next();
  });

  try {
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: oauthIssuer,
      }),
    );
  } catch (err) {
    console.error("[trace] mcpAuthRouter mount failed:", err instanceof Error ? err.message : String(err));
  }

  // Consent bridge — extension host POSTs here with { consentId, approved }
  // after showing its modal. Static bearer only (NOT OAuth-token-authed) so
  // a rogue OAuth client can't approve its own consent.
  app.post("/daemon/oauth-consent", requireBearer, (req: any, res: any) => {
    const consentId = typeof req.body?.consentId === "string" ? req.body.consentId : null;
    const approved = req.body?.approved === true;
    if (!consentId) {
      res.status(400).json({ error: "consentId required" });
      return;
    }
    const resolved = consentCoordinator.resolve(consentId, approved);
    res.json({ ok: resolved });
  });

  // Cached-consent admin — list + revoke.
  //
  // Gated on the static bearer ONLY (never the OAuth access-token path)
  // for the same reason as /daemon/oauth-consent above: no OAuth client
  // should be able to inspect or wipe another client's approvals, and the
  // extension host + CLI are the only intended callers.
  app.get("/daemon/oauth-consents", requireBearer, (_req: any, res: any) => {
    res.json({ consents: oauthProvider.listConsents() });
  });
  app.delete("/daemon/oauth-consents", requireBearer, (req: any, res: any) => {
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined;
    const redirectUri = typeof req.body?.redirectUri === "string" ? req.body.redirectUri : undefined;
    const removed = oauthProvider.revokeConsent(clientId, redirectUri);
    res.json({ ok: true, removed });
  });

  // Registered OAuth clients — list + revoke.
  //
  // Same static-bearer gating as /daemon/oauth-consents above; H11's
  // TUNNEL_ALLOWLIST already makes this loopback-only so no extra gating
  // is required here. Per-client revoke accepts ?clientId= (query) or
  // a JSON body { clientId }. No body (or query) on DELETE = revoke-all.
  app.get("/daemon/oauth-clients", requireBearer, (_req: any, res: any) => {
    res.json({ clients: oauthProvider.listClients() });
  });
  app.delete("/daemon/oauth-clients", requireBearer, (req: any, res: any) => {
    const clientId =
      typeof req.query?.clientId === "string" && req.query.clientId.length > 0
        ? req.query.clientId
        : typeof req.body?.clientId === "string" && req.body.clientId.length > 0
          ? req.body.clientId
          : undefined;
    if (clientId) {
      const ok = oauthProvider.revokeClient(clientId);
      res.json({ ok, removed: ok ? 1 : 0 });
      return;
    }
    const removed = oauthProvider.revokeAllClients();
    res.json({ ok: true, removed });
  });

  // Unauthenticated public pages — homepage, robots.txt, favicon. These go
  // through the security middleware (rate limit, UA block) but bypass bearer.
  //
  // Root path is a fork: MCP clients (Accept: application/json or text/
  // event-stream) may end up POSTing / GETting at / if the user pasted the
  // bare tunnel URL into their client config. We detect that by content type
  // / accept and forward to the /mcp handler. Browsers get the homepage.
  const looksLikeMcpClient = (req: any): boolean => {
    const accept = String(req.headers?.accept ?? "").toLowerCase();
    const contentType = String(req.headers?.["content-type"] ?? "").toLowerCase();
    if (req.method === "POST") return true;
    if (accept.includes("text/event-stream")) return true;
    if (accept.includes("application/json") && !accept.includes("text/html")) return true;
    if (contentType.includes("application/json")) return true;
    return false;
  };
  app.all("/", (req: any, res: any, next: any) => {
    if (looksLikeMcpClient(req)) {
      return next();
    }
    if (req.method !== "GET") {
      res.status(405).setHeader("Allow", "GET").end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.status(200).end(getHomepageHtml());
  });
  app.get("/robots.txt", (_req: any, res: any) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.status(200).end(getRobotsTxt());
  });
  app.get("/favicon.ico", (_req: any, res: any) => {
    res.status(204).end();
  });

  app.get("/daemon/events", requireBearer, (req: any, res: any) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`event: daemon:ready\ndata: ${JSON.stringify(getHealth())}\n\n`);
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  app.get("/daemon/health", requireBearer, (_req: any, res: any) => {
    res.json(getHealth());
  });

  app.post("/daemon/heartbeat", requireBearer, (req: any, res: any) => {
    const clientId = typeof req.body?.clientId === "string" && req.body.clientId.length > 0
      ? req.body.clientId
      : req.auth?.clientId ?? "daemon-client";
    heartbeatMap.set(clientId, Date.now());
    res.json({ ok: true, clientId });
  });

  app.post("/daemon/rotate-token", requireBearer, async (_req: any, res: any, next: any) => {
    try {
      currentToken = rotateToken({ tokenPath });
      await options.onTokenRotated?.(currentToken);
      publishEvent("daemon:token-rotated", {
        rotatedAt: currentToken.rotatedAt,
        version: currentToken.version,
      });
      res.json({
        ok: true,
        rotatedAt: currentToken.rotatedAt,
        version: currentToken.version,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/daemon/shutdown", requireBearer, (req: any, res: any, next: any) => {
    res.json({ ok: true });
    setImmediate(() => {
      close().catch(next);
    });
  });

  app.post("/daemon/enable-tunnel", requireBearer, async (_req: any, res: any, next: any) => {
    try {
      await options.onEnableTunnel?.();
      res.json({ ok: true, tunnel: getHealth().tunnel });
    } catch (error) {
      next(error);
    }
  });

  app.post("/daemon/disable-tunnel", requireBearer, async (_req: any, res: any, next: any) => {
    try {
      await options.onDisableTunnel?.();
      res.json({ ok: true, tunnel: getHealth().tunnel });
    } catch (error) {
      next(error);
    }
  });

  // /mcp accepts either the static daemon bearer OR a valid OAuth access
  // token. The provider's verifyAccessToken handles both. When the bearer is
  // the static daemon token, callers can still tag themselves via the
  // x-perplexity-client-id header (used by the extension host, cli, and
  // client-http helpers) so audit + progress-event filters stay meaningful.
  //
  // We DON'T use SDK's requireBearerAuth directly because its
  // resourceMetadataUrl is fixed at middleware-creation time, but our PRM
  // URL is tunnel-host-dependent (different for loopback vs trycloudflare).
  // Instead we call verifyAccessToken ourselves and emit a tunnel-aware
  // WWW-Authenticate header on 401 so Claude Desktop can discover PRM.
  const requireMcpAuth = async (req: any, res: any, next: any) => {
    const sendUnauthorized = (error: string, description: string) => {
      const issuer = resolveIssuer(req, oauthIssuer);
      const prm = new URL("/.well-known/oauth-protected-resource", issuer).href;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer error="${error}", error_description="${description}", resource_metadata="${prm}"`,
      );
      res.status(401).json({ error, error_description: description });
    };

    try {
      const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : null;
      if (!authHeader) {
        return sendUnauthorized("invalid_token", "Missing Authorization header");
      }
      const [type, token] = authHeader.split(/\s+/, 2);
      if (!token || type.toLowerCase() !== "bearer") {
        return sendUnauthorized("invalid_token", "Expected 'Bearer TOKEN'");
      }
      // H12: pass the trustworthy computed source (from attachRequestSource,
      // preserved by security.middleware) and the canonical expected resource
      // so the provider can enforce RFC 8707 binding + tunnel-only static
      // bearer rejection.
      const source: "loopback" | "tunnel" = req._pplx?.source === "tunnel" ? "tunnel" : "loopback";
      const expectedResource = resolveRequestResource(req, oauthIssuer);
      const info = await oauthProvider.verifyAccessToken(token, source, expectedResource);
      if (typeof info.expiresAt === "number" && info.expiresAt < Date.now() / 1000) {
        return sendUnauthorized("invalid_token", "Token expired");
      }
      req.auth = info;
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid token";
      sendUnauthorized("invalid_token", message);
    }
  };
  const promoteCallerClientId = (req: any, _res: any, next: any) => {
    try {
      const auth = (req as any).auth;
      if (auth && auth.clientId === "local-static") {
        const header = req.headers?.["x-perplexity-client-id"];
        const caller = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
        if (caller && caller.length > 0) {
          auth.clientId = caller;
        }
      }
    } catch {
      // best-effort
    }
    next();
  };
  // Mount MCP handler at BOTH /mcp and / so a user who pasted the bare tunnel
  // URL into their client config still works. The homepage route above
  // forwards matching MCP-shaped requests here via next().
  app.all(["/mcp", "/"], requireMcpAuth, promoteCallerClientId, async (req: any, res: any, next: any) => {
    try {
      const mcpServer = new McpServer({
        name: "perplexity",
        version,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      registerResources(mcpServer);
      registerPrompts(mcpServer);
      registerTools(mcpServer, getClient, getEnabledTools(loadToolConfig()), {
        onToolSettled: (event) => {
          appendAuditEntry({
            timestamp: new Date().toISOString(),
            clientId: event.clientId,
            tool: event.tool,
            durationMs: event.durationMs,
            source: event.source,
            ok: event.ok,
            ...(event.error ? { error: event.error } : {}),
          }, { auditPath });
        },
        onToolProgress: (event) => {
          publishEvent("daemon:tool-progress", { ...event });
        },
      });
      await mcpServer.connect(transport);

      let cleanedUp = false;
      const cleanup = async () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        activeMcpClosers.delete(cleanup);
        await mcpServer.close().catch(() => undefined);
      };
      activeMcpClosers.add(cleanup);
      res.on("close", () => {
        void cleanup();
      });

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  httpServer = createServer(app as any);
  try {
    await listenAvoidingBlockedPorts(httpServer, requestedPort, host);
  } catch (error) {
    // Bug-3: the caller (launcher) needs a clean signal — not a dangling
    // httpServer. Tear down the socket so the port is freed on subsequent
    // retries and rethrow the original error (with its .code intact) so the
    // launcher can branch on EADDRINUSE.
    try {
      httpServer.close();
    } catch {
      // ignore — server may not have a socket bound
    }
    httpServer = undefined;
    throw error;
  }

  // Bug-1 helper: run a best-effort shutdown step. If the step throws OR
  // rejects, log once and swallow — one failing step must NEVER short-circuit
  // the rest of the shutdown sequence (port release, lockfile cleanup, etc).
  const runShutdownStep = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[trace] daemon shutdown step '${label}' failed: ${message}`);
    }
  };

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;

    await runShutdownStep("sse-clients", () => {
      for (const response of sseClients) {
        try {
          response.end();
        } catch {
          // Individual SSE client teardown is best-effort.
        }
      }
      sseClients.clear();
    });

    for (const cleanup of Array.from(activeMcpClosers)) {
      await runShutdownStep("mcp-cleanup", () => cleanup());
    }
    await runShutdownStep("client-shutdown", () => client?.shutdown?.() ?? undefined);
    await runShutdownStep("on-shutdown", () => options.onShutdown?.() ?? undefined);
    if (httpServer) {
      await runShutdownStep("http-close", () =>
        new Promise<void>((resolve, reject) => {
          httpServer!.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
      );
    }
  };

  return {
    host,
    port: getBoundPort(httpServer),
    url: `http://${host}:${getBoundPort(httpServer)}`,
    // Live getter: must reflect the CURRENT token after rotation.
    // A plain snapshot here causes the launcher's syncLockfile to write
    // the stale pre-rotation bearer back into the lockfile on every
    // publishTunnelState, breaking auth for probes.
    get bearerToken() {
      return currentToken.bearerToken;
    },
    auditPath,
    tokenPath,
    close,
    publishEvent,
    getHealth,
    readAuditTail: (limit = 50) => readAuditTail(limit, { auditPath }),
    listOAuthClients: () => oauthProvider.listClients(),
    revokeOAuthClient: (clientId: string) => oauthProvider.revokeClient(clientId),
    revokeAllOAuthClients: () => oauthProvider.revokeAllClients(),
    resolveOAuthConsent: (consentId: string, approved: boolean) => consentCoordinator.resolve(consentId, approved),
    listOAuthConsents: () => oauthProvider.listConsents(),
    revokeOAuthConsents: (filter) => oauthProvider.revokeConsent(filter?.clientId, filter?.redirectUri),
  };
}

/**
 * Compute the source of a request from real network indicators only.
 *
 * H11: security decisions (admin-surface allowlist) must NEVER trust the
 * `x-perplexity-source` header — a tunnel caller could forge it. Only
 * examine X-Forwarded-For, CF-Connecting-IP, and the underlying socket IP.
 * The extension host's declared-source hint is captured separately into
 * `req._pplx.declaredSource` for audit enrichment but is never consulted
 * here.
 */
function computeRequestSource(req: RequestLike): "loopback" | "tunnel" {
  if (req.headers?.["x-forwarded-for"]) return "tunnel";
  if (req.headers?.["cf-connecting-ip"]) return "tunnel";
  const ip = req.ip ?? req.socket?.remoteAddress ?? "";
  if (ip && ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return "tunnel";
  return "loopback";
}

/**
 * Paths a tunnel caller is allowed to reach. Everything else (notably
 * `/daemon/*`) is returned as 404 to keep the admin surface invisible to
 * anyone who only has the tunnel URL — even if they somehow obtained the
 * static bearer.
 */
const TUNNEL_ALLOWLIST: RegExp[] = [
  /^\/mcp(\/|$|\?)/,
  /^\/$/,
  /^\/authorize(\/|$|\?)/,
  /^\/token(\/|$|\?)/,
  /^\/register(\/|$|\?)/,
  /^\/revoke(\/|$|\?)/,
  /^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource)(\/|$|\?)/,
  /^\/robots\.txt$/,
  /^\/favicon\.ico$/,
];

function pathIsTunnelAllowed(path: string): boolean {
  const bare = path.split("?")[0] ?? path;
  return TUNNEL_ALLOWLIST.some((re) => re.test(bare));
}

/** Resolve the OAuth issuer from the request's Host header so tunnel + loopback clients both see a correct metadata doc. */
function resolveIssuer(req: RequestLike, fallback: URL): URL {
  // Prefer X-Forwarded-Host when present — real cloudflared / ngrok front-
  // ends set this to the public hostname while the underlying Host header
  // stays 127.0.0.1 (local socket). Fall back to Host if the proxy only
  // rewrote one of them.
  const forwardedHostRaw = typeof req.headers?.["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : null;
  const forwardedHost = forwardedHostRaw ? forwardedHostRaw.split(",")[0]!.trim() : null;
  const host = forwardedHost ?? (typeof req.headers?.host === "string" ? req.headers.host : null);
  const forwardedProto = typeof req.headers?.["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : null;
  const cfConnecting = req.headers?.["cf-connecting-ip"];
  if (host) {
    const proto = forwardedProto ?? (cfConnecting ? "https" : "http");
    try {
      return new URL(`${proto}://${host}`);
    } catch {
      // fall through to fallback
    }
  }
  return fallback;
}

/**
 * Canonicalize the expected resource identifier (RFC 8707) for this
 * request. Returns `<scheme>://<host>/mcp` with no trailing slash so the
 * PRM endpoint, the /authorize→/token binding, and verifyAccessToken's
 * expectedResource all agree on a single form.
 */
export function resolveRequestResource(req: RequestLike, fallback: URL = new URL("http://localhost")): string {
  const issuer = resolveIssuer(req, fallback);
  return new URL("/mcp", issuer).toString().replace(/\/$/, "");
}

function readAuthorizationHeader(value: string | string[] | undefined): string | null {
  const header = readSingleHeader(value);
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function readSingleHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

function getBoundPort(server: HttpServer | undefined): number {
  const address = server?.address();
  if (!address || typeof address === "string") {
    throw new Error("Daemon server is not listening on a TCP port.");
  }
  return address.port;
}

/**
 * WHATWG fetch spec blocks a fixed list of "bad ports" (25, 6667, 10080, …).
 * When the caller asks for `port: 0` the OS picks an ephemeral port at
 * random — on rare occasions it hands back one of these blocked ports, and
 * every subsequent `fetch(daemon.url)` throws `bad port`. That's how the
 * OAuth-conformance tests flake in CI.
 *
 * Retry the listen up to 5 times when port is 0 and the OS assigns a
 * blocked port. For an explicitly-pinned port we never retry (caller is
 * responsible for not pinning a blocked port).
 *
 * @see https://fetch.spec.whatwg.org/#block-bad-port
 */
const FETCH_BLOCKED_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

async function listenAvoidingBlockedPorts(
  server: HttpServer,
  requestedPort: number,
  host: string,
): Promise<void> {
  const maxAttempts = requestedPort === 0 ? 5 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(requestedPort, host);
    });

    const boundPort = getBoundPort(server);
    if (!FETCH_BLOCKED_PORTS.has(boundPort)) {
      return;
    }

    // Unlucky ephemeral assignment: close and retry. Final attempt returns
    // the blocked port anyway so callers that can't fetch() will see the
    // real problem rather than silently hanging.
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

import { createServer, type Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { PerplexityClient } from "../client.js";
import { registerPrompts } from "../prompts.js";
import { registerResources } from "../resources.js";
import { getEnabledTools, loadToolConfig } from "../tool-config.js";
import { registerTools } from "../tools.js";
import { appendAuditEntry, getAuditLogPath, readAuditTail } from "./audit.js";
import {
  ConsentCoordinator,
  PerplexityOAuthProvider,
  type AuthorizedClientSummary,
} from "./oauth-provider.js";
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
  /** Extension host resolves a pending /authorize consent. */
  resolveOAuthConsent: (consentId: string, approved: boolean) => boolean;
}

export async function startDaemonServer(options: StartDaemonServerOptions = {}): Promise<StartedDaemonServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const version = options.version ?? process.env.npm_package_version ?? "0.5.0";
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
  const consentCoordinator = new ConsentCoordinator();
  const oauthProvider = new PerplexityOAuthProvider({
    configDir: options.configDir ?? ".",
    getStaticBearer: () => currentToken.bearerToken,
    requestConsent: ({ clientId, clientName, redirectUri, consentId }) => {
      return consentCoordinator.request({
        id: consentId,
        clientId,
        clientName,
        redirectUri,
        timeoutMs: 2 * 60_000,
        onRequest: () => {
          void options.onOAuthConsentRequest?.({ consentId, clientId, clientName, redirectUri });
          publishEvent("daemon:oauth-consent-request", { consentId, clientId, clientName, redirectUri });
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
      clientInitPromise = client.init();
    }
    await clientInitPromise;
    return client;
  };

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
  app.use((req: any, res: any, next: any) => {
    const startedAtReq = Date.now();
    const ctx = req._pplx ?? {};
    res.on("finish", () => {
      const durationMs = Date.now() - startedAtReq;
      const path = typeof req.path === "string" ? req.path : (req.url ?? "");
      const status = res.statusCode;
      const hasAuth = typeof req.headers?.authorization === "string";
      console.error(`[trace] http ${req.method} ${path} auth=${hasAuth ? "yes" : "no"} status=${status} dur=${durationMs}ms ip=${ctx.ip ?? "?"} ua=${(ctx.userAgent ?? "").slice(0, 40)}`);
      // Only audit admin + /mcp endpoints, not homepage/static.
      if (path.startsWith("/daemon") || path.startsWith("/mcp") || path.startsWith("/authorize") || path.startsWith("/token") || path.startsWith("/register")) {
        try {
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
              auth: hasAuth ? "bearer" : "none",
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

    req.auth = {
      token: currentToken.bearerToken,
      clientId: readSingleHeader(req.headers?.["x-perplexity-client-id"]) ?? "daemon-client",
      scopes: [],
      extra: {
        source: readSingleHeader(req.headers?.["x-perplexity-source"]) === "tunnel" ? "tunnel" : "loopback",
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
    res.json({
      resource: new URL("/mcp", issuer).href,
      authorization_servers: [issuer.href.replace(/\/$/, "")],
      scopes_supported: ["mcp"],
      resource_name: "Perplexity MCP",
    });
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

  // Unauthenticated public pages — homepage, robots.txt, favicon. These go
  // through the security middleware (rate limit, UA block) but bypass bearer.
  app.get("/", (_req: any, res: any) => {
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
  const requireMcpAuth: any = requireBearerAuth({ verifier: oauthProvider });
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
  app.all("/mcp", requireMcpAuth, promoteCallerClientId, async (req: any, res: any, next: any) => {
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
  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(requestedPort, host, () => resolve());
  });

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;

    for (const response of sseClients) {
      response.end();
    }
    sseClients.clear();

    for (const cleanup of Array.from(activeMcpClosers)) {
      await cleanup().catch(() => undefined);
    }
    await client?.shutdown?.().catch(() => undefined);
    await options.onShutdown?.();
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }).catch(() => undefined);
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
    resolveOAuthConsent: (consentId: string, approved: boolean) => consentCoordinator.resolve(consentId, approved),
  };
}

/** Resolve the OAuth issuer from the request's Host header so tunnel + loopback clients both see a correct metadata doc. */
function resolveIssuer(req: any, fallback: URL): URL {
  const host = typeof req.headers?.host === "string" ? req.headers.host : null;
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

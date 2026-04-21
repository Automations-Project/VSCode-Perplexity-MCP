import { createServer, type Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { PerplexityClient } from "../client.js";
import { registerPrompts } from "../prompts.js";
import { registerResources } from "../resources.js";
import { getEnabledTools, loadToolConfig } from "../tool-config.js";
import { registerTools } from "../tools.js";
import { appendAuditEntry, getAuditLogPath, readAuditTail } from "./audit.js";
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

  // Trace every admin/mcp request for diagnostics.
  app.use((req: any, res: any, next: any) => {
    const startedAtReq = Date.now();
    const hasAuth = typeof req.headers?.authorization === "string";
    res.on("finish", () => {
      const durationMs = Date.now() - startedAtReq;
      console.error(`[trace] http ${req.method} ${req.url ?? req.path} auth=${hasAuth ? "yes" : "no"} status=${res.statusCode} dur=${durationMs}ms`);
    });
    next();
  });

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

  app.all("/mcp", requireBearer, async (req: any, res: any, next: any) => {
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
    bearerToken: currentToken.bearerToken,
    auditPath,
    tokenPath,
    close,
    publishEvent,
    getHealth,
    readAuditTail: (limit = 50) => readAuditTail(limit, { auditPath }),
  };
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

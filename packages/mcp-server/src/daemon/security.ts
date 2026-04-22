/**
 * Security middleware for the daemon HTTP surface.
 *
 * Ships in Phase 6a — everything runs BEFORE the bearer check so that both
 * authenticated and unauthenticated requests are rate-limited / blocklisted.
 *
 * Components:
 *   1. IP/UA extraction into req._pplx (typed).
 *   2. Per-IP rate limit for unauthenticated requests (credentials often missing
 *      from /register, /authorize, public pages — bearer-rate-limit kicks in
 *      once authenticated).
 *   3. Per-bearer rate limit (60 rpm default). Loopback-sourced requests exempt.
 *   4. User-Agent blocklist — known scanners.
 *   5. 401-burst tripwire — 20 401s in 60s on the tunnel fires a callback so
 *      the launcher can auto-disable the tunnel.
 *   6. Slow-401 — every 401 response is delayed a fixed 150ms to defeat
 *      bearer-brute-force timing probes.
 */

import { setTimeout as delay } from "node:timers/promises";

export interface SecurityOptions {
  ratelimitRpm?: number;
  tripwireWindowMs?: number;
  tripwireThreshold?: number;
  slow401Ms?: number;
  uaBlocklist?: RegExp[];
  onTripwireTriggered?: (info: {
    source: "loopback" | "tunnel";
    failures: number;
    windowMs: number;
    ip: string | null;
  }) => void | Promise<void>;
}

export interface SecurityMiddlewareResult {
  middleware: (req: any, res: any, next: any) => void;
  record401: (info: { source: "loopback" | "tunnel"; ip: string | null }) => void;
  snapshot: () => SecurityDiagnostics;
}

export interface SecurityDiagnostics {
  tripwireFailures: number;
  tripwireWindowMs: number;
  tripwireThreshold: number;
  rateLimitedBearers: number;
  blockedUas: number;
}

const DEFAULT_UA_BLOCKLIST = [
  /\bmasscan\b/i,
  /\bnmap\b/i,
  /\bzgrab\b/i,
  /\bzmap\b/i,
  /\bsqlmap\b/i,
  /\bnikto\b/i,
  /\bgobuster\b/i,
  /\bdirbuster\b/i,
  /\bwpscan\b/i,
  /\bhydra\b/i,
  /\bcensys\b/i,
  /\bShodan\b/i,
];

/**
 * Create the security middleware stack. Call once per daemon instance.
 */
export function createSecurity(options: SecurityOptions = {}): SecurityMiddlewareResult {
  const ratelimitRpm = parseRpmEnv() ?? options.ratelimitRpm ?? 60;
  const tripwireWindowMs = options.tripwireWindowMs ?? 60_000;
  const tripwireThreshold = options.tripwireThreshold ?? 20;
  const slow401Ms = options.slow401Ms ?? 150;
  const uaBlocklist = options.uaBlocklist ?? DEFAULT_UA_BLOCKLIST;

  const bearerBuckets = new Map<string, number[]>();
  const tripwireEvents: number[] = [];
  let rateLimitedBearers = 0;
  let blockedUas = 0;
  let tripwireLatched = false;

  const middleware = (req: any, res: any, next: any) => {
    const ip = pickClientIp(req);
    const ua = typeof req.headers?.["user-agent"] === "string" ? req.headers["user-agent"] : "";
    const bearer = extractBearer(req.headers?.authorization);

    // H11/H12 source-of-truth: if `attachRequestSource` already stamped a
    // computed source on req._pplx, PRESERVE it. That upstream middleware
    // derives the source strictly from network indicators (X-Forwarded-For,
    // CF-Connecting-IP, socket IP) and MUST NOT be downgraded here — the
    // legacy isLoopbackRequest() helper trusted a self-reported
    // `x-perplexity-source: loopback` header, which a tunnel caller could
    // forge to bypass H12's tunnel-rejects-static-bearer enforcement. We
    // only fall back to computing source locally when the upstream
    // middleware was bypassed (e.g. direct middleware unit tests).
    const existing = req._pplx ?? {};
    const source: "loopback" | "tunnel" = existing.source === "tunnel" || existing.source === "loopback"
      ? existing.source
      : (isLoopbackRequest(req, ip) ? "loopback" : "tunnel");

    req._pplx = {
      ...existing,
      ip,
      userAgent: ua,
      source,
      bearer,
      startedAt: Date.now(),
    };

    // UA blocklist — applies to tunnel only. Local CLI tooling uses scripted
    // UAs which shouldn't be filtered.
    if (source === "tunnel" && ua && uaBlocklist.some((re) => re.test(ua))) {
      blockedUas += 1;
      res.status(403).json({ error: "Forbidden (user-agent blocklist)" });
      return;
    }

    // Per-bearer rate limit — tunnel only. Loopback callers (extension host,
    // local CLI) bypass.
    if (source === "tunnel" && bearer) {
      const now = Date.now();
      const bucket = bearerBuckets.get(bearer) ?? [];
      const cutoff = now - 60_000;
      const fresh = bucket.filter((ts) => ts >= cutoff);
      if (fresh.length >= ratelimitRpm) {
        rateLimitedBearers += 1;
        res.setHeader("Retry-After", "60");
        res.status(429).json({ error: "Too Many Requests" });
        return;
      }
      fresh.push(now);
      bearerBuckets.set(bearer, fresh);
    }

    // Hook into response finish so we can slow-401 + track tripwire counts.
    const originalStatus = res.status.bind(res);
    let slowPending = false;
    res.status = (code: number) => {
      if (code === 401 && source === "tunnel") {
        slowPending = true;
        record401({ source, ip });
      }
      return originalStatus(code);
    };

    if (slow401Ms > 0) {
      const originalEnd = res.end.bind(res);
      res.end = (...args: any[]) => {
        if (slowPending) {
          void delay(slow401Ms).then(() => originalEnd(...args));
          return res;
        }
        return originalEnd(...args);
      };
    }

    next();
  };

  const record401 = (info: { source: "loopback" | "tunnel"; ip: string | null }) => {
    if (info.source !== "tunnel") {
      return;
    }
    const now = Date.now();
    tripwireEvents.push(now);
    const cutoff = now - tripwireWindowMs;
    while (tripwireEvents.length > 0 && tripwireEvents[0]! < cutoff) {
      tripwireEvents.shift();
    }
    if (!tripwireLatched && tripwireEvents.length >= tripwireThreshold) {
      tripwireLatched = true;
      const failures = tripwireEvents.length;
      tripwireEvents.length = 0;
      queueMicrotask(() => {
        void options.onTripwireTriggered?.({
          source: info.source,
          failures,
          windowMs: tripwireWindowMs,
          ip: info.ip,
        });
      });
    }
  };

  const snapshot = (): SecurityDiagnostics => ({
    tripwireFailures: tripwireEvents.length,
    tripwireWindowMs,
    tripwireThreshold,
    rateLimitedBearers,
    blockedUas,
  });

  return { middleware, record401, snapshot };
}

/** Reset the tripwire latch — called after an auto-disable so future attacks re-trip. */
export function resetTripwire(security: SecurityMiddlewareResult): void {
  (security as unknown as { __tripwireLatched?: boolean }).__tripwireLatched = false;
}

function pickClientIp(req: any): string | null {
  const xff = typeof req.headers?.["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : null;
  if (xff) {
    return xff.split(",")[0]!.trim();
  }
  const cfip = typeof req.headers?.["cf-connecting-ip"] === "string" ? req.headers["cf-connecting-ip"] : null;
  if (cfip) return cfip;
  return req.ip ?? req.connection?.remoteAddress ?? req.socket?.remoteAddress ?? null;
}

function isLoopbackRequest(req: any, ip: string | null): boolean {
  // x-perplexity-source is set by the extension host to mark its own calls.
  if (req.headers?.["x-perplexity-source"] === "loopback") return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
    // Tunnel traffic arrives via cloudflared connecting from 127.0.0.1 too.
    // Use the cf-connecting-ip header presence as the disambiguator.
    if (req.headers?.["cf-connecting-ip"]) return false;
    return true;
  }
  return false;
}

function extractBearer(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function parseRpmEnv(): number | null {
  const raw = process.env.PERPLEXITY_DAEMON_RATELIMIT_RPM;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

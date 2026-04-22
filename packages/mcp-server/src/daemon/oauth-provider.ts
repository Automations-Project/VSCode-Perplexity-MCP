/**
 * OAuth 2.1 authorization-server provider for the Perplexity MCP daemon.
 *
 * Implements the MCP SDK's `OAuthServerProvider` interface. Plugs into
 * `mcpAuthRouter()` to expose `/authorize`, `/token`, `/register`, `/revoke`
 * and the `/.well-known/*` metadata endpoints.
 *
 * Design:
 *   - Clients are persisted in `<configDir>/oauth-clients.json` (0600).
 *   - Authorization codes are in-memory, 2-min TTL, single-use.
 *   - Access tokens are in-memory, 1-hour TTL.
 *   - Refresh tokens rotate on each exchange.
 *   - `verifyAccessToken` accepts either a valid OAuth access token OR the
 *     daemon's static bearer, so existing loopback callers (extension host
 *     + CLI) keep working with no changes.
 *   - `authorize()` defers to a caller-supplied `requestConsent` callback
 *     which the daemon wires to the VS Code extension's modal. Until the
 *     user approves or the 2-min timeout elapses, the HTTP response is
 *     held open.
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import * as consentCache from "./oauth-consent-cache.js";

const CODE_TTL_MS = 2 * 60_000;
const TOKEN_TTL_MS = 60 * 60_000;
const STATIC_CLIENT_ID = "local-static";

/**
 * Normalize a `resource` parameter (RFC 8707) into a canonical string or
 * `undefined`. URL → toString minus trailing slash; non-empty string kept
 * verbatim; anything else → undefined. The canonical shape is
 * `<scheme>://<host>/mcp`.
 */
function normalizeResource(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string" && input.length > 0) return input;
  if (input instanceof URL) return input.toString().replace(/\/$/, "");
  return undefined;
}

export interface OAuthProviderOptions {
  configDir: string;
  /**
   * Invoked when a browser hits `/authorize`. Must resolve to `true`
   * (approve) or `false` (deny). The daemon wires this to the VS Code
   * modal via an SSE-based consent coordinator.
   */
  requestConsent: (info: { clientId: string; clientName: string; redirectUri: string; consentId: string }) => Promise<boolean>;
  /** Live getter so rotate-token stays supported. */
  getStaticBearer: () => string;
  /**
   * Live getter for the consent-cache TTL in ms. `0` disables the cache
   * (modal fires every time). Read live per-authorize so toggling the
   * setting takes effect on the next request without restarting the
   * provider.
   */
  getConsentCacheTtlMs?: () => number;
  /**
   * Fires just before the authorize response is sent when the provider
   * decided to auto-approve from the consent cache. server.ts uses this
   * to flip the request's audit tag from `none` to `oauth-cached` so
   * the audit log records the cache hit distinctly.
   */
  onConsentCacheHit?: (info: { clientId: string; redirectUri: string; res: Response }) => void;
}

interface StoredClient extends OAuthClientInformationFull {
  consent_last_approved_at?: string;
  last_used_at?: string;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  exp: number;
  /** RFC 8707 — captured at /authorize, validated at /token exchange. */
  resource?: string;
}

interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  exp: number;
  refreshToken?: string;
  /** Preserved across refresh. `undefined` = legacy/unbound token. */
  resource?: string;
}

export interface AuthorizedClientSummary {
  clientId: string;
  clientName?: string;
  registeredAt: number;
  lastUsedAt?: string;
  consentLastApprovedAt?: string;
  activeTokens: number;
}

export class PerplexityOAuthProvider implements OAuthServerProvider {
  private codes = new Map<string, AuthCode>();
  private tokens = new Map<string, AccessTokenRecord>();
  private clients = new Map<string, StoredClient>();
  private clientsPath: string;
  private consentCachePath: string;

  constructor(private readonly options: OAuthProviderOptions) {
    this.clientsPath = join(options.configDir, "oauth-clients.json");
    this.consentCachePath = join(options.configDir, "oauth-consent.json");
    this.loadClients();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get(id),
      registerClient: async (client) => {
        const full: StoredClient = {
          ...client,
          client_id: `pplx-${crypto.randomBytes(12).toString("base64url")}`,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(full.client_id, full);
        this.persistClients();
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const ttlMs = this.options.getConsentCacheTtlMs?.() ?? 0;
    const cacheHit = ttlMs > 0 && consentCache.check(client.client_id, params.redirectUri, { cachePath: this.consentCachePath });

    if (cacheHit) {
      console.error(`[trace] oauth consent cache hit clientId=${client.client_id} redirectUri=${params.redirectUri}`);
      try {
        this.options.onConsentCacheHit?.({
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          res,
        });
      } catch {
        // audit tagging is best-effort; never fail the authorize because of it
      }
      return this.issueAuthorizationCode(client, params, res);
    }

    const consentId = crypto.randomBytes(8).toString("base64url");
    try {
      const approved = await this.options.requestConsent({
        clientId: client.client_id,
        clientName: client.client_name ?? client.client_id,
        redirectUri: params.redirectUri,
        consentId,
      });

      if (!approved) {
        return redirectTo(res, params.redirectUri, { error: "access_denied", state: params.state });
      }

      if (ttlMs > 0) {
        try {
          consentCache.record(client.client_id, params.redirectUri, ttlMs, { cachePath: this.consentCachePath });
        } catch {
          // cache write is best-effort; a failure here just means the next
          // request will re-prompt the user.
        }
      }

      return this.issueAuthorizationCode(client, params, res);
    } catch (err) {
      return redirectTo(res, params.redirectUri, {
        error: "server_error",
        error_description: err instanceof Error ? err.message : String(err),
        state: params.state,
      });
    }
  }

  private issueAuthorizationCode(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): void {
    const code = `pplx_ac_${crypto.randomBytes(24).toString("base64url")}`;
    const resource = normalizeResource((params as AuthorizationParams & { resource?: unknown }).resource);
    this.codes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      exp: Date.now() + CODE_TTL_MS,
      resource,
    });

    const stored = this.clients.get(client.client_id);
    if (stored) {
      stored.consent_last_approved_at = new Date().toISOString();
      this.persistClients();
    }

    return redirectTo(res, params.redirectUri, { code, state: params.state });
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code.");
    if (entry.exp < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code expired.");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL | string,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code.");
    if (entry.clientId !== client.client_id) throw new Error("Authorization code does not belong to this client.");
    if (entry.exp < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code expired.");
    }
    if (redirectUri && entry.redirectUri !== redirectUri) {
      throw new Error("redirect_uri does not match the code's registered redirect.");
    }
    const requestedResource = normalizeResource(resource);
    if (entry.resource && requestedResource && entry.resource !== requestedResource) {
      throw new Error("Token exchange resource does not match authorized resource.");
    }
    void codeVerifier; // SDK validates via challengeForAuthorizationCode

    this.codes.delete(authorizationCode);

    const tokens = this.issueTokenPair(client.client_id, entry.scopes, entry.resource ?? requestedResource);

    const stored = this.clients.get(client.client_id);
    if (stored) {
      stored.last_used_at = new Date().toISOString();
      this.persistClients();
    }

    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL | string,
  ): Promise<OAuthTokens> {
    let matched: [string, AccessTokenRecord] | null = null;
    for (const [at, rec] of this.tokens.entries()) {
      if (rec.refreshToken === refreshToken && rec.clientId === client.client_id) {
        matched = [at, rec];
        break;
      }
    }
    if (!matched) throw new Error("Invalid refresh token.");

    const requestedResource = normalizeResource(resource);
    if (matched[1].resource && requestedResource && matched[1].resource !== requestedResource) {
      throw new Error("Refresh resource does not match token's bound resource.");
    }
    const effectiveResource = matched[1].resource ?? requestedResource;

    this.tokens.delete(matched[0]);
    const tokens = this.issueTokenPair(client.client_id, scopes ?? matched[1].scopes, effectiveResource);

    const stored = this.clients.get(client.client_id);
    if (stored) {
      stored.last_used_at = new Date().toISOString();
      this.persistClients();
    }

    return tokens;
  }

  async verifyAccessToken(
    token: string,
    source: "loopback" | "tunnel" = "loopback",
    expectedResource?: string,
  ): Promise<AuthInfo> {
    if (token === this.options.getStaticBearer()) {
      // H12: static daemon bearer is loopback-only. The tunnel-allowlist
      // (H11) already blocks most admin paths over tunnel, but /mcp is
      // allowed — so the bearer check here is the last line of defence
      // against a tunnel caller who somehow obtained the static token.
      if (source === "tunnel") throw new Error("static bearer not valid on tunnel");
      // Static bearer doesn't expire until it's rotated — set a rolling
      // 1h expiry so SDK middleware's expiration check is happy. The
      // middleware will call verifyAccessToken again on every request so
      // this effectively just represents "valid as of now".
      return {
        token,
        clientId: STATIC_CLIENT_ID,
        scopes: ["local"],
        expiresAt: Math.floor((Date.now() + TOKEN_TTL_MS) / 1000),
      };
    }
    const rec = this.tokens.get(token);
    if (!rec) throw new Error("Invalid access token.");
    if (rec.exp < Date.now()) {
      this.tokens.delete(token);
      throw new Error("Access token expired.");
    }
    // H12 RFC 8707: if the token was bound to a resource at issuance, the
    // caller's request MUST be for that same resource. Rejected on any
    // source (loopback + tunnel) — mismatches are always an audience error.
    if (rec.resource && expectedResource && rec.resource !== expectedResource) {
      throw new Error(`Access token resource mismatch: token bound to ${rec.resource}, request expects ${expectedResource}.`);
    }
    // H12 RFC 8707: tokens without a resource binding pre-date this check
    // (legacy). Over a tunnel that's non-negotiable — we reject to force
    // the client to re-authorize with a `resource` param. Over loopback we
    // accept but surface a visible flag so the audit trail can distinguish
    // legacy from bound tokens.
    if (!rec.resource && source === "tunnel") {
      throw new Error("resource binding required over tunnel");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.exp / 1000),
      extra: {
        ...(rec.resource ? { resource: rec.resource } : { unboundResource: true }),
      },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const target = request.token;
    if (!target) return;
    if (this.tokens.delete(target)) return;
    for (const [at, rec] of this.tokens.entries()) {
      if (rec.refreshToken === target) {
        this.tokens.delete(at);
        return;
      }
    }
  }

  listClients(): AuthorizedClientSummary[] {
    const now = Date.now();
    return [...this.clients.values()].map((c) => ({
      clientId: c.client_id,
      clientName: c.client_name,
      registeredAt: c.client_id_issued_at ?? 0,
      lastUsedAt: c.last_used_at,
      consentLastApprovedAt: c.consent_last_approved_at,
      activeTokens: [...this.tokens.values()].filter((t) => t.clientId === c.client_id && t.exp >= now).length,
    }));
  }

  revokeClient(clientId: string): boolean {
    if (!this.clients.has(clientId)) return false;
    this.clients.delete(clientId);
    for (const [at, rec] of this.tokens.entries()) {
      if (rec.clientId === clientId) {
        this.tokens.delete(at);
      }
    }
    this.persistClients();
    // Also purge any cached consents for the revoked client so a future
    // registration with the same client_id can't silently inherit them.
    try {
      consentCache.revoke({ cachePath: this.consentCachePath, clientId });
    } catch {
      // best-effort
    }
    return true;
  }

  listConsents(): consentCache.ConsentEntry[] {
    return consentCache.list({ cachePath: this.consentCachePath });
  }

  revokeConsent(clientId?: string, redirectUri?: string): number {
    return consentCache.revoke({ cachePath: this.consentCachePath, clientId, redirectUri });
  }

  private issueTokenPair(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = `pplx_at_${crypto.randomBytes(24).toString("base64url")}`;
    const refreshToken = `pplx_rt_${crypto.randomBytes(24).toString("base64url")}`;
    const exp = Date.now() + TOKEN_TTL_MS;
    this.tokens.set(accessToken, {
      clientId,
      scopes,
      exp,
      refreshToken,
      resource,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" ") || undefined,
    };
  }

  private loadClients(): void {
    if (!existsSync(this.clientsPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.clientsPath, "utf8")) as StoredClient[];
      for (const c of raw) {
        if (c && typeof c.client_id === "string") {
          this.clients.set(c.client_id, c);
        }
      }
    } catch {
      // corrupted file — start fresh; persistClients will overwrite next write
    }
  }

  private persistClients(): void {
    try {
      mkdirSync(dirname(this.clientsPath), { recursive: true });
      writeFileSync(this.clientsPath, JSON.stringify([...this.clients.values()], null, 2), { mode: 0o600 });
    } catch {
      // best-effort
    }
  }
}

function redirectTo(res: Response, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) {
      url.searchParams.set(key, value);
    }
  }
  res.redirect(url.toString());
}

/**
 * Coordinator for /authorize ↔ /daemon/oauth-consent round-trip.
 *
 * `request()` starts a new pending consent and returns a Promise that resolves
 * when the extension host POSTs `/daemon/oauth-consent` with the matching id.
 * Times out after the given ms (denying by default).
 */
export class ConsentCoordinator {
  private pending = new Map<string, { resolve: (v: boolean) => void; timer: NodeJS.Timeout; info: { clientId: string; clientName: string; redirectUri: string } }>();

  request(options: {
    id: string;
    clientId: string;
    clientName: string;
    redirectUri: string;
    timeoutMs: number;
    onRequest: () => void;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(options.id);
        resolve(false);
      }, options.timeoutMs);
      this.pending.set(options.id, {
        resolve,
        timer,
        info: { clientId: options.clientId, clientName: options.clientName, redirectUri: options.redirectUri },
      });
      options.onRequest();
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pending.resolve(approved);
    this.pending.delete(id);
    return true;
  }

  list(): Array<{ id: string; clientId: string; clientName: string; redirectUri: string }> {
    return [...this.pending.entries()].map(([id, p]) => ({
      id,
      clientId: p.info.clientId,
      clientName: p.info.clientName,
      redirectUri: p.info.redirectUri,
    }));
  }
}

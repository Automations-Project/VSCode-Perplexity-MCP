declare module "express" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  /**
   * Per-request scratch object stamped by daemon middleware. Shape mirrors
   * the fields actually written in server.ts (`attachRequestSource`, audit
   * trace) and security.ts (`createSecurity` middleware). All fields are
   * optional so middleware ordering can populate them incrementally.
   */
  export interface RequestPplxContext {
    source?: "loopback" | "tunnel";
    declaredSource?: string;
    ip?: string | null;
    userAgent?: string;
    bearer?: string | null;
    startedAt?: number;
    authOverride?: "bearer" | "oauth" | "oauth-cached" | "none";
  }

  export interface Request extends IncomingMessage {
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
    method: string;
    /** Express adds these on top of the Node.js IncomingMessage. */
    ip?: string;
    path?: string;
    originalUrl?: string;
    query?: Record<string, string | string[] | undefined>;
    /** Set by bearer middleware (static daemon token or OAuth verifyAccessToken). */
    auth?: { clientId?: string; [key: string]: unknown };
    /** Daemon-specific per-request scratch (see attachRequestSource + security.middleware). */
    _pplx?: RequestPplxContext;
    on(event: "close" | "end" | "error" | string, listener: (...args: unknown[]) => void): this;
  }

  export interface Response extends ServerResponse {
    setHeader(name: string, value: string): this;
    status(code: number): this;
    json(body: unknown): this;
    write(chunk: string): boolean;
    end(chunk?: string): this;
    on(event: "close" | "end" | "error" | string, listener: (...args: unknown[]) => void): this;
    flushHeaders?: () => void;
    redirect(url: string): void;
    redirect(status: number, url: string): void;
    send(body?: unknown): this;
  }

  export type NextFunction = (error?: unknown) => void;

  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

  export type ErrorRequestHandler = (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void | Promise<void>;

  /**
   * Minimal subset of Express Request used by the daemon's
   * source/issuer/resource/IP-resolution helpers. Kept narrow so callers
   * can synthesize compatible objects in tests without reaching for the
   * full Request shape. `connection` is the deprecated alias for `socket`
   * — kept for parity with security.ts's IP-resolution fallback chain.
   */
  export type RequestLike = Pick<Request, "headers" | "ip" | "socket" | "connection">;

  export interface Express {
    use(...handlers: Array<RequestHandler | ErrorRequestHandler>): Express;
    use(path: string | string[] | RegExp, ...handlers: Array<RequestHandler | ErrorRequestHandler>): Express;
    all(path: string | string[] | RegExp, ...handlers: RequestHandler[]): Express;
    get(path: string | string[] | RegExp, ...handlers: RequestHandler[]): Express;
    post(path: string | string[] | RegExp, ...handlers: RequestHandler[]): Express;
    put(path: string | string[] | RegExp, ...handlers: RequestHandler[]): Express;
    delete(path: string | string[] | RegExp, ...handlers: RequestHandler[]): Express;
    set?(setting: string, value: unknown): Express;
  }

  interface ExpressFactory {
    (): Express;
    json(options?: unknown): RequestHandler;
  }

  const express: ExpressFactory;
  export default express;
}

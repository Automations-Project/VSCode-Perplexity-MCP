import type { PlaywrightCookie } from "./config.js";

/**
 * Minimal RFC 6265-style cookie jar for the impit-driven login flow.
 *
 * Identity = `(name, domain, path)` triple — same triple replaces. Domain
 * matching honours leading-dot semantics; path matching is prefix-based with
 * default-path derived from the request URL. Honours `Expires`, `Max-Age`
 * (Max-Age wins), `Secure`, and `HttpOnly` (round-tripped, not enforced).
 *
 * Round-trips cleanly to/from the `PlaywrightCookie` shape used by
 * `getSavedCookies()` and the vault, so the impit login output can replace
 * Patchright's cookie array drop-in.
 */
export class CookieJar {
  constructor(initialCookies?: PlaywrightCookie[]);

  /**
   * Apply one or more `Set-Cookie` headers from a response. Accepts either a
   * single string (joined header) or an array of values, e.g. from
   * `res.headers.getSetCookie?.()`. Cookies whose Max-Age is `<= 0` or whose
   * Expires is in the past are *deleted* from the jar (server-driven delete);
   * cookies that merely become stale via wall-clock drift remain in the jar
   * but are filtered out of `buildCookieHeader`.
   */
  consumeSetCookieHeader(header: string | string[] | null | undefined, requestUrl: string): void;

  /**
   * Build a `Cookie:` header value for `requestUrl`. Returns `""` when no
   * cookies match (so callers can `if (h) headers.cookie = h`). Filters out
   * cookies whose Secure flag is set when the request URL is `http://`, and
   * cookies whose Expires/Max-Age is in the past. Sorted by path length
   * descending, per RFC 6265 §5.4.
   */
  buildCookieHeader(requestUrl: string): string;

  /**
   * Snapshot of every cookie in the jar (including expired ones — callers
   * that persist to disk want the full set so a later refresh can simply
   * overwrite).
   */
  toPlaywrightShape(): PlaywrightCookie[];

  /**
   * Explicit setter, mostly for tests and for callers that already have a
   * fully-formed cookie record (e.g. seeding `cf_clearance` from the vault).
   */
  set(
    name: string,
    value: string,
    attributes?: Partial<PlaywrightCookie> & { hostOnly?: boolean },
  ): void;
}

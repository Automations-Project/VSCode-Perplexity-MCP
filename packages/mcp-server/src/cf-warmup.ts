// ── Cloudflare warmup helper ──────────────────────────────────────────────
//
// Briefly launches a hidden headless Chromium, navigates to perplexity.ai,
// waits for `cf_clearance` to appear (Cloudflare auto-solves Turnstile for
// clean residential IPs), then closes — feeding the captured cookie into the
// impit-based login jar. See docs/impit-coverage-plan.md §3.3.
//
// Always returns a result object — never throws. The caller falls back to
// the full browser-based login when ok=false or hasCfClearance=false.
//
// Design notes:
//  - Ephemeral context (browser.newContext) instead of launchPersistentContext.
//    Persistent CF state belongs to the regular login profile, which a
//    different code path manages; this warmup is intended to be lightweight,
//    isolated, and discardable.
//  - STEALTH_ARGS deliberately not reused; the cookie-refresh path in
//    refresh.ts (`tierBrowser`) demonstrates that headless + a clean default
//    arg set is sufficient for CF challenge resolution. The flags removed in
//    the 2026-04-27 public-hardening audit (--disable-web-security,
//    --disable-features=IsolateOrigins, etc.) are NOT re-introduced here.
//  - Error categories: (a) browser-resolution failure (no Chrome / Edge /
//    Chromium / bundled), (b) patchright import failure, (c) launch /
//    navigation failure. All map to ok=false with a descriptive `error`.
//    A successful navigation that does not yield cf_clearance returns ok=true
//    with hasCfClearance=false — useful signal for the caller (browser is
//    healthy, CF just didn't trust this IP enough to skip the challenge).

import {
  PERPLEXITY_URL,
  findBrowser,
  resolveBrowserExecutable,
  getOrCreateContext,
  type PlaywrightCookie,
} from "./config.js";

export interface WarmCloudflareOptions {
  /** Hard cap on the initial page.goto. Default 15_000ms. */
  navigationTimeoutMs?: number;
  /** How often to recheck context cookies for `cf_clearance`. Default 250ms. */
  pollIntervalMs?: number;
  /** Total wall-clock budget for the cookie poll loop after navigation. Default 10_000ms. */
  cookieWaitMs?: number;
}

export interface WarmCloudflareResult {
  /**
   * True iff the browser launched and navigation succeeded. May be true even
   * when `hasCfClearance` is false — distinguishes "browser unusable" from
   * "browser fine, CF just didn't issue clearance this time".
   */
  ok: boolean;
  /** All cookies present in the ephemeral context at teardown. Empty on launch failure. */
  cookies: PlaywrightCookie[];
  /** Whether `cf_clearance` was observed in `cookies`. */
  hasCfClearance: boolean;
  /** Wall-clock duration of the warmup attempt, in milliseconds. */
  elapsedMs: number;
  /** Populated when `ok=false`. Single-line, human-readable. */
  error?: string;
}

const DEFAULTS = {
  navigationTimeoutMs: 15_000,
  pollIntervalMs: 250,
  cookieWaitMs: 10_000,
} as const;

/**
 * Brief headless launch to capture cf_clearance for the impit-login flow.
 *
 * Always returns a result object — never throws. Caller falls back to the
 * full browser-based login when ok=false or hasCfClearance=false.
 */
export async function warmCloudflare(opts: WarmCloudflareOptions = {}): Promise<WarmCloudflareResult> {
  const navigationTimeoutMs = opts.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const cookieWaitMs = opts.cookieWaitMs ?? DEFAULTS.cookieWaitMs;

  const started = Date.now();

  // Step 1: resolve a browser executable. resolveBrowserExecutable() throws a
  // descriptive multi-line error when nothing is installed; we collapse it to
  // a single-line `error` field so callers can log it cleanly.
  let resolved: Awaited<ReturnType<typeof resolveBrowserExecutable>>;
  try {
    resolved = await resolveBrowserExecutable();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const oneLine = msg.split("\n")[0] ?? msg;
    console.error(`[cf-warmup] error: ${oneLine}`);
    return {
      ok: false,
      cookies: [],
      hasCfClearance: false,
      elapsedMs: Date.now() - started,
      error: oneLine,
    };
  }

  // Step 2: import patchright lazily. It is externalized in tsup configs and
  // listed in the extension's prepare-package-deps copy list, so the import
  // resolves from node_modules at runtime in both standalone and bundled use.
  let chromium: typeof import("patchright").chromium;
  try {
    chromium = (await import("patchright")).chromium;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cf-warmup] error: patchright import failed: ${msg}`);
    return {
      ok: false,
      cookies: [],
      hasCfClearance: false,
      elapsedMs: Date.now() - started,
      error: `patchright missing: ${msg}`,
    };
  }

  console.error(`[cf-warmup] launching ${resolved.path}`);

  // Step 3: launch + navigate + poll. Single try/finally guarantees teardown.
  const probe = findBrowser();
  let browser: import("patchright").Browser | null = null;
  let cookies: PlaywrightCookie[] = [];
  let hasCfClearance = false;
  let ok = false;
  let error: string | undefined;

  try {
    browser = await chromium.launch({
      headless: true,
      // Minimal arg set — reusing the launch shape from refresh.ts::tierBrowser
      // (which already proves out CF resolution under headless). Notably we
      // strip Playwright's default `--enable-automation` flag since CF
      // fingerprints it.
      ...(probe ? { executablePath: probe.path } : {}),
      ...(probe && (probe.channel === "chrome" || probe.channel === "msedge" || probe.channel === "chromium")
        ? { channel: probe.channel }
        : {}),
      ignoreDefaultArgs: ["--enable-automation"],
    });

    // Fresh ephemeral context — no persistent storage. Anything CF gives us
    // here is captured into `cookies` and handed back to the caller for the
    // impit jar; the on-disk login profile is owned by a separate code path.
    const ctx = await getOrCreateContext(browser);

    const page = await ctx.newPage();
    await page.goto(PERPLEXITY_URL, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMs,
    });

    // Navigation succeeded — even if cf_clearance never appears, ok=true.
    ok = true;

    // Step 4: poll for cf_clearance. We re-read context cookies (not page
    // cookies) because that's where Set-Cookie from the CF challenge lands.
    const pollStarted = Date.now();
    while (Date.now() - pollStarted < cookieWaitMs) {
      const current = (await ctx.cookies()) as PlaywrightCookie[];
      if (current.some((c) => c.name === "cf_clearance")) {
        cookies = current;
        hasCfClearance = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Step 5: capture cookies on the way out regardless. If we found
    // cf_clearance early we already have the snapshot above; otherwise grab
    // a final snapshot — side cookies (e.g. __cf_bm) can still be useful to
    // the caller.
    if (!hasCfClearance) {
      cookies = (await ctx.cookies()) as PlaywrightCookie[];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cf-warmup] error: ${msg}`);
    ok = false;
    error = msg;
  } finally {
    // ALWAYS close the browser, even on success. This warmup is meant to be
    // brief — leaving headless Chromium processes running would slowly leak
    // descriptors across repeated impit retries.
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Best-effort; ignore.
      }
    }
  }

  const elapsedMs = Date.now() - started;
  console.error(
    `[cf-warmup] complete: cf_clearance=${hasCfClearance} cookies=${cookies.length} elapsedMs=${elapsedMs}`,
  );

  return { ok, cookies, hasCfClearance, elapsedMs, ...(error ? { error } : {}) };
}

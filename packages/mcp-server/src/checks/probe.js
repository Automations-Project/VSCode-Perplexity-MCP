import { read as readDaemonLock, isStale as daemonLockIsStale } from "../daemon/lockfile.js";
import { getActiveName } from "../profiles.js";

const CATEGORY = "probe";

/**
 * True when a LIVE daemon owns the SAME profile's browser session the probe
 * would launch against. The daemon holds the `browser-data` profile via a
 * long-lived launchPersistentContext; an independent probe launching its own
 * context on the SAME --user-data-dir collides on the Chromium singleton lock
 * (issue #8 — Windows exitCode 21). When this returns true the probe must NOT
 * launch its own browser; the daemon's real auth state is already surfaced by
 * the `profiles` check (daemon-status.json).
 *
 * The daemon.lock is global (one daemon) and records no profile, but the
 * daemon follows the active-profile pointer — it only holds the lock for the
 * ACTIVE profile. The probe's PerplexityClient launches against
 * `PERPLEXITY_PROFILE || active`, so a probe explicitly targeting a DIFFERENT
 * profile uses a different browser-data dir and will NOT collide. Guard only
 * when the probe's effective profile matches the active profile.
 */
export function liveDaemonOwnsProfile() {
  try {
    const record = readDaemonLock();
    if (!record || daemonLockIsStale(record)) return false;
    const active = getActiveName() ?? "default";
    const probeProfile = process.env.PERPLEXITY_PROFILE ?? active;
    return probeProfile === active;
  } catch {
    return false;
  }
}

async function defaultSearch({ timeoutMs }) {
  const { PerplexityClient } = await import("../client.js");
  const client = new PerplexityClient();
  // Force the headless-only path so the probe never opens a visible browser
  // window. The headed Cloudflare bootstrap was leaving Chrome windows
  // dangling on every Deep check / probe re-run when init() or close() failed
  // mid-flight; the probe is a smoke test for the headless search path that
  // tools actually use, so skipping the headed phase is the right scope. The
  // env var is restored in a finally so concurrent tool-call clients aren't
  // affected.
  const HEADLESS_KEY = "PERPLEXITY_HEADLESS_ONLY";
  const prevHeadlessOnly = process.env[HEADLESS_KEY];
  process.env[HEADLESS_KEY] = "1";
  const t0 = Date.now();
  try {
    // init() is INSIDE the try so the finally always runs shutdown(), even
    // when init throws (browser launch failure, CF timeout, etc.). Previously
    // a failed init left both the persistent context AND the freshly-spawned
    // chrome.exe dangling, which is how visible browser windows were piling
    // up across repeated Deep check clicks.
    await client.init();
    const authenticated = client.authenticated;
    const result = await client.search({
      query: "What is the capital of France? Cite at least one web source.",
      modelPreference: "turbo",
      mode: "concise",
      sources: ["web"],
      language: "en-US",
    });
    const elapsedMs = Date.now() - t0;
    return {
      answer: result.answer ?? "",
      sources: result.sources ?? [],
      elapsedMs,
      authenticated,
      threadUrl: result.threadUrl ?? null,
    };
  } finally {
    await client.shutdown().catch(() => {});
    if (prevHeadlessOnly === undefined) delete process.env[HEADLESS_KEY];
    else process.env[HEADLESS_KEY] = prevHeadlessOnly;
  }
}

export async function run(opts = {}) {
  if (!opts.probe) {
    return [{ category: CATEGORY, name: "probe-search", status: "skip", message: "skipped (pass --probe to enable)" }];
  }
  // Single-owner guard (issue #8): if a live daemon already holds the
  // profile's browser-data session, do NOT launch a competing persistent
  // context — it would collide on the Chromium profile singleton lock
  // (Windows exitCode 21 / "Target page, context or browser has been closed")
  // and could even knock the daemon out of its own reinit. The daemon's real
  // auth state is reported separately by the `profiles` check (daemon-status).
  const daemonOwns = opts.daemonOwnsOverride ?? liveDaemonOwnsProfile;
  if (daemonOwns()) {
    return [{
      category: CATEGORY,
      name: "probe-search",
      status: "skip",
      message: "skipped — a live daemon owns this profile's browser session",
      hint: "An independent probe would collide with the daemon on the browser-data profile lock (issue #8). The daemon's live auth state is shown under the 'profiles' check (daemon-status). To run a standalone probe, stop the daemon first, then re-run with --probe.",
    }];
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const search = opts.searchOverride ?? defaultSearch;
  try {
    const result = await search({ timeoutMs });
    if (!result.sources || result.sources.length === 0) {
      if (result.authenticated && (result.answer?.trim() || result.threadUrl)) {
        return [{
          category: CATEGORY,
          name: "probe-search",
          status: "warn",
          message: `probe search completed without citations (latency ${result.elapsedMs}ms)`,
          hint: "Session appears authenticated, but Perplexity returned no sources for the probe query. Retry once before treating this as an auth failure.",
        }];
      }
      return [{
        category: CATEGORY,
        name: "probe-search",
        status: "fail",
        message: `probe returned no sources (latency ${result.elapsedMs}ms)`,
        hint: result.authenticated
          ? "Perplexity returned no citations for the probe query. Retry once; if it persists, inspect the extension logs."
          : "Session may be anonymous — run login, then --probe again.",
      }];
    }
    return [{
      category: CATEGORY,
      name: "probe-search",
      status: "pass",
      message: `live search returned ${result.sources.length} source(s) in ${result.elapsedMs}ms`,
      detail: { latencyMs: result.elapsedMs, sourceCount: result.sources.length },
    }];
  } catch (err) {
    return [{
      category: CATEGORY,
      name: "probe-search",
      status: "fail",
      message: `probe failed: ${err.message}`,
      hint: "Check network / auth — run `doctor` without --probe to see which category regressed.",
    }];
  }
}

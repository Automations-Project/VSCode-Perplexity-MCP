const CATEGORY = "probe";

async function defaultSearch({ timeoutMs }) {
  const { PerplexityClient } = await import("../client.js");
  const client = new PerplexityClient();
  await client.init();
  const authenticated = client.authenticated;
  const t0 = Date.now();
  try {
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
  }
}

export async function run(opts = {}) {
  if (!opts.probe) {
    return [{ category: CATEGORY, name: "probe-search", status: "skip", message: "skipped (pass --probe to enable)" }];
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

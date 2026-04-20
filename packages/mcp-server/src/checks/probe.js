const CATEGORY = "probe";

async function defaultSearch({ timeoutMs }) {
  const { PerplexityClient } = await import("../client.js");
  const client = new PerplexityClient();
  await client.init();
  const t0 = Date.now();
  try {
    const result = await client.search({
      query: "hello",
      modelPreference: "turbo",
      mode: "concise",
      sources: ["web"],
      language: "en-US",
    });
    const elapsedMs = Date.now() - t0;
    return { sources: result.sources ?? [], elapsedMs };
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
      return [{
        category: CATEGORY,
        name: "probe-search",
        status: "fail",
        message: `probe returned no sources (latency ${result.elapsedMs}ms)`,
        hint: "Session may be anonymous — run login, then --probe again.",
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

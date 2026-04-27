/**
 * End-to-end harness: exercises the chain from `manual-login-runner` writing
 * vault cookies + .reinit sentinel through `PerplexityClient.init()` reading
 * back the session and computing `accountInfo.isPro`.
 *
 * Regression coverage
 * -------------------
 * After a successful manual login (vault populated, .reinit dropped), the
 * long-lived MCP server's reinit had been demoting the user to
 * anonymous / isPro:false even though the underlying account is Pro. Two
 * causes were investigated:
 *
 *   H1 (cookie-handoff gap): `manual-login-runner.js` writes cookies to the
 *       vault but its ephemeral `browser.newContext()` never persists them to
 *       the on-disk profile. `client.ts:headedBootstrap` then launches
 *       `chromium.launchPersistentContext(browserData, …)` against an empty
 *       `browserData/` dir, fetches Perplexity anonymously. Empirically
 *       refuted as the SOLE cause: client.ts has a built-in recovery —
 *       when `accountInfo.modelsConfig` is still null after the headed
 *       phase, `loadAccountInfo()` re-runs against the headless context
 *       which does carry vault cookies. The "H1 control" test below locks
 *       this recovery in.
 *
 *   H2 (missing inference fallback): `client.ts` previously only read
 *       `experiments.server_is_pro` to derive `isPro`. When the experiments
 *       payload omitted that flag (production-observed), a real Pro user
 *       was demoted because the client did not fall back on
 *       `asi.can_use_computer` the way `refresh.ts:603-619` does. Fixed by
 *       mirroring the inference into `client.ts:deriveTierFlagsFromExperiments`.
 *       The "H2 regression" test below is the deterministic guard.
 *
 * Strategy
 * --------
 * Each `it()` exercises one observable property of the login → tier chain.
 * All three are now positive (green) regression tests. Any future change
 * that removes the inference fallback in client.ts, breaks the
 * headless-recovery path in init(), or weakens the runner-side cache write
 * will fail one of these tests deterministically.
 *
 * URL redirection
 * ---------------
 * `client.ts` hardcodes `https://www.perplexity.ai` via constants in
 * `config.ts` (no env-var override). We use `vi.mock` to point the URL
 * constants at the local mock-server. This is a TEST-ONLY override — the
 * production source is never touched.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start as startMock } from "./mock-server.js";

// Hoisted holder so `vi.mock` (also hoisted) can read mock URL + per-test
// experiments override at factory-evaluation time. The factory runs once
// when the mocked module is first imported; we set `mockState.url` before
// the import. The experiments override is consumed by the H2 scenario to
// swap in the no-pro-flag variant.
const mockState = vi.hoisted(() => ({
  url: "",
  experimentsQueryOverride: "",
}));

vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual("../../src/config.js");
  // Define the URL constants as getter properties so each access reads the
  // current mockState — this matters for the H2 scenario which mutates the
  // experiments-endpoint query string between tests. ES module bindings
  // honor getter semantics on the namespace object the consumer sees.
  const ns = { ...actual };
  Object.defineProperty(ns, "PERPLEXITY_URL", { get: () => mockState.url || actual.PERPLEXITY_URL, enumerable: true });
  Object.defineProperty(ns, "AUTH_SESSION_ENDPOINT", { get: () => `${mockState.url}/api/auth/session`, enumerable: true });
  Object.defineProperty(ns, "MODELS_CONFIG_ENDPOINT", { get: () => `${mockState.url}/rest/models/config?config_schema=v1&version=2.18&source=default`, enumerable: true });
  Object.defineProperty(ns, "ASI_ACCESS_ENDPOINT", { get: () => `${mockState.url}/rest/billing/asi-access-decision?version=2.18&source=default`, enumerable: true });
  Object.defineProperty(ns, "RATE_LIMIT_ENDPOINT", { get: () => `${mockState.url}/rest/rate-limit/status?version=2.18&source=default`, enumerable: true });
  Object.defineProperty(ns, "EXPERIMENTS_ENDPOINT", {
    get: () => {
      const q = mockState.experimentsQueryOverride || "version=2.18&source=default";
      return `${mockState.url}/rest/experiments/attributes?${q}`;
    },
    enumerable: true,
  });
  Object.defineProperty(ns, "USER_INFO_ENDPOINT", { get: () => `${mockState.url}/rest/user/info?version=2.18&source=default`, enumerable: true });
  return ns;
});

const RUNNER = fileURLToPath(new URL("../../dist/manual-login-runner.mjs", import.meta.url));

/** Fork the manual-login-runner against the mock and wait for clean exit. */
function forkRunner(env) {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("close", (code) => {
      const lines = out.trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      try { resolve({ code, result: JSON.parse(last) }); }
      catch { reject(new Error(`bad runner output: ${out}`)); }
    });
    child.on("error", reject);
  });
}

describe("login -> reinit -> tier (integration harness)", () => {
  let mock;
  let configDir;
  // Imported lazily INSIDE each test so the vi.mock above is in effect when
  // the modules are first evaluated by vitest's loader.
  let PerplexityClient;
  let createProfile, setActive;
  let Vault;
  let __resetKeyCache;

  beforeAll(async () => {
    mock = await startMock({ port: 0 });
    mockState.url = mock.url;

    // Now that mockState.url is set, import the modules. Importing here (not
    // at module top) ensures the vi.mock factory closes over the correct URL.
    ({ PerplexityClient } = await import("../../src/client.js"));
    ({ createProfile, setActive } = await import("../../src/profiles.js"));
    ({ Vault, __resetKeyCache } = await import("../../src/vault.js"));
  }, 30_000);

  afterAll(async () => {
    await mock.close();
  });

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-tier-e2e-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "tier-e2e-pass";
    process.env.PERPLEXITY_PROFILE = "default";
    __resetKeyCache?.();
    createProfile("default");
    setActive("default");
    // Defensive: clear any session-token override that would short-circuit
    // getSavedCookies and bypass the vault path.
    delete process.env.PERPLEXITY_SESSION_TOKEN;
    delete process.env.PERPLEXITY_CSRF_TOKEN;
  });

  afterEach(() => {
    delete process.env.PERPLEXITY_HEADLESS_ONLY;
  });

  /**
   * Sanity: run the runner, confirm vault has cookies and the cache file
   * (written by collectSessionMetadata) reflects a Pro session. This proves
   * the harness wiring works end-to-end. Expected GREEN today.
   */
  it("[expected: green] runner writes vault + cache with isPro:true (sanity)", async () => {
    const { code } = await forkRunner({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "tier-e2e-pass",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
      PERPLEXITY_TEST_AUTO_LOGIN_EMAIL: "tier-sanity@mock.test",
      PERPLEXITY_POLL_MS: "200",
    });
    expect(code).toBe(0);

    __resetKeyCache?.();
    const vault = new Vault();
    const cookies = JSON.parse(await vault.get("default", "cookies"));
    expect(cookies.some((c) => c.name === "__Secure-next-auth.session-token")).toBe(true);

    const cacheFile = join(configDir, "profiles", "default", "models-cache.json");
    expect(existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cache.isPro).toBe(true);
  }, 60_000);

  /**
   * H2 witness — isolated from H1 by setting PERPLEXITY_HEADLESS_ONLY=1, so
   * the headed bootstrap (and therefore the persistent-context cookie gap) is
   * skipped. The cookies in the vault ARE present and the headless phase DOES
   * authenticate. The mock returns experiments with no `server_is_pro` flag
   * but `asi.can_use_computer:true` (real-world payload shape that has been
   * observed). The client's `loadAccountInfo` must infer `isPro = true` from
   * `(canUseComputer && !isMax && !isEnterprise)` — the same fallback that
   * `refresh.ts:616` and `session-metadata.js:73-75` already implement, now
   * mirrored into `client.ts` via `deriveTierFlagsFromExperiments`. This test
   * is the regression guard against the experiments payload silently
   * demoting authenticated Pro accounts to Free.
   */
  it("[regression: H2] PerplexityClient infers Pro from can_use_computer when experiments omits server_is_pro (HEADLESS_ONLY)", async () => {
    // Step 1 — populate vault via runner so getSavedCookies returns a real
    // session cookie. The runner's auto-login uses the un-suffixed mock URL.
    const { code } = await forkRunner({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "tier-e2e-pass",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
      PERPLEXITY_TEST_AUTO_LOGIN_EMAIL: "h2-witness@mock.test",
      PERPLEXITY_POLL_MS: "200",
    });
    if (code !== 0) throw new Error(`runner setup failed (code ${code}); cannot witness H2`);

    // Step 2 — delete the runner-written cache so loadCachedAccountInfo
    // can't shortcut the live derivation. Then skip headed bootstrap
    // (isolate from H1) and flip the experiments endpoint to the
    // no-pro-flag variant served by the mock. This simulates the realistic
    // production scenario where the long-lived MCP server starts up with
    // vault cookies but no (or stale) cache, so isPro is derived live from
    // experiments + asi.
    const cacheFile = join(configDir, "profiles", "default", "models-cache.json");
    if (existsSync(cacheFile)) rmSync(cacheFile);

    process.env.PERPLEXITY_HEADLESS_ONLY = "1";
    mockState.experimentsQueryOverride = "force_no_pro_flag=1";

    let client;
    let observedIsPro;
    let observedAuthenticated;
    let observedCanUseComputer;
    try {
      __resetKeyCache?.();
      client = new PerplexityClient();
      await client.init();
      observedIsPro = client.accountInfo.isPro;
      observedAuthenticated = client.authenticated;
      observedCanUseComputer = client.accountInfo.canUseComputer;
    } finally {
      mockState.experimentsQueryOverride = "";
      if (client) await client.shutdown?.().catch(() => {});
    }
    // Sanity: the headless phase MUST authenticate and observe Computer
    // access; otherwise we're not actually exercising the inference path
    // (we'd be observing a different failure mode). Throw plain errors
    // here so test-mechanics breakage is loud and distinct from a real
    // regression in the inference logic.
    if (!observedAuthenticated) throw new Error("H2 setup invalid: client did not authenticate");
    if (!observedCanUseComputer) throw new Error("H2 setup invalid: asi.can_use_computer was false");
    // Regression assertion: with can_use_computer:true and no
    // server_is_pro flag, the client's deriveTierFlagsFromExperiments
    // helper infers isPro:true. If this fails, the inference fallback in
    // client.ts has been removed or weakened.
    expect(observedIsPro, "isPro should be true given can_use_computer:true (inference fallback)").toBe(true);
  }, 120_000);

  /**
   * H1 control — default config (NO PERPLEXITY_HEADLESS_ONLY). The runner
   * populates the vault but the headed bootstrap launches
   * `chromium.launchPersistentContext(browserData)` against an EMPTY profile
   * dir, so the headed phase fetches Perplexity anonymously.
   *
   * EMPIRICAL FINDING (this harness): under H1's stated conditions the bug
   * does NOT manifest end-to-end, because client.ts:252-257 runs a recovery
   * `loadAccountInfo()` whenever `accountInfo.modelsConfig` is still null
   * after headed bootstrap (which it is, since the anonymous headed phase
   * never sets it — see the `if (this.authenticated)` gate at client.ts:327).
   * The headless phase then injects vault cookies, authenticates, and
   * re-derives isPro:true.
   *
   * That refutes H1 *as the sole cause*; H1's cookie-handoff gap is real
   * but the recovery path masks it whenever the experiments payload has
   * `server_is_pro:true`. The bug must therefore depend on either H2 (the
   * inference fallback gap) or a different cache-poisoning path.
   *
   * Kept as a green test so future regressions in the recovery path become
   * visible: if this assertion ever starts failing, the safety net is gone.
   */
  it("[expected: green — H1 refuted in this harness] headless phase recovery restores isPro after empty-browserData headed bootstrap", async () => {
    const { code } = await forkRunner({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "tier-e2e-pass",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
      PERPLEXITY_TEST_AUTO_LOGIN_EMAIL: "h1-witness@mock.test",
      PERPLEXITY_POLL_MS: "200",
    });
    if (code !== 0) throw new Error(`runner setup failed (code ${code}); cannot witness H1`);

    // Default init() — headed phase runs against empty browserData (gets
    // anonymous response from mock → modelsConfig stays null → triggers
    // recovery in loadAccountInfo). Headless phase injects vault cookies and
    // authenticates correctly → isPro:true.
    __resetKeyCache?.();
    const client = new PerplexityClient();
    let observedIsPro;
    let observedAuthenticated;
    try {
      await client.init();
      observedIsPro = client.accountInfo.isPro;
      observedAuthenticated = client.authenticated;
    } finally {
      await client.shutdown?.().catch(() => {});
    }
    expect(observedAuthenticated).toBe(true);
    expect(observedIsPro, "isPro should be true after recovery loadAccountInfo (regression alarm)").toBe(true);
  }, 180_000);
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerplexityClient } from "../src/client.ts";
import { createProfile } from "../src/profiles.js";

// Client lifecycle under multi-window load:
//  - reinit COALESCING: three editor windows re-supplying passphrases produced
//    138 queued reinits in one field log — each a full browser teardown +
//    bootstrap. N requests during an in-flight run must collapse to at most
//    one follow-up, and a newer passphrase must never be dropped.
//  - idle PARKING: the browser (~300-600MB) is closed after idle; the daemon
//    stays; the next call resurrects lazily. Parking must not lie about auth.

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let configDir;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "px-lifecycle-"));
  process.env.PERPLEXITY_CONFIG_DIR = configDir;
  createProfile("default");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(configDir, { recursive: true, force: true });
});

describe("reinit coalescing", () => {
  it("collapses a storm of concurrent reinits into first + one follow-up", async () => {
    const client = new PerplexityClient();
    const calls = [];
    let release;
    const gate = new Promise((r) => (release = r));
    client.reinitUnsafe = vi.fn(async (opts) => {
      calls.push(opts);
      if (calls.length === 1) await gate; // hold the first run open
    });

    const storm = [client.reinit({})];
    await tick();
    for (let i = 0; i < 40; i++) storm.push(client.reinit({}));

    release();
    await Promise.all(storm);

    // 41 requests → the in-flight run + exactly one coalesced follow-up.
    expect(client.reinitUnsafe).toHaveBeenCalledTimes(2);
  });

  it("keeps the NEWEST passphrase — a profile switch must not be dropped", async () => {
    const client = new PerplexityClient();
    const calls = [];
    let release;
    const gate = new Promise((r) => (release = r));
    client.reinitUnsafe = vi.fn(async (opts) => {
      calls.push(opts);
      if (calls.length === 1) await gate;
    });

    const first = client.reinit({});
    await tick();
    const q1 = client.reinit({});
    const q2 = client.reinit({ passphrase: "old-pass" });
    const q3 = client.reinit({ passphrase: "new-pass" });
    const q4 = client.reinit({});

    release();
    await Promise.all([first, q1, q2, q3, q4]);

    expect(calls).toHaveLength(2);
    expect(calls[1].passphrase).toBe("new-pass");
  });

  it("a failing reinit rejects its joiners but does not wedge the next one", async () => {
    const client = new PerplexityClient();
    let call = 0;
    client.reinitUnsafe = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await tick(20);
        throw new Error("cf blocked");
      }
    });

    const first = client.reinit({});
    await tick();
    const joined = client.reinit({});

    await expect(first).rejects.toThrow("cf blocked");
    // The coalesced follow-up runs AFTER the failure and succeeds.
    await expect(joined).resolves.toBeUndefined();
    expect(client.reinitUnsafe).toHaveBeenCalledTimes(2);

    await expect(client.reinit({})).resolves.toBeUndefined();
  });

  it("sequential reinits (no overlap) each run — coalescing only affects storms", async () => {
    const client = new PerplexityClient();
    client.reinitUnsafe = vi.fn(async () => {});
    await client.reinit({});
    await client.reinit({});
    await client.reinit({});
    expect(client.reinitUnsafe).toHaveBeenCalledTimes(3);
  });
});

describe("idle browser parking", () => {
  function fakeBrowserOn(client) {
    const closed = vi.fn(async () => {});
    client.context = { close: closed, browser: () => null };
    client.page = { fake: true };
    client.browser = null;
    return closed;
  }

  it("parks after the idle window: browser closed, auth state PRESERVED", async () => {
    vi.useFakeTimers();
    process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS = "1000";
    try {
      const client = new PerplexityClient();
      const closed = fakeBrowserOn(client);
      client.authenticated = true;
      client.userId = "u-1";

      // An op completes → busy goes idle → the park clock starts.
      await client.getBusyState; // touch nothing; drive via scheduler
      await client["scheduler"].runExclusive("op", async () => {});

      await vi.advanceTimersByTimeAsync(1100);

      expect(closed).toHaveBeenCalledTimes(1);
      expect(client.page).toBeNull();
      expect(client.context).toBeNull();
      // Parking is an optimization, not a logout — the daemon must not start
      // telling users to re-login because we saved them some RAM.
      expect(client.authenticated).toBe(true);
      expect(client.userId).toBe("u-1");
    } finally {
      delete process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS;
    }
  });

  it("new work during the idle window cancels the park", async () => {
    vi.useFakeTimers();
    process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS = "1000";
    try {
      const client = new PerplexityClient();
      const closed = fakeBrowserOn(client);

      await client["scheduler"].runExclusive("op", async () => {});
      await vi.advanceTimersByTimeAsync(600);
      await client["scheduler"].runExclusive("op2", async () => {}); // resets the clock
      await vi.advanceTimersByTimeAsync(600);
      expect(closed).not.toHaveBeenCalled(); // only 600ms idle since op2

      await vi.advanceTimersByTimeAsync(500);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS;
    }
  });

  it("PERPLEXITY_BROWSER_IDLE_PARK_MS=0 disables parking entirely", async () => {
    vi.useFakeTimers();
    process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS = "0";
    try {
      const client = new PerplexityClient();
      const closed = fakeBrowserOn(client);
      await client["scheduler"].runExclusive("op", async () => {});
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(closed).not.toHaveBeenCalled();
    } finally {
      delete process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS;
    }
  });

  it("a parked client resurrects lazily: search() re-inits instead of throwing", async () => {
    process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS = "0"; // manual park below
    try {
      const client = new PerplexityClient();
      fakeBrowserOn(client);
      await client.parkBrowser();
      expect(client.page).toBeNull();

      // init() is monkey-patched to "resurrect" a fake page whose evaluate
      // throws a recognizable marker — proving search got PAST the old
      // "Client not initialized" throw and against a live page again.
      client.init = vi.fn(async () => {
        client.page = {
          evaluate: async () => {
            throw new Error("MARKER: page reached");
          },
          setDefaultTimeout: () => {},
        };
      });

      await expect(client.search({ query: "q" })).rejects.toThrow(/MARKER: page reached/);
      expect(client.init).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS;
    }
  });

  it("park skips itself when work queued up while it waited", async () => {
    process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS = "0";
    try {
      const client = new PerplexityClient();
      const closed = fakeBrowserOn(client);

      let releaseOp;
      const opGate = new Promise((r) => (releaseOp = r));
      const op = client["scheduler"].runExclusive("long", () => opGate);
      await tick();
      const park = client.parkBrowser(); // barrier: waits for the active op
      const queued = client["scheduler"].runExclusive("queued", async () => "ran");

      releaseOp();
      await Promise.all([op, park]);
      expect(await queued).toBe("ran");
      // Work was queued behind the barrier → the park must have stepped aside.
      expect(closed).not.toHaveBeenCalled();
      expect(client.page).not.toBeNull();
    } finally {
      delete process.env.PERPLEXITY_BROWSER_IDLE_PARK_MS;
    }
  });
});

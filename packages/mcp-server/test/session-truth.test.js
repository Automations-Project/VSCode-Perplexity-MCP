import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTierLabel } from "../src/config.ts";
import { computeDaemonAuthReason, buildAccountSnapshot } from "../src/client.ts";
import { createProfile, getProfilePaths } from "../src/profiles.js";

// Session-truth fixes (issue #13 + product review):
//  - perplexity_models hardcoded `authenticated: true` for any populated
//    cache, labelling anonymous accounts "Authenticated".
//  - "not-logged-in" was the catch-all reason even when the vault DID unseal
//    and cookies loaded — telling users to run a login that couldn't help.
//  - perplexity://account/status never registered (no provider was passed).

describe("deriveTierLabel", () => {
  const base = { isPro: false, isMax: false, isEnterprise: false };

  it("subscription flags outrank authenticated", () => {
    expect(deriveTierLabel({ ...base, isMax: true }, false)).toBe("Max");
    expect(deriveTierLabel({ ...base, isPro: true }, false)).toBe("Pro");
    expect(deriveTierLabel({ ...base, isEnterprise: true }, false)).toBe("Enterprise");
  });

  it("falls back to authenticated/anonymous when no flags are set", () => {
    expect(deriveTierLabel(base, true)).toBe("Authenticated");
    expect(deriveTierLabel(base, false)).toBe("Anonymous");
  });
});

describe("computeDaemonAuthReason", () => {
  it("ok when authenticated", () => {
    expect(
      computeDaemonAuthReason({ authenticated: true, vaultLocked: false, hadStoredSession: true }),
    ).toBe("ok");
  });

  it("vault-locked outranks everything else (login cannot fix it)", () => {
    expect(
      computeDaemonAuthReason({ authenticated: false, vaultLocked: true, hadStoredSession: true }),
    ).toBe("vault-locked");
  });

  it("loaded-but-rejected session is auth-check-failed, NOT not-logged-in", () => {
    expect(
      computeDaemonAuthReason({ authenticated: false, vaultLocked: false, hadStoredSession: true }),
    ).toBe("auth-check-failed");
  });

  it("not-logged-in only when there was no stored session at all", () => {
    expect(
      computeDaemonAuthReason({ authenticated: false, vaultLocked: false, hadStoredSession: false }),
    ).toBe("not-logged-in");
  });
});

describe("buildAccountSnapshot (perplexity://account/status)", () => {
  let configDir;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-snapshot-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    delete process.env.PERPLEXITY_PROFILE;
    createProfile("default");
  });

  const writeCache = (info) =>
    writeFileSync(getProfilePaths("default").modelsCache, JSON.stringify(info));

  it("reports no-cache when nothing is on disk", () => {
    expect(buildAccountSnapshot().status).toBe("no-cache");
  });

  it("serves tier/authenticated/userId from the cache", () => {
    writeCache({
      isPro: true,
      isMax: false,
      isEnterprise: false,
      canUseComputer: true,
      modelsConfig: { models: { a: {}, b: {} }, config: [] },
      rateLimits: null,
      authenticated: true,
      userId: "u-123",
    });
    const snap = buildAccountSnapshot();
    expect(snap.tier).toBe("Pro");
    expect(snap.authenticated).toBe(true);
    expect(snap.userId).toBe("u-123");
    expect(snap.modelCount).toBe(2);
  });

  it("degrades a pre-upgrade cache (no authenticated field) to Anonymous, never Authenticated", () => {
    writeCache({
      isPro: false,
      isMax: false,
      isEnterprise: false,
      canUseComputer: false,
      modelsConfig: { models: {}, config: [] },
      rateLimits: null,
    });
    const snap = buildAccountSnapshot();
    expect(snap.tier).toBe("Anonymous");
    expect(snap.authenticated).toBe(false);
  });
});

describe("impit-login-runner endpoint drift (regression, source-level)", () => {
  // The runner spawns real network flows, so it can't be imported in a unit
  // test — but its two historical defects are both visible in the source:
  // hand-rolled /rest/configs/* paths (4 of 5 were wrong) and a local
  // deriveTier reading the unverified `subscription_tier` field.
  it("uses shared endpoints and shared tier derivation", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/impit-login-runner.js", import.meta.url), "utf8");
    expect(src).not.toContain("/rest/configs/");
    expect(src).not.toContain("subscription_tier");
    expect(src).toMatch(/buildRuntimeEndpoints\(ORIGIN\)/);
    expect(src).toMatch(/deriveAccountFlags/);
  });
});

import { describe, it, expect } from "vitest";
import {
  IDE_METADATA,
  MCP_TRANSPORT_DEFAULT,
  MCP_TRANSPORT_IDS,
  type McpTransportId,
} from "../src/constants.js";

describe("MCP_TRANSPORT_IDS", () => {
  it("contains exactly the 4 expected ids", () => {
    expect(MCP_TRANSPORT_IDS.length).toBe(4);
    expect([...MCP_TRANSPORT_IDS]).toEqual([
      "stdio-in-process",
      "stdio-daemon-proxy",
      "http-loopback",
      "http-tunnel",
    ]);
  });

  it("has MCP_TRANSPORT_DEFAULT === 'stdio-daemon-proxy'", () => {
    const expected: McpTransportId = "stdio-daemon-proxy";
    expect(MCP_TRANSPORT_DEFAULT).toBe(expected);
  });
});

describe("IDE_METADATA capabilities matrix", () => {
  const entries = Object.entries(IDE_METADATA);

  it("every entry has a capabilities field", () => {
    for (const [key, meta] of entries) {
      expect(meta.capabilities, `IDE ${key} must define capabilities`).toBeDefined();
    }
  });

  it("no entry has httpOAuthLoopback or httpOAuthTunnel set (still evidence-gated)", () => {
    for (const [key, meta] of entries) {
      expect(
        meta.capabilities.httpOAuthLoopback,
        `IDE ${key} httpOAuthLoopback must be false until evidence lands`
      ).toBe(false);
      expect(
        meta.capabilities.httpOAuthTunnel,
        `IDE ${key} httpOAuthTunnel must be false until evidence lands`
      ).toBe(false);
    }
  });

  it("non-ui-only entries have stdio === true", () => {
    for (const [key, meta] of entries) {
      if (meta.configFormat !== "ui-only") {
        expect(meta.capabilities.stdio, `IDE ${key} (configFormat=${meta.configFormat}) must have stdio=true`).toBe(true);
      }
    }
  });

  it("ui-only entries have stdio === false", () => {
    const uiOnly = entries.filter(([, m]) => m.configFormat === "ui-only");
    // Sanity: the fixture actually contains at least one ui-only entry so the
    // branch above is meaningfully exercised.
    expect(uiOnly.length).toBeGreaterThan(0);
    for (const [key, meta] of uiOnly) {
      expect(meta.capabilities.stdio, `IDE ${key} (ui-only) must have stdio=false`).toBe(false);
    }
  });

  it("every httpBearerLoopback-enabled IDE cites the 2026-04-24 static-bearer smoke evidence", () => {
    const EXPECTED_EVIDENCE =
      "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md";
    const bearerEnabled = entries.filter(
      ([, m]) => m.capabilities.httpBearerLoopback === true
    );
    // Sanity: the v0.8.4 flip should cover at least one IDE.
    expect(bearerEnabled.length).toBeGreaterThan(0);
    for (const [key, meta] of bearerEnabled) {
      const evidence = meta.capabilities.evidence;
      expect(
        evidence,
        `IDE ${key} has httpBearerLoopback: true but no evidence object`
      ).toBeDefined();
      expect(
        evidence?.httpBearerLoopback,
        `IDE ${key} must cite evidence.httpBearerLoopback when the cap is true`
      ).toBe(EXPECTED_EVIDENCE);
    }
  });

  it("any evidence object present is non-empty (no vestigial {} entries)", () => {
    for (const [key, meta] of entries) {
      const evidence = meta.capabilities.evidence;
      if (evidence !== undefined) {
        expect(
          Object.keys(evidence).length,
          `IDE ${key} has an evidence object with no entries`
        ).toBeGreaterThan(0);
      }
    }
  });
});

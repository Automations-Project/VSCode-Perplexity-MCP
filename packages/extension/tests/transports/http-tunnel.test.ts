import { describe, it, expect } from "vitest";
import { httpTunnelBuilder } from "../../src/auto-config/transports/http-tunnel.js";
import { StabilityGateError, type TransportBuildInput } from "../../src/auto-config/transports/index.js";

function baseInput(overrides: Partial<TransportBuildInput> = {}): TransportBuildInput {
  return {
    launcherPath: "C:/fake/launcher.mjs",
    daemonPort: 41234,
    tunnelUrl: "https://mcp.example.com",
    tunnelProviderId: "cf-named",
    tunnelReservedDomain: true,
    bearerKind: "none",
    ...overrides,
  };
}

describe("httpTunnelBuilder metadata", () => {
  it("has id http-tunnel", () => {
    expect(httpTunnelBuilder.id).toBe("http-tunnel");
  });

  it("supports json only", () => {
    expect(httpTunnelBuilder.supportedFormats).toEqual(["json"]);
  });
});

describe("httpTunnelBuilder happy paths", () => {
  it("cf-named: bare URL gets /mcp appended, no headers", () => {
    const out = httpTunnelBuilder.build(
      baseInput({
        tunnelUrl: "https://mcp.example.com",
        tunnelProviderId: "cf-named",
      })
    );
    expect(out).toEqual({ url: "https://mcp.example.com/mcp" });
    // Explicit headers-absence assertion (the crown-jewel invariant).
    expect("headers" in out).toBe(false);
  });

  it("ngrok with reserved domain: URL passed through then normalized, no headers", () => {
    const out = httpTunnelBuilder.build(
      baseInput({
        tunnelUrl: "https://perplexity-user.ngrok.app",
        tunnelProviderId: "ngrok",
        tunnelReservedDomain: true,
      })
    );
    expect(out).toEqual({ url: "https://perplexity-user.ngrok.app/mcp" });
    expect("headers" in out).toBe(false);
  });

  it("URL already ending in /mcp is passed through unchanged", () => {
    const out = httpTunnelBuilder.build(
      baseInput({
        tunnelUrl: "https://mcp.example.com/mcp",
        tunnelProviderId: "cf-named",
      })
    );
    expect(out).toEqual({ url: "https://mcp.example.com/mcp" });
    // Guard against double-suffixing.
    if ("url" in out) {
      expect(out.url).not.toContain("/mcp/mcp");
    }
  });

  it("URL with trailing slash gets trailing slash stripped before /mcp", () => {
    const out = httpTunnelBuilder.build(
      baseInput({
        tunnelUrl: "https://mcp.example.com/",
        tunnelProviderId: "cf-named",
      })
    );
    expect(out).toEqual({ url: "https://mcp.example.com/mcp" });
  });

  it("cf-named ignores tunnelReservedDomain=false (cf-named is always persistent)", () => {
    const out = httpTunnelBuilder.build(
      baseInput({
        tunnelUrl: "https://mcp.example.com",
        tunnelProviderId: "cf-named",
        tunnelReservedDomain: false,
      })
    );
    expect(out).toEqual({ url: "https://mcp.example.com/mcp" });
  });

  it("non-https URL is accepted (scheme enforcement is elsewhere)", () => {
    const out = httpTunnelBuilder.build(
      baseInput({
        tunnelUrl: "http://localhost:1234",
        tunnelProviderId: "cf-named",
      })
    );
    expect(out).toEqual({ url: "http://localhost:1234/mcp" });
  });
});

describe("httpTunnelBuilder stability gate rejections", () => {
  it("throws when tunnelUrl is null", () => {
    const act = () =>
      httpTunnelBuilder.build(
        baseInput({ tunnelUrl: null, tunnelProviderId: "cf-named" })
      );
    expect(act).toThrowError(StabilityGateError);
    try {
      act();
    } catch (err) {
      expect((err as StabilityGateError).reason).toContain("tunnel URL unavailable");
    }
  });

  it("throws when tunnelUrl is empty string", () => {
    const act = () =>
      httpTunnelBuilder.build(
        baseInput({ tunnelUrl: "", tunnelProviderId: "cf-named" })
      );
    expect(act).toThrowError(StabilityGateError);
    try {
      act();
    } catch (err) {
      expect((err as StabilityGateError).reason).toContain("tunnel URL unavailable");
    }
  });

  it("throws when tunnelUrl set but tunnelProviderId is null", () => {
    const act = () =>
      httpTunnelBuilder.build(
        baseInput({
          tunnelUrl: "https://mcp.example.com",
          tunnelProviderId: null,
        })
      );
    expect(act).toThrowError(StabilityGateError);
    try {
      act();
    } catch (err) {
      expect((err as StabilityGateError).reason).toContain("provider unknown");
    }
  });

  it("rejects cf-quick (ephemeral) with mention of cf-quick and ephemeral; never leaks URL in error", () => {
    const secret = "https://random-adjective-noun.trycloudflare.com";
    const act = () =>
      httpTunnelBuilder.build(
        baseInput({
          tunnelUrl: secret,
          tunnelProviderId: "cf-quick",
        })
      );
    expect(act).toThrowError(StabilityGateError);
    try {
      act();
    } catch (err) {
      const sge = err as StabilityGateError;
      expect(sge.reason).toContain("cf-quick");
      expect(sge.reason).toContain("ephemeral");
      // URL must not leak into the error.
      expect(sge.message).not.toContain(secret);
      expect(sge.reason).not.toContain(secret);
    }
  });

  it("rejects ngrok without reserved domain with reason mentioning reserved domain", () => {
    const act = () =>
      httpTunnelBuilder.build(
        baseInput({
          tunnelUrl: "https://random-host.ngrok.io",
          tunnelProviderId: "ngrok",
          tunnelReservedDomain: false,
        })
      );
    expect(act).toThrowError(StabilityGateError);
    try {
      act();
    } catch (err) {
      expect((err as StabilityGateError).reason).toContain("reserved domain");
    }
  });
});

describe("httpTunnelBuilder defense-in-depth: ignores bearerKind=local silently", () => {
  it("bearerKind=local + localToken produces no headers and no bearer leak", () => {
    const localToken = "super-secret-local-token-abc123xyz";
    const out = httpTunnelBuilder.build(
      baseInput({
        tunnelUrl: "https://mcp.example.com",
        tunnelProviderId: "cf-named",
        bearerKind: "local",
        localToken,
      })
    );
    expect(out).toEqual({ url: "https://mcp.example.com/mcp" });
    expect("headers" in out).toBe(false);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain(localToken);
    expect(serialized).not.toContain("Bearer");
  });
});

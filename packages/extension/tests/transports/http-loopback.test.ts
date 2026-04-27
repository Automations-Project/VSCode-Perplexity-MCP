import { describe, expect, it } from "vitest";
import { httpLoopbackBuilder } from "../../src/auto-config/transports/http-loopback.js";
import { StabilityGateError, type TransportBuildInput } from "../../src/auto-config/transports/index.js";

function baseInput(overrides: Partial<TransportBuildInput> = {}): TransportBuildInput {
  return {
    launcherPath: "C:/ignored/launcher.cmd",
    daemonPort: 7765,
    tunnelUrl: null,
    tunnelProviderId: null,
    tunnelReservedDomain: false,
    bearerKind: "none",
    ...overrides,
  };
}

describe("httpLoopbackBuilder — identity", () => {
  it("has id 'http-loopback'", () => {
    expect(httpLoopbackBuilder.id).toBe("http-loopback");
  });

  it("supports json and toml formats", () => {
    expect(httpLoopbackBuilder.supportedFormats).toEqual(["json", "toml"]);
  });
});

describe("httpLoopbackBuilder — OAuth variant (bearerKind 'none')", () => {
  it("produces { url } with no headers on default port", () => {
    const result = httpLoopbackBuilder.build(baseInput({ bearerKind: "none", daemonPort: 7765 }));
    expect(result).toEqual({ url: "http://127.0.0.1:7765/mcp" });
    expect(result).not.toHaveProperty("headers");
  });

  it("ignores a stray localToken when bearerKind is 'none'", () => {
    const result = httpLoopbackBuilder.build(
      baseInput({
        bearerKind: "none",
        daemonPort: 7765,
        localToken: "pplx_local_should-not-appear_xyz",
      }),
    );
    expect(result).toEqual({ url: "http://127.0.0.1:7765/mcp" });
    expect(result).not.toHaveProperty("headers");
  });

  it("accepts the maximum legal port without clamping", () => {
    const result = httpLoopbackBuilder.build(baseInput({ bearerKind: "none", daemonPort: 65535 }));
    expect(result).toEqual({ url: "http://127.0.0.1:65535/mcp" });
  });
});

describe("httpLoopbackBuilder — bearer fallback (bearerKind 'local')", () => {
  it("embeds the local token as Authorization header", () => {
    const result = httpLoopbackBuilder.build(
      baseInput({
        bearerKind: "local",
        daemonPort: 7765,
        localToken: "pplx_local_claude-desktop_abc123def456",
      }),
    );
    expect(result).toEqual({
      url: "http://127.0.0.1:7765/mcp",
      headers: {
        Authorization: "Bearer pplx_local_claude-desktop_abc123def456",
      },
    });
  });

  it("throws TypeError mentioning localToken when token is missing", () => {
    expect(() =>
      httpLoopbackBuilder.build(baseInput({ bearerKind: "local", daemonPort: 7765 })),
    ).toThrow(TypeError);
    expect(() =>
      httpLoopbackBuilder.build(baseInput({ bearerKind: "local", daemonPort: 7765 })),
    ).toThrow(/localToken/);
  });

  it("throws TypeError mentioning localToken when token is empty string", () => {
    expect(() =>
      httpLoopbackBuilder.build(
        baseInput({ bearerKind: "local", daemonPort: 7765, localToken: "" }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      httpLoopbackBuilder.build(
        baseInput({ bearerKind: "local", daemonPort: 7765, localToken: "" }),
      ),
    ).toThrow(/localToken/);
  });
});

describe("httpLoopbackBuilder — stability gate (bad daemonPort)", () => {
  it("throws StabilityGateError when daemonPort is null", () => {
    let thrown: unknown;
    try {
      httpLoopbackBuilder.build(baseInput({ daemonPort: null }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StabilityGateError);
    const gateErr = thrown as StabilityGateError;
    expect(gateErr.transportId).toBe("http-loopback");
    expect(gateErr.reason).toMatch(/daemon port unavailable/);
  });

  it("throws StabilityGateError when daemonPort is 0", () => {
    let thrown: unknown;
    try {
      httpLoopbackBuilder.build(baseInput({ daemonPort: 0 }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StabilityGateError);
    const gateErr = thrown as StabilityGateError;
    expect(gateErr.transportId).toBe("http-loopback");
    expect(gateErr.reason).toMatch(/daemon port unavailable/);
  });

  it("throws StabilityGateError when daemonPort is -1", () => {
    let thrown: unknown;
    try {
      httpLoopbackBuilder.build(baseInput({ daemonPort: -1 }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StabilityGateError);
    const gateErr = thrown as StabilityGateError;
    expect(gateErr.transportId).toBe("http-loopback");
    expect(gateErr.reason).toMatch(/daemon port unavailable/);
  });
});

describe("httpLoopbackBuilder — ignored inputs", () => {
  it("ignores tunnel/provider/launcher/chrome/node inputs", () => {
    const result = httpLoopbackBuilder.build(
      baseInput({
        launcherPath: "C:/custom/launcher.cmd",
        chromePath: "C:/custom/chrome.exe",
        nodePath: "C:/custom/node.exe",
        tunnelUrl: "https://example.trycloudflare.com",
        tunnelProviderId: "cf-named",
        tunnelReservedDomain: true,
        bearerKind: "none",
        daemonPort: 7765,
      }),
    );
    expect(result).toEqual({ url: "http://127.0.0.1:7765/mcp" });
    expect(result).not.toHaveProperty("headers");
  });

  it("ignores a stray staticBearer when bearerKind is 'none'", () => {
    const result = httpLoopbackBuilder.build(
      baseInput({
        bearerKind: "none",
        daemonPort: 7765,
        staticBearer: "daemon-bearer-should-not-appear",
      }),
    );
    expect(result).toEqual({ url: "http://127.0.0.1:7765/mcp" });
    expect(result).not.toHaveProperty("headers");
  });
});

describe("httpLoopbackBuilder — static bearer (bearerKind 'static')", () => {
  it("embeds the daemon's static bearer as Authorization header", () => {
    const result = httpLoopbackBuilder.build(
      baseInput({
        bearerKind: "static",
        daemonPort: 11819,
        staticBearer: "daemon-static-bearer-uuid-v4",
      }),
    );
    expect(result).toEqual({
      url: "http://127.0.0.1:11819/mcp",
      headers: {
        Authorization: "Bearer daemon-static-bearer-uuid-v4",
      },
    });
  });

  it("throws TypeError mentioning staticBearer when bearer is missing", () => {
    expect(() =>
      httpLoopbackBuilder.build(baseInput({ bearerKind: "static", daemonPort: 7765 })),
    ).toThrow(TypeError);
    expect(() =>
      httpLoopbackBuilder.build(baseInput({ bearerKind: "static", daemonPort: 7765 })),
    ).toThrow(/staticBearer/);
  });

  it("throws TypeError mentioning staticBearer when bearer is empty string", () => {
    expect(() =>
      httpLoopbackBuilder.build(
        baseInput({ bearerKind: "static", daemonPort: 7765, staticBearer: "" }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      httpLoopbackBuilder.build(
        baseInput({ bearerKind: "static", daemonPort: 7765, staticBearer: "" }),
      ),
    ).toThrow(/staticBearer/);
  });
});

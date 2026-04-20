import { describe, it, expect } from "vitest";
import { run as runNetworkCheck } from "../../src/checks/network.js";

describe("checks/network", () => {
  it("passes DNS + HTTPS when both succeed", async () => {
    const checks = await runNetworkCheck({
      dnsLookupOverride: async () => ({ address: "1.2.3.4", family: 4 }),
      httpsHeadOverride: async () => ({ statusCode: 200, headers: { server: "nginx" } }),
    });
    expect(checks.find((c) => c.name === "dns").status).toBe("pass");
    expect(checks.find((c) => c.name === "https").status).toBe("pass");
    expect(checks.find((c) => c.name === "cf-challenge").status).toBe("pass");
  });

  it("fails when DNS resolution fails", async () => {
    const checks = await runNetworkCheck({
      dnsLookupOverride: async () => { throw new Error("ENOTFOUND"); },
    });
    expect(checks.find((c) => c.name === "dns").status).toBe("fail");
  });

  it("warns when CF challenge is detected", async () => {
    const checks = await runNetworkCheck({
      dnsLookupOverride: async () => ({ address: "1.2.3.4", family: 4 }),
      httpsHeadOverride: async () => ({ statusCode: 503, headers: { "cf-ray": "abc", server: "cloudflare" } }),
    });
    expect(checks.find((c) => c.name === "cf-challenge").status).toBe("warn");
  });
});

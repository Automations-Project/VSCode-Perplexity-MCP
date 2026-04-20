import { describe, it, expect } from "vitest";
import { runAll, rollupStatus, exitCodeFor } from "../src/doctor.js";

describe("doctor rollup", () => {
  it("fail dominates warn and pass", () => {
    expect(rollupStatus(["pass", "pass"])).toBe("pass");
    expect(rollupStatus(["pass", "warn"])).toBe("warn");
    expect(rollupStatus(["warn", "fail"])).toBe("fail");
    expect(rollupStatus(["skip", "skip"])).toBe("skip");
    expect(rollupStatus(["skip", "pass"])).toBe("pass");
  });

  it("exitCodeFor: 0 on pass/warn/skip, 10 on fail", () => {
    expect(exitCodeFor({ overall: "pass" })).toBe(0);
    expect(exitCodeFor({ overall: "warn" })).toBe(0);
    expect(exitCodeFor({ overall: "skip" })).toBe(0);
    expect(exitCodeFor({ overall: "fail" })).toBe(10);
  });
});

describe("runAll", () => {
  it("returns a DoctorReport with 10 categories (probe skipped by default)", async () => {
    const report = await runAll({
      configDir: process.cwd(),
      probe: false,
      injected: {
        runtime: [{ category: "runtime", name: "node-version", status: "pass", message: "v20" }],
        config: [{ category: "config", name: "config-dir", status: "pass", message: "ok" }],
        profiles: [{ category: "profiles", name: "profile-count", status: "pass", message: "0" }],
        vault: [{ category: "vault", name: "unseal-path", status: "pass", message: "keychain" }],
        browser: [{ category: "browser", name: "chrome-family", status: "pass", message: "/tmp/chrome" }],
        "native-deps": [{ category: "native-deps", name: "patchright", status: "pass", message: "1.x" }],
        network: [{ category: "network", name: "dns", status: "pass", message: "resolved" }],
        ide: [{ category: "ide", name: "ide-audit", status: "skip", message: "-" }],
        mcp: [{ category: "mcp", name: "tool-config", status: "pass", message: "full" }],
      },
    });
    expect(report.overall).toBe("pass");
    expect(Object.keys(report.byCategory)).toEqual([
      "runtime", "config", "profiles", "vault", "browser",
      "native-deps", "network", "ide", "mcp", "probe",
    ]);
    expect(report.probeRan).toBe(false);
    expect(report.byCategory.probe.checks[0].status).toBe("skip");
  });

  it("runs probe when probe:true and sets probeRan:true", async () => {
    const report = await runAll({
      configDir: process.cwd(),
      probe: true,
      injected: {
        probe: [{ category: "probe", name: "probe-search", status: "pass", message: "2 sources" }],
      },
    });
    expect(report.probeRan).toBe(true);
    expect(report.byCategory.probe.status).toBe("pass");
  });
});

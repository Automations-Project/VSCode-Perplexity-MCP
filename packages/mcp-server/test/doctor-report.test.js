import { describe, it, expect } from "vitest";
import {
  buildIssueBody,
  redactIssueBody,
  decideTransport,
  buildIssueUrl,
} from "../src/doctor-report.js";

const fixture = {
  overall: "fail",
  generatedAt: "2026-04-20T00:00:00.000Z",
  durationMs: 123,
  activeProfile: "work",
  probeRan: false,
  byCategory: {
    runtime: { status: "pass", checks: [{ category: "runtime", name: "node-version", status: "pass", message: "v22" }] },
    config: { status: "pass", checks: [] },
    profiles: { status: "pass", checks: [] },
    vault: { status: "pass", checks: [] },
    browser: { status: "fail", checks: [{ category: "browser", name: "chrome-family", status: "fail", message: "not found" }] },
    "native-deps": { status: "pass", checks: [] },
    network: { status: "pass", checks: [] },
    ide: { status: "skip", checks: [] },
    mcp: { status: "pass", checks: [] },
    probe: { status: "skip", checks: [] },
  },
};

describe("doctor-report", () => {
  it("buildIssueBody emits Markdown with all ten categories", () => {
    const md = buildIssueBody({
      report: fixture,
      stderrTail: "nothing here",
      extVersion: "0.4.0",
      nodeVersion: "v22.0.0",
      os: "linux x64",
      activeTier: "Pro",
    });
    expect(md).toMatch(/# Doctor report/);
    expect(md).toMatch(/Overall: \*\*fail\*\*/i);
    expect(md).toMatch(/chrome-family/);
  });

  it("redactIssueBody strips emails, userIds, cookies, and home paths", () => {
    const input = [
      "email: alice@example.com",
      "userId: user_deadbeef01234567",
      "cookie: __Secure-next-auth.session-token=abc.def.ghi",
      "home: /home/alice/.perplexity-mcp",
      "windows: C:\\Users\\bob\\AppData",
      "ip: 192.168.1.42",
    ].join("\n");
    const out = redactIssueBody(input);
    expect(out).not.toMatch(/alice@example\.com/);
    expect(out).not.toMatch(/user_deadbeef/);
    expect(out).not.toMatch(/abc\.def\.ghi/);
    expect(out).not.toMatch(/alice/);
    expect(out).not.toMatch(/bob/);
    expect(out).not.toMatch(/192\.168/);
  });

  it("decideTransport inlines bodies < 6KB and files larger ones", () => {
    expect(decideTransport({ bodyBytes: 1024 })).toBe("inline");
    expect(decideTransport({ bodyBytes: 6 * 1024 + 1 })).toBe("file");
  });

  it("buildIssueUrl produces a GitHub issue URL with template, title, labels, body", () => {
    const url = buildIssueUrl({
      owner: "acme",
      repo: "perplexity-user-mcp",
      category: "browser",
      check: "chrome-family",
      body: "Some **markdown** body",
    });
    expect(url).toMatch(/^https:\/\/github\.com\/acme\/perplexity-user-mcp\/issues\/new/);
    expect(url).toMatch(/template=doctor-report\.yml/);
    expect(url).toMatch(/labels=bug%2Cdoctor%2Cauto-report%2Cbrowser/);
    expect(url).toMatch(/title=/);
    expect(url).toMatch(/body=/);
  });
});

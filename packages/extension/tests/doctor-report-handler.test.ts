import { describe, it, expect, vi } from "vitest";
import { collectDiagnostics, renderPreview, openIssue } from "../src/webview/doctor-report-handler";

describe("doctor-report-handler", () => {
  it("collectDiagnostics strips user PII from stderr tail", () => {
    const report = {
      overall: "fail",
      byCategory: { browser: { status: "fail", checks: [{ category: "browser", name: "chrome-family", status: "fail", message: "not found" }] } },
      generatedAt: "2026-04-20T00:00:00.000Z",
      durationMs: 1,
      activeProfile: "work",
      probeRan: false,
    } as any;
    const out = collectDiagnostics({
      report,
      stderrTail: "email: alice@example.com\nuserId: user_deadbeef01234567\n",
      extVersion: "0.4.0",
      nodeVersion: "v20",
      os: "linux",
      activeTier: "Pro",
    });
    expect(out.bodyBytes).toBeGreaterThan(0);
    expect(out.markdown).not.toMatch(/alice@example\.com/);
    expect(out.markdown).not.toMatch(/user_deadbeef/);
  });

  it("renderPreview returns user's choice", async () => {
    const showInfo = vi.fn(async () => "Copy to clipboard");
    const result = await renderPreview({ markdown: "x", showInformationMessage: showInfo as any });
    expect(result).toBe("Copy to clipboard");
  });

  it("openIssue short-circuits when opt-out is set", async () => {
    const openExternal = vi.fn();
    await openIssue({
      url: "https://github.com/x/y/issues/new",
      optOut: true,
      openExternal: openExternal as any,
    });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

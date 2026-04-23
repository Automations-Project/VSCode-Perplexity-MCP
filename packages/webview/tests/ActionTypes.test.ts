import { describe, it, expect } from "vitest";
import { ACTION_TYPES } from "../src/action-types";

describe("ACTION_TYPES", () => {
  it("includes daemon:bearer:copy so the webview auto-attaches an id", () => {
    expect(ACTION_TYPES.has("daemon:bearer:copy")).toBe(true);
  });

  it("includes daemon:bearer:reveal so the webview auto-attaches an id", () => {
    expect(ACTION_TYPES.has("daemon:bearer:reveal")).toBe(true);
  });

  it("includes daemon:install-cloudflared so the cf-named install button gets an id", () => {
    expect(ACTION_TYPES.has("daemon:install-cloudflared")).toBe(true);
  });

  it("includes daemon:cf-named-login so the webview auto-attaches an id", () => {
    // Phase 8.4 bug: omitted from ACTION_TYPES caused id=undefined in
    // extension-host breadcrumbs; the webview's pending-action slice never
    // cleared because `daemon:cf-named-login:result` had no id to match.
    expect(ACTION_TYPES.has("daemon:cf-named-login")).toBe(true);
  });

  it("includes daemon:cf-named-create so the webview auto-attaches an id", () => {
    expect(ACTION_TYPES.has("daemon:cf-named-create")).toBe(true);
  });

  it("includes daemon:cf-named-list so the webview auto-attaches an id", () => {
    expect(ACTION_TYPES.has("daemon:cf-named-list")).toBe(true);
  });

  it("keeps every pre-0.7.4 action type that used to be generated with an id", () => {
    // Anti-regression: if someone trims this list and drops a known action type,
    // the App-level send() path stops generating ids for it — silent behavior
    // change. Pin the full pre-0.7.4 surface so churn on this file is explicit.
    const expected = [
      "auth:login",
      "configs:generate",
      "configs:remove",
      "rules:sync",
      "rules:remove",
      "models:refresh",
      "speed-boost:install",
      "speed-boost:uninstall",
      "doctor:run",
      "doctor:probe",
      "doctor:export",
      "doctor:report-issue",
      "doctor:action",
      "daemon:status",
      "daemon:rotate-token",
      "daemon:enable-tunnel",
      "daemon:disable-tunnel",
      "history:request-entry",
      "history:open-preview",
      "history:open-rich",
      "history:open-with",
      "history:export",
      "history:pin",
      "history:tag",
      "history:delete",
      "history:rebuild-index",
      "history:cloud-sync",
      "history:cloud-hydrate",
      "viewers:configure",
    ];
    for (const type of expected) {
      expect(ACTION_TYPES.has(type), `missing ${type}`).toBe(true);
    }
  });
});

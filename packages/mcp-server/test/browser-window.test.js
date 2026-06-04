import { describe, it, expect } from "vitest";
import { loginLaunchArgs, OFFSCREEN_POSITION_ARG } from "../src/browser-window.js";

describe("loginLaunchArgs", () => {
  it("returns no positioning args for a local origin (already headless)", () => {
    expect(loginLaunchArgs(true)).toEqual([]);
  });

  it("paints the headed cookie-grab window off-screen for a real origin (issue #9)", () => {
    const args = loginLaunchArgs(false);
    expect(args).toContain(OFFSCREEN_POSITION_ARG);
    expect(OFFSCREEN_POSITION_ARG).toBe("--window-position=-32000,-32000");
  });

  it("keeps --start-minimized as a backstop on platforms that honor it", () => {
    expect(loginLaunchArgs(false)).toContain("--start-minimized");
  });

  it("does not shrink the window to 1x1 — an abnormal viewport is a Cloudflare bot tell", () => {
    expect(loginLaunchArgs(false)).not.toContain("--window-size=1,1");
  });
});

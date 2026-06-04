import { describe, it, expect } from "vitest";
import { buildLaunchOptions } from "../src/client.js";
import { OFFSCREEN_POSITION_ARG } from "../src/browser-window.js";

describe("buildLaunchOptions off-screen positioning (issue #9)", () => {
  it("positions the headed CF-solving bootstrap window off-screen", () => {
    const opts = buildLaunchOptions(false);
    expect(opts.headless).toBe(false);
    expect(opts.args).toContain(OFFSCREEN_POSITION_ARG);
  });

  it("adds no positioning arg to headless launches (there is no window)", () => {
    const opts = buildLaunchOptions(true);
    expect(opts.headless).toBe(true);
    expect(opts.args).not.toContain(OFFSCREEN_POSITION_ARG);
  });
});

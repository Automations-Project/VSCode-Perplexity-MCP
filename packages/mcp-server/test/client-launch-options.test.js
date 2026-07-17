import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildLaunchOptions, resolvePhase2Headless } from "../src/client.js";
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

describe("resolvePhase2Headless (issue #12)", () => {
  const ENV_KEYS = ["PERPLEXITY_PERSISTENT_HEADED", "DISPLAY", "WAYLAND_DISPLAY"];
  let saved;
  let realPlatform;

  const setPlatform = (value) =>
    Object.defineProperty(process, "platform", { value, configurable: true });

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    realPlatform = process.platform;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setPlatform(realPlatform);
  });

  // The headed-offscreen DEFAULT shipped briefly for #12 and was reverted the
  // same day: a long-lived headed window has a taskbar icon and ordinary
  // window-manager events re-place it on-screen — users saw a permanent
  // visible Chrome. Headed is opt-in now.
  it("defaults to headless on every platform (visible-browser regression guard)", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      setPlatform(platform);
      expect(resolvePhase2Headless(false)).toBe(true);
    }
  });

  it("honours PERPLEXITY_HEADLESS_ONLY=1 (servers, airgapped, doctor probe)", () => {
    setPlatform("darwin");
    expect(resolvePhase2Headless(true)).toBe(true);
  });

  it("PERPLEXITY_PERSISTENT_HEADED=1 opts into headed-offscreen (the #12 mitigation)", () => {
    setPlatform("win32");
    process.env.PERPLEXITY_PERSISTENT_HEADED = "1";
    expect(resolvePhase2Headless(false)).toBe(false);
    expect(resolvePhase2Headless(true)).toBe(false); // explicit opt-in beats HEADLESS_ONLY

    setPlatform("linux");
    process.env.DISPLAY = ":0";
    expect(resolvePhase2Headless(false)).toBe(false);
  });

  it("refuses the headed opt-in on display-less Linux — a dead daemon helps nobody", () => {
    setPlatform("linux"); // no DISPLAY/WAYLAND_DISPLAY
    process.env.PERPLEXITY_PERSISTENT_HEADED = "1";
    expect(resolvePhase2Headless(false)).toBe(true);
  });

  it("PERPLEXITY_PERSISTENT_HEADED=0 still forces headless explicitly", () => {
    setPlatform("darwin");
    process.env.PERPLEXITY_PERSISTENT_HEADED = "0";
    expect(resolvePhase2Headless(false)).toBe(true);
  });
});

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

  it("paints headed-offscreen on non-Linux so CF does not re-challenge", () => {
    for (const platform of ["darwin", "win32"]) {
      setPlatform(platform);
      expect(resolvePhase2Headless(false)).toBe(false);
    }
  });

  it("stays headless on Linux with no display, so the daemon still starts", () => {
    setPlatform("linux");
    expect(resolvePhase2Headless(false)).toBe(true);
  });

  it("paints headed-offscreen on Linux when X or Wayland is available", () => {
    setPlatform("linux");
    process.env.DISPLAY = ":0";
    expect(resolvePhase2Headless(false)).toBe(false);

    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = "wayland-0";
    expect(resolvePhase2Headless(false)).toBe(false);
  });

  it("honours PERPLEXITY_HEADLESS_ONLY=1 (servers, airgapped, doctor probe)", () => {
    setPlatform("darwin");
    expect(resolvePhase2Headless(true)).toBe(true);
  });

  it("lets PERPLEXITY_PERSISTENT_HEADED override the inference both ways", () => {
    setPlatform("linux"); // no display: would infer headless
    process.env.PERPLEXITY_PERSISTENT_HEADED = "1";
    expect(resolvePhase2Headless(false)).toBe(false);
    expect(resolvePhase2Headless(true)).toBe(false); // beats HEADLESS_ONLY

    setPlatform("darwin"); // would infer headed
    process.env.PERPLEXITY_PERSISTENT_HEADED = "0";
    expect(resolvePhase2Headless(false)).toBe(true);
  });
});

import type { Page } from "patchright";

/**
 * Minimize the OS window backing a Playwright page via CDP
 * (`Browser.setWindowBounds`). Returns false if the window could not be
 * minimized (no CDP session available). Best-effort; never throws.
 */
export function minimizePageWindow(page: Page): Promise<boolean>;

/**
 * Chromium arg that paints the headed login / cookie-grab window far
 * off-screen (`--window-position=-32000,-32000`) so it never flashes visible
 * (issue #9).
 */
export const OFFSCREEN_POSITION_ARG: string;

/**
 * Chromium launch args for the headed login / cookie-grab window.
 *
 * @param localOrigin true when the login target is a local mock origin
 *   (127.0.0.1 / localhost), which runs headless with no window.
 */
export function loginLaunchArgs(localOrigin: boolean): string[];

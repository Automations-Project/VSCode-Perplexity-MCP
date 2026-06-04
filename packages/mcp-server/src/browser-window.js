// Position the headed cookie-grab window far off-screen.
//
// Issue #9: on macOS `--start-minimized` is not honored before the first
// paint, so the login window flashes visible for ~1-2s before the CDP
// `minimizePageWindow()` call lands. The auto-OTP runner never needs this
// window to be user-visible (the OTP is entered through the extension UI over
// IPC and Cloudflare is auto-solved on a clean IP; a real CF challenge bails
// to the manual runner instead), so we paint it off-screen from the start.
//
// We move the window rather than shrink it (`--window-size=1,1`) or go true
// headless: an abnormal viewport or headless fingerprint is a Cloudflare /
// Turnstile bot tell, and the headed launch is exactly what keeps the
// cookie-grab passing CF. `--start-minimized` is kept as a backstop for
// platforms that do honor it before paint (Windows).
//
// Off-screen is also strictly safer than the CDP `minimizePageWindow()` below
// for CF: an off-screen window still reports `document.visibilityState` as
// "visible" and keeps requestAnimationFrame firing, whereas a minimized window
// reports "hidden" and throttles timers. Do not "optimize" this to a minimize.
export const OFFSCREEN_POSITION_ARG = "--window-position=-32000,-32000";

/**
 * Chromium launch args for the headed login / cookie-grab window.
 *
 * @param {boolean} localOrigin — true when the login target is a local mock
 *   origin (127.0.0.1 / localhost). Those runs are already headless with no
 *   window, so no positioning is needed.
 * @returns {string[]}
 */
export function loginLaunchArgs(localOrigin) {
  if (localOrigin) return [];
  return ["--start-minimized", OFFSCREEN_POSITION_ARG];
}

export async function minimizePageWindow(page) {
  try {
    const context = page?.context?.();
    if (!context || typeof context.newCDPSession !== "function") return false;
    const session = await context.newCDPSession(page);
    try {
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
      return true;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    return false;
  }
}

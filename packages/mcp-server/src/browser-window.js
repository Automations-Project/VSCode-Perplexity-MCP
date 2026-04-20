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

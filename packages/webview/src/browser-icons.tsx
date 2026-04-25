import type React from "react";
import chromeLogo from "../../../mcp-tool-icons/chrome.svg?raw";
import edgeLogo from "../../../mcp-tool-icons/edge.svg?raw";
import chromiumLogo from "../../../mcp-tool-icons/chromium.svg?raw";

/**
 * Brand SVG logos for browser runtime options.
 * Assets come from mcp-tool-icons; rendered via dangerouslySetInnerHTML
 * so complex gradients and foreign-namespaced attributes survive Vite
 * without being stripped by the React JSX transform.
 */

const S = 16;

function BrowserBrandIcon({ svg }: { svg: string }) {
  return <span className="browser-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function createBrowserBrandIcon(svg: string) {
  return function SvgBrowserBrandIcon() {
    return <BrowserBrandIcon svg={svg} />;
  };
}

export const ChromeIcon = createBrowserBrandIcon(chromeLogo);
export const EdgeIcon = createBrowserBrandIcon(edgeLogo);
export const ChromiumIcon = createBrowserBrandIcon(chromiumLogo);

const BROWSER_ICON_MAP: Record<string, () => React.ReactNode> = {
  chrome: ChromeIcon,
  msedge: EdgeIcon,
  chromium: ChromiumIcon,
};

export function getBrowserIcon(channel: string | undefined): () => React.ReactNode {
  return BROWSER_ICON_MAP[channel ?? ""] ?? ChromiumIcon;
}

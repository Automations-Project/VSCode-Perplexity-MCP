import type { ExternalViewer } from "@perplexity-user-mcp/shared";

export declare function listViewers(overrides?: ExternalViewer[]): ExternalViewer[];
export declare function loadViewerConfig(): ExternalViewer[];
export declare function saveViewerConfig(viewer: ExternalViewer): ExternalViewer;
export declare function substituteViewerTemplate(viewer: ExternalViewer, values: Record<string, string>): string;
export declare function ensureObsidianBridge(options: {
  mdPath: string;
  viewer: ExternalViewer;
  profile?: string;
}): string;
export declare function buildViewerUrl(options: {
  viewer: ExternalViewer;
  mdPath: string;
  profile?: string;
}): string;

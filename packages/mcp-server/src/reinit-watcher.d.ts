export interface ReinitWatcher {
  dispose(): void;
}

export interface WatchReinitOptions {
  debounceMs?: number;
}

export function watchReinit(
  profileName: string,
  callback: () => void | Promise<void>,
  opts?: WatchReinitOptions
): ReinitWatcher;

/**
 * Watch the `<configDir>/active` pointer file for profile switches and call
 * `callback` whenever it changes. Pass `configDir = undefined` to use the
 * resolved default config dir (PERPLEXITY_CONFIG_DIR or ~/.perplexity-mcp).
 */
export function watchActiveProfile(
  configDir: string | undefined,
  callback: () => void | Promise<void>,
  opts?: WatchReinitOptions
): ReinitWatcher;

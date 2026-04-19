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

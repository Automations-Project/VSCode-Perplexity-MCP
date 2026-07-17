export function clearStaleSingletonLocks(dir: string): void;

export function isLockContentionError(err: unknown): boolean;

export function launchWithRetry<T>(
  launch: (attempt: number) => Promise<T> | T,
  opts?: {
    retries?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    isRetriable?: (err: unknown) => boolean;
    beforeAttempt?: (attempt: number) => void | Promise<void>;
  },
): Promise<T>;

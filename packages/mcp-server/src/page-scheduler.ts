import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Serializes page-exclusive work on the daemon's single Playwright page.
 *
 * WHY THIS EXISTS
 * ---------------
 * N clients (VS Code windows, Cursor, Claude Desktop, …) attach to ONE daemon
 * holding ONE PerplexityClient with ONE `page` (client.ts). Every browser-backed
 * tool funnels into that one tab. Before this scheduler there was no mutex
 * anywhere in the server: two concurrent `page.evaluate` calls interleaved on a
 * shared execution context, and `computeASI` mutated the page-global
 * `setDefaultTimeout`, so one client's 180s compute had its deadline reset to
 * 30s by another client's finishing call.
 *
 * WHY IT LIVES ON THE CLIENT, NOT THE SERVER
 * ------------------------------------------
 * The `.reinit` sentinel watcher and the active-profile watcher call
 * `client.reinit()` DIRECTLY on the launcher's instance — they never pass
 * through the daemon's `getClient()`. A barrier installed in the server would
 * simply be bypassed by every login and profile switch. The only seam all
 * trigger paths share is the client object itself, so the scheduler hangs off
 * the client and the stdio entrypoint inherits it for free.
 *
 * TWO PRIMITIVES
 * --------------
 * - `runExclusive` — FIFO, one page op at a time. The page is a single tab, so
 *   a concurrency limit above 1 would be meaningless.
 * - `runBarrier` — for reinit/shutdown. Stops dequeue, waits out only the
 *   ACTIVE op, runs, then resumes. It deliberately does NOT drain the whole
 *   queue: a busy daemon would otherwise never get to reinit.
 *
 * Barriers are mutually exclusive with each other, which also fixes the
 * double-reinit interleave (login sentinel + profile-switch watcher firing
 * together) that could put two `launchPersistentContext` calls on one
 * browser-data — the issue #8 deadlock class.
 */

/** Reentrancy depth. A nested acquire inside a held op must pass through. */
const schedulerDepth = new AsyncLocalStorage<number>();

export interface ToolContext {
  tool: string;
  clientId?: string | null;
}

/**
 * Names the MCP tool responsible for the current async call chain.
 *
 * `client.search()` backs four different tools, so the client cannot label its
 * own work. tools.ts wraps each invocation, and the scheduler reads the label
 * when the op reaches the front of the queue — no client signature changes.
 */
const toolContext = new AsyncLocalStorage<ToolContext>();

export function runInToolContext<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  return toolContext.run(ctx, fn);
}

export function currentToolContext(): ToolContext | undefined {
  return toolContext.getStore();
}

export interface PageBusyActive {
  tool: string;
  clientId?: string | null;
  startedAt: string;
}

export interface PageBusyState {
  busy: boolean;
  active: PageBusyActive | null;
  queued: number;
  updatedAt: string;
}

export interface PageSchedulerOptions {
  /**
   * Reject rather than grow without bound. One wedged page op would otherwise
   * let a retrying client accumulate waiters until the daemon runs out of
   * memory.
   */
  maxQueue?: number;
  now?: () => number;
}

/** Thrown when the queue is at capacity. Maps to the `daemon_queue_full` MCP error. */
export class DaemonQueueFullError extends Error {
  readonly code = "daemon_queue_full";
  constructor(depth: number) {
    super(
      `Too many queued Perplexity tool calls (${depth} waiting on the shared browser). Retry shortly.`,
    );
    this.name = "DaemonQueueFullError";
  }
}

interface Waiter<T = unknown> {
  fn: () => Promise<T>;
  label: string;
  // Captured at ENQUEUE time: pump() dequeues from whatever async context
  // happens to release the previous op, where the enqueuer's tool context is
  // long gone.
  clientId: string | null;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export class PageScheduler {
  private queue: Waiter<any>[] = [];
  private active: PageBusyActive | null = null;
  /** Settles when the active op finishes. Barriers await exactly this. */
  private activeSettled: Promise<void> | null = null;
  private barrierActive = false;
  private barrierSettled: Promise<void> | null = null;
  private listeners = new Set<(state: PageBusyState) => void>();
  private readonly maxQueue: number;
  private readonly now: () => number;

  constructor(options: PageSchedulerOptions = {}) {
    this.maxQueue = options.maxQueue ?? 32;
    this.now = options.now ?? Date.now;
  }

  /**
   * Run `fn` with exclusive use of the page. FIFO by arrival.
   *
   * `label` is a fallback only — when an MCP tool drives the call the ambient
   * tool context wins, so the dashboard shows "perplexity_research" rather than
   * the internal method name.
   */
  runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (schedulerDepth.getStore() !== undefined) {
      // Already inside a held slot: a nested acquire on a non-reentrant mutex
      // would deadlock the daemon forever. Pass through.
      return fn();
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new DaemonQueueFullError(this.queue.length));
    }
    const ctx = currentToolContext();
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn,
        label: ctx?.tool ?? label,
        clientId: ctx?.clientId ?? null,
        resolve,
        reject,
      });
      this.emit();
      this.pump();
    });
  }

  /**
   * Run `fn` (reinit/shutdown) with the page quiesced.
   *
   * Fail-open by construction: the `finally` always clears the barrier, so a
   * reinit that throws — a Cloudflare block, a missing browser — can never
   * freeze every client permanently.
   */
  async runBarrier<T>(fn: () => Promise<T>): Promise<T> {
    if (schedulerDepth.getStore() !== undefined) {
      return fn();
    }
    // Barriers are mutually exclusive: two overlapping reinits would race two
    // launchPersistentContext calls onto one browser-data (issue #8).
    while (this.barrierActive && this.barrierSettled) {
      await this.barrierSettled.catch(() => {});
    }
    this.barrierActive = true;
    let release!: () => void;
    this.barrierSettled = new Promise<void>((r) => {
      release = r;
    });
    this.emit();
    try {
      // Wait out ONLY the in-flight op. Queued-but-unstarted work stays queued
      // and resumes against the fresh page.
      const inFlight = this.activeSettled;
      if (inFlight) await inFlight.catch(() => {});
      return await this.withDepth(fn);
    } finally {
      this.barrierActive = false;
      this.barrierSettled = null;
      release();
      this.emit();
      this.pump();
    }
  }

  /** Resolves once no barrier is in progress. Callers awaiting a fresh page use this. */
  async whenReady(): Promise<void> {
    while (this.barrierActive && this.barrierSettled) {
      await this.barrierSettled.catch(() => {});
    }
  }

  getBusyState(): PageBusyState {
    return {
      busy: this.active !== null || this.barrierActive,
      active: this.active,
      queued: this.queue.length,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Subscribe to busy transitions. Returns an unsubscribe fn. */
  onBusyChange(listener: (state: PageBusyState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private withDepth<T>(fn: () => Promise<T>): Promise<T> {
    const depth = (schedulerDepth.getStore() ?? 0) + 1;
    return schedulerDepth.run(depth, fn);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const state = this.getBusyState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A dashboard subscriber must never break the page pipeline.
      }
    }
  }

  private pump(): void {
    if (this.active || this.barrierActive) return;
    const next = this.queue.shift();
    if (!next) return;

    this.active = {
      tool: next.label,
      clientId: next.clientId,
      startedAt: new Date(this.now()).toISOString(),
    };
    this.emit();

    const run = async () => {
      try {
        next.resolve(await this.withDepth(next.fn));
      } catch (err) {
        next.reject(err);
      } finally {
        this.active = null;
        this.activeSettled = null;
        this.emit();
        this.pump();
      }
    };
    this.activeSettled = run();
  }
}

import { describe, it, expect } from "vitest";
import {
  PageScheduler,
  DaemonQueueFullError,
  runInToolContext,
} from "../src/page-scheduler.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Resolvable promise so tests can control exactly when an op finishes. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PageScheduler.runExclusive", () => {
  it("serializes concurrent page ops — no interleaving on the shared page", async () => {
    const s = new PageScheduler();
    const events = [];
    const op = (name, delay) => async () => {
      events.push(`${name}:start`);
      await tick(delay);
      events.push(`${name}:end`);
      return name;
    };

    // B is fast, A is slow: without a mutex B would start before A ends.
    const results = await Promise.all([
      s.runExclusive("a", op("a", 30)),
      s.runExclusive("b", op("b", 1)),
      s.runExclusive("c", op("c", 1)),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("runs strictly FIFO by arrival", async () => {
    const s = new PageScheduler();
    const order = [];
    await Promise.all(
      ["1", "2", "3", "4"].map((n) =>
        s.runExclusive(`op${n}`, async () => {
          order.push(n);
          await tick(1);
        }),
      ),
    );
    expect(order).toEqual(["1", "2", "3", "4"]);
  });

  it("releases the slot when an op throws (no permanent wedge)", async () => {
    const s = new PageScheduler();
    await expect(
      s.runExclusive("boom", async () => {
        throw new Error("page exploded");
      }),
    ).rejects.toThrow("page exploded");

    // The next op must still run — a throwing tool must not pin the page.
    await expect(s.runExclusive("ok", async () => "fine")).resolves.toBe("fine");
    expect(s.getBusyState().busy).toBe(false);
  });

  it("passes through a nested acquire instead of self-deadlocking", async () => {
    const s = new PageScheduler();
    // A public method that internally calls another scheduled method would
    // deadlock on a non-reentrant mutex and take the daemon down forever.
    const result = await s.runExclusive("outer", async () => {
      return s.runExclusive("inner", async () => "nested-ok");
    });
    expect(result).toBe("nested-ok");
  });

  it("rejects with daemon_queue_full past the cap instead of growing unbounded", async () => {
    const s = new PageScheduler({ maxQueue: 2 });
    const blocker = deferred();
    const active = s.runExclusive("blocker", () => blocker.promise);
    await tick();

    const q1 = s.runExclusive("q1", async () => "q1");
    const q2 = s.runExclusive("q2", async () => "q2");
    await expect(s.runExclusive("q3", async () => "q3")).rejects.toBeInstanceOf(
      DaemonQueueFullError,
    );
    await expect(s.runExclusive("q4", async () => "q4")).rejects.toMatchObject({
      code: "daemon_queue_full",
    });

    blocker.resolve("done");
    await Promise.all([active, q1, q2]);
  });
});

describe("PageScheduler.runBarrier (reinit)", () => {
  it("waits for the in-flight op before running — never closes the page mid-evaluate", async () => {
    const s = new PageScheduler();
    const events = [];
    const gate = deferred();

    const op = s.runExclusive("search", async () => {
      events.push("op:start");
      await gate.promise;
      events.push("op:end");
    });

    await tick();
    const barrier = s.runBarrier(async () => {
      events.push("reinit");
    });

    await tick(5);
    // The barrier must NOT have run while the op was in flight.
    expect(events).toEqual(["op:start"]);

    gate.resolve();
    await Promise.all([op, barrier]);
    expect(events).toEqual(["op:start", "op:end", "reinit"]);
  });

  it("does not wait for queued-but-unstarted ops (a busy daemon must still reinit)", async () => {
    const s = new PageScheduler();
    const events = [];
    const gate = deferred();

    const active = s.runExclusive("active", async () => {
      await gate.promise;
      events.push("active:end");
    });
    await tick();
    const queued = s.runExclusive("queued", async () => {
      events.push("queued:ran");
    });
    const barrier = s.runBarrier(async () => {
      events.push("reinit");
    });

    gate.resolve();
    await Promise.all([active, queued, barrier]);
    // reinit jumps the queue: it waits only for the ACTIVE op, then the
    // queued work resumes against the fresh page.
    expect(events).toEqual(["active:end", "reinit", "queued:ran"]);
  });

  it("blocks new ops from starting while a barrier is running", async () => {
    const s = new PageScheduler();
    const events = [];
    const gate = deferred();

    const barrier = s.runBarrier(async () => {
      events.push("reinit:start");
      await gate.promise;
      events.push("reinit:end");
    });
    await tick();
    const op = s.runExclusive("search", async () => {
      events.push("op:ran");
    });

    await tick(5);
    expect(events).toEqual(["reinit:start"]);

    gate.resolve();
    await Promise.all([barrier, op]);
    expect(events).toEqual(["reinit:start", "reinit:end", "op:ran"]);
  });

  it("is mutually exclusive with other barriers (no double launchPersistentContext, issue #8)", async () => {
    const s = new PageScheduler();
    let concurrent = 0;
    let maxConcurrent = 0;
    const reinit = () =>
      s.runBarrier(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await tick(5);
        concurrent -= 1;
      });

    // Login sentinel + profile-switch watcher firing together.
    await Promise.all([reinit(), reinit(), reinit()]);
    expect(maxConcurrent).toBe(1);
  });

  it("fails open — a throwing barrier must not freeze every client forever", async () => {
    const s = new PageScheduler();
    await expect(
      s.runBarrier(async () => {
        throw new Error("cloudflare blocked reinit");
      }),
    ).rejects.toThrow("cloudflare blocked reinit");

    expect(s.getBusyState().busy).toBe(false);
    await expect(s.runExclusive("after", async () => "works")).resolves.toBe("works");
    await expect(s.whenReady()).resolves.toBeUndefined();
  });

  it("whenReady resolves only once the barrier completes", async () => {
    const s = new PageScheduler();
    const gate = deferred();
    let ready = false;

    const barrier = s.runBarrier(async () => {
      await gate.promise;
    });
    await tick();
    const waiter = s.whenReady().then(() => {
      ready = true;
    });

    await tick(5);
    expect(ready).toBe(false);

    gate.resolve();
    await Promise.all([barrier, waiter]);
    expect(ready).toBe(true);
  });
});

describe("PageScheduler busy state", () => {
  it("reports active tool, queue depth, and returns to idle", async () => {
    const s = new PageScheduler();
    const states = [];
    s.onBusyChange((st) => states.push(st));

    const gate = deferred();
    const active = s.runExclusive("search", () => gate.promise);
    await tick();

    const queued = s.runExclusive("research", async () => "q");
    await tick();

    const busy = s.getBusyState();
    expect(busy.busy).toBe(true);
    expect(busy.active?.tool).toBe("search");
    expect(busy.queued).toBe(1);

    gate.resolve();
    await Promise.all([active, queued]);

    const idle = s.getBusyState();
    expect(idle.busy).toBe(false);
    expect(idle.active).toBeNull();
    expect(idle.queued).toBe(0);
    expect(states.length).toBeGreaterThan(0);
  });

  it("labels the op with the MCP tool name and clientId from the ambient context", async () => {
    const s = new PageScheduler();
    const gate = deferred();
    let seen;

    // client.search() backs four tools, so the label must come from the caller.
    const run = runInToolContext({ tool: "perplexity_research", clientId: "cursor-42" }, () =>
      s.runExclusive("search", async () => {
        seen = s.getBusyState().active;
        await gate.promise;
      }),
    );
    await tick();
    gate.resolve();
    await run;

    expect(seen).toMatchObject({ tool: "perplexity_research", clientId: "cursor-42" });
  });

  it("busy stays true across a barrier", async () => {
    const s = new PageScheduler();
    const gate = deferred();
    const barrier = s.runBarrier(() => gate.promise);
    await tick();
    expect(s.getBusyState().busy).toBe(true);
    gate.resolve();
    await barrier;
    expect(s.getBusyState().busy).toBe(false);
  });

  it("a throwing busy listener cannot break the page pipeline", async () => {
    const s = new PageScheduler();
    s.onBusyChange(() => {
      throw new Error("dashboard blew up");
    });
    await expect(s.runExclusive("search", async () => "ok")).resolves.toBe("ok");
  });
});

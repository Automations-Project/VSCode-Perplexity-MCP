import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Cross-process mutual exclusion for a profile's history index.
 *
 * WHY A FILE LOCK AND NOT AN IN-PROCESS QUEUE
 * -------------------------------------------
 * history-store.js is 100% synchronous (no async/await anywhere), so Node's
 * event loop cannot interleave two appends *within* one process — an
 * in-process queue would serialize something that is already serial and fix
 * nothing. Measured: 50 maximally-concurrent in-process appends lose zero
 * entries.
 *
 * The loss is strictly CROSS-process. The daemon, the CLI (`perplexity-user-mcp
 * history …`), a standalone stdio server and the extension host all write the
 * same index.json. Measured with two real processes appending 25 entries each:
 * 50 .md files on disk but only 27-31 rows in the index — the classic lost
 * update, every run. It never self-heals: the index stays valid JSON, just
 * short, so the rebuild-on-corruption path never fires and the entries are
 * invisible until a manual rebuild.
 *
 * WHY SYNCHRONOUS
 * ---------------
 * Every caller is sync (recordToolRun, the dashboard's pin/tag/delete handlers,
 * the CLI). Making this async would force `append` async and ripple through all
 * of them. The critical sections are a few ms of fs work that already blocks
 * the loop today, so a sync lock costs nothing new — but do NOT widen them.
 */

/** Block without spinning the CPU. Atomics.wait needs a SharedArrayBuffer view. */
const parkingLot = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(parkingLot, 0, 0, ms);
}

const DEFAULT_ATTEMPTS = 100;
const DEFAULT_BACKOFF_MS = 5;
/** A lock older than this is presumed abandoned by a crashed writer. */
const STALE_LOCK_MS = 10_000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** True when the holder is gone or the lock is simply too old to be real. */
function isStaleLock(lockPath) {
  try {
    // Age first, and it is the ONLY thing that can condemn a lock we cannot
    // read a pid from. See below.
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > STALE_LOCK_MS) return true;

    const pid = Number.parseInt(String(readFileSync(lockPath, "utf8")).split("\n")[0], 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      // No readable pid on a FRESH lock means a peer is mid-acquire: acquire
      // is openSync(path,"wx") — which creates the file empty — followed by
      // writeFileSync(fd, pid). Reading in that window sees "". Treating that
      // as stale let a peer DELETE a lock that had just been legitimately
      // taken, so both writers proceeded and the index lost an entry — which
      // is precisely the bug this lock exists to prevent, reintroduced under
      // load. Fresh-and-empty is the opposite of stale: back off instead.
      // A writer that dies in that window is still reclaimed by the age
      // check above.
      return false;
    }
    return !isProcessAlive(pid);
  } catch {
    // Vanished mid-check: someone else released it, so it is not stale — the
    // next acquire attempt will just succeed.
    return false;
  }
}

/**
 * Run `fn` holding the profile's index lock. Synchronous in, synchronous out;
 * returns whatever `fn` returns.
 *
 * Reentrant by depth counter — safe precisely because the module is sync, so no
 * interleaving can corrupt the count. Needed because rebuildIndex is reachable
 * from inside loadIndexedEntries, which callers already hold the lock for.
 *
 * @param {string} lockPath
 * @param {() => any} fn
 * @param {{ attempts?: number, backoffMs?: number, openSyncImpl?: typeof openSync }} [opts]
 *   `openSyncImpl` is a test-only seam: the Windows delete-pending EPERM race
 *   cannot be produced deterministically with the real fs.
 */
let depth = 0;
export function withFileLock(lockPath, fn, opts = {}) {
  if (depth > 0) return fn();

  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  let acquired = false;
  let reclaimed = false;

  // The lock's directory may not exist yet — a first-run machine has no
  // ~/.perplexity-mcp/profiles/<name>/history at all, and openSync(…,"wx")
  // fails ENOENT on a missing parent. Callers must not have to remember to
  // create it first (rebuildIndex legitimately creates it *inside* its own
  // locked section). Mirrors atomicWrite in history-store.js.
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // If we cannot create it, the openSync below will fail and be handled
    // by the fail-open path rather than throwing out of a history write.
  }

  const open = opts.openSyncImpl ?? openSync;
  for (let i = 0; i < attempts && !acquired; i++) {
    try {
      const fd = open(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n${Date.now()}`);
      closeSync(fd);
      acquired = true;
    } catch (err) {
      const code = err?.code;
      // EEXIST: held by a peer. EPERM/EACCES/EBUSY: Windows transients — the
      // most important being DELETE-PENDING: a peer's release rmSync is
      // mid-flight, the file still exists but is marked for deletion, and
      // opening it fails EPERM (not EEXIST) until the delete completes.
      // Treating that as fatal crashed the second writer under contention on
      // CI's slower disks (worker died with an unhandled EPERM). All of these
      // mean the same thing: busy — back off and retry. Anything else is a
      // genuine error and propagates.
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
        throw err;
      }
      // Reclaim a lock whose owner died mid-write — but only once, so a
      // pathological loop can never livelock two processes against each other.
      if (code === "EEXIST" && !reclaimed && isStaleLock(lockPath)) {
        reclaimed = true;
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // someone else won the reclaim; fall through and retry
        }
        continue;
      }
      sleepSync(backoffMs);
    }
  }

  if (!acquired) {
    // Deliberately do NOT throw. recordToolRun swallows exceptions, so throwing
    // here would reproduce the exact silent data loss this module exists to
    // prevent. Proceed unlocked (best-effort, still atomic per write) and say
    // so on stderr — stdout is reserved for MCP JSON-RPC framing.
    console.error(
      `[history] index lock busy after ${attempts * backoffMs}ms (${lockPath}); proceeding without it`,
    );
    return fn();
  }

  depth += 1;
  try {
    return fn();
  } finally {
    depth -= 1;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Losing the release would wedge every future writer until the staleness
      // reclaim kicks in — which is exactly why that reclaim exists.
    }
  }
}

/**
 * Active-repo lock — single-active enforcement for the free tier (1 repo).
 *
 * Free accounts run exactly one repo at a time. When no daemon is up, a bare
 * `unerr` standalone proxy must still refuse to serve a second repo while
 * another is live. This global O_EXCL lock at `~/.unerr/state/active-repo.lock`
 * holds the active repo's `{ path, pid }`, so a second standalone boot for a
 * different repo can detect the live holder and refuse.
 *
 * Lock body: `{ path, pid }` JSON.
 * Stale recovery: a holder whose `pid` is no longer alive is free/reclaimable,
 * so a crashed proxy never strands the single slot.
 *
 * The daemon is the source of truth when it is up (it serializes ensure in one
 * process); this file-lock is the daemon-less fallback.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { globalDir } from "./registry.js";

/** The active repo recorded in the lock: which path is serving, under which pid. */
export interface ActiveRepoHolder {
  path: string;
  pid: number;
}

/**
 * The outcome of an acquire attempt: `acquired` on success, otherwise the live
 * holder that blocked it (a different repo whose pid is still alive).
 * @sem domain=security role=type
 */
export type ActiveRepoAcquireResult =
  | { acquired: true }
  | { acquired: false; holder: ActiveRepoHolder };

/**
 * Absolute path of the active-repo lock file under the global state dir.
 * @sem domain=security role=accessor
 */
export function activeRepoLockPath(): string {
  return join(globalDir(), "state", "active-repo.lock");
}

/**
 * Atomically claim the single active-repo slot for `repoPath`. Returns
 * `{ acquired: true }` when the slot was free (or already held by this same
 * repo), otherwise the live holder that owns it. A holder whose pid is dead is
 * reclaimed and the claim retried once; re-acquiring for the same path
 * refreshes the pid.
 * @sem domain=security role=mutation
 */
export function acquireActiveRepoLock(
  repoPath: string
): ActiveRepoAcquireResult {
  mkdirSync(join(globalDir(), "state"), { recursive: true });
  const path = activeRepoLockPath();
  const body = JSON.stringify({ path: repoPath, pid: process.pid });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx"); // O_CREAT | O_EXCL — atomic
      writeFileSync(fd, body);
      closeSync(fd);
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      const holder = readActiveRepoHolder();
      // Same repo re-claiming, or a holder whose pid is gone → reclaim and retry
      // once. A live holder of a different repo blocks the claim.
      if (holder === null || holder.path === repoPath || !isAlive(holder.pid)) {
        if (reclaim(path)) continue;
        return holder
          ? { acquired: false, holder }
          : // Reclaim raced and failed without a readable holder — treat as
            // contended by an unknown live holder rather than silently serving.
            {
              acquired: false,
              holder: { path: repoPath, pid: process.pid },
            };
      }
      return { acquired: false, holder };
    }
  }
  return { acquired: false, holder: { path: repoPath, pid: process.pid } };
}

/**
 * The current active-repo holder, or `null` when the slot is free, the lock is
 * missing/corrupt, or the recorded pid is no longer alive (treated as free).
 * @sem domain=security role=accessor
 */
export function activeRepoHolder(): ActiveRepoHolder | null {
  const holder = readActiveRepoHolder();
  if (holder === null) return null;
  if (!isAlive(holder.pid)) return null;
  return holder;
}

/**
 * Release the active-repo lock. Best-effort — only removes the lock when this
 * process owns it (or it is stale), never another live repo's slot.
 * @sem domain=security role=mutation
 */
export function releaseActiveRepoLock(): void {
  const holder = readActiveRepoHolder();
  if (holder !== null && holder.pid !== process.pid && isAlive(holder.pid)) {
    return; // Owned by another live process — leave it.
  }
  try {
    unlinkSync(activeRepoLockPath());
  } catch {
    // Best-effort — missing file is fine.
  }
}

/** Parse the lock body, returning null on missing or corrupt file. */
function readActiveRepoHolder(): ActiveRepoHolder | null {
  try {
    const parsed = JSON.parse(
      readFileSync(activeRepoLockPath(), "utf8")
    ) as Partial<ActiveRepoHolder>;
    if (typeof parsed.path === "string" && typeof parsed.pid === "number") {
      return { path: parsed.path, pid: parsed.pid };
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove the lock file. Returns true if it is gone afterwards. */
function reclaim(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

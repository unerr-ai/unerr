/**
 * Spawn lock — race-safe single-spawn coordination for the process manager.
 *
 * Multiple `unerr --mcp` bridges may start at the same moment (IDE multi-window
 * or parallel CI runners). Only one of them should spawn `unerrd`; the rest
 * must poll for the supervisor socket to appear. This lock provides that
 * coordination via O_EXCL atomic file creation at `~/.unerr/state/spawn.lock`.
 *
 * Lock body: `{ pid, startedAt }` JSON.
 * Stale recovery: lock older than STALE_LOCK_AGE_MS AND owning PID not alive
 * → reclaim. Handles the case where a bridge died mid-spawn.
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

const STALE_LOCK_AGE_MS = 10_000;

export function spawnLockPath(): string {
  return join(globalDir(), "state", "spawn.lock");
}

/**
 * Attempt to acquire the spawn lock atomically.
 * Returns true if acquired (caller MUST release on completion or error).
 * Returns false if another process holds a fresh lock.
 *
 * If an existing lock is stale (>STALE_LOCK_AGE_MS old AND owning PID not
 * alive), it is reclaimed and acquisition retried once.
 */
export function tryAcquireSpawnLock(): boolean {
  mkdirSync(join(globalDir(), "state"), { recursive: true });
  const path = spawnLockPath();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx"); // O_CREAT | O_EXCL — atomic
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() })
      );
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt === 0 && reclaimIfStale(path)) continue;
      return false;
    }
  }
  return false;
}

/** Release the spawn lock. Best-effort — ignores missing file. */
export function releaseSpawnLock(): void {
  try {
    unlinkSync(spawnLockPath());
  } catch {
    // Best-effort
  }
}

/**
 * Reclaim the lock if it is stale.
 * Returns true if the lock was removed (caller may retry acquisition).
 */
function reclaimIfStale(path: string): boolean {
  let body: { pid: number; startedAt: number } | null = null;
  try {
    body = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Corrupt lock file — reclaim
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }
  if (!body) return false;
  const ageMs = Date.now() - body.startedAt;
  if (ageMs < STALE_LOCK_AGE_MS) return false;
  if (isAlive(body.pid)) return false;
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

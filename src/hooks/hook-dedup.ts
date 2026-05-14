/**
 * File-based dedup for PostToolUse hooks.
 *
 * Hooks are invoked as subprocess spawns by the agent — each call is a fresh
 * Node process with no in-memory state to share. To dedup a recently-emitted
 * reminder for the same (tool, file) pair we persist a tiny timestamp map to
 * `.unerr/state/hook-recent.json` and consult it on each invocation.
 *
 * Failure modes (no .unerr dir, corrupt JSON, write error) all degrade safely:
 * we return true (emit) so the reminder still surfaces. We never throw.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_FILE = join(".unerr", "state", "hook-recent.json");
const DEFAULT_TTL_MS = 30_000;
const PRUNE_FACTOR = 10;

interface RecentMap {
  [key: string]: number;
}

function readMap(file: string): RecentMap {
  try {
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object") return obj as RecentMap;
  } catch {
    // fall through
  }
  return {};
}

function writeMap(file: string, map: RecentMap): void {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(map));
  } catch {
    // best-effort; if we can't persist, next call won't dedup but won't crash
  }
}

function prune(map: RecentMap, now: number, ttlMs: number): RecentMap {
  const cutoff = now - ttlMs * PRUNE_FACTOR;
  const out: RecentMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "number" && v >= cutoff) out[k] = v;
  }
  return out;
}

/**
 * Returns true if the caller should emit the reminder for `key` now, false if
 * it was already emitted within `ttlMs`. On first emission the timestamp is
 * persisted; subsequent calls within TTL return false.
 *
 * @param key  stable identifier — `${tool}:${absPath}` is typical
 * @param ttlMs  dedup window; default 30s
 */
export function shouldEmitOnce(
  key: string,
  ttlMs: number = DEFAULT_TTL_MS,
): boolean {
  const now = Date.now();
  const map = readMap(STATE_FILE);
  const last = map[key];
  if (typeof last === "number" && now - last < ttlMs) {
    return false;
  }
  map[key] = now;
  writeMap(STATE_FILE, prune(map, now, ttlMs));
  return true;
}

/** Test helper — clears the on-disk dedup file. */
export function resetHookDedup(): void {
  try {
    if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}");
  } catch {
    // ignore
  }
}

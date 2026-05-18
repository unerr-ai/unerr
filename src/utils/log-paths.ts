/**
 * Log paths + correlation IDs — single source of truth for the logging layer.
 *
 * Goals:
 *   - One canonical filename per stream (no PID suffixes, no timestamp suffixes).
 *   - One short session ID (`sid`) carried across the spawn lineage via the
 *     `UNERR_SID` env var. Bridge → daemon → per-repo proxy all share it.
 *   - One legacy cleanup pass run at boot to discard pre-redesign artefacts.
 *
 * No backwards-compat shims — pre-release product, direct replacement.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── Session ID ────────────────────────────────────────────────────────

const ENV_VAR = "UNERR_SID";

/**
 * Generate (or reuse) the 6-char hex session ID for this process lineage.
 *
 * - First call in a process reads `UNERR_SID` from the environment. If
 *   present and well-formed, that value is used so spawn lineages stay
 *   correlated. Otherwise generates a fresh ID and assigns it to
 *   `process.env.UNERR_SID` so any child spawned later inherits it.
 * - All subsequent calls in the same process return the same value.
 */
const SID_RE = /^[a-f0-9]{6}$/;
let _sid: string | null = null;
export function getOrCreateSid(): string {
  if (_sid) return _sid;
  const fromEnv = process.env[ENV_VAR];
  if (fromEnv && SID_RE.test(fromEnv)) {
    _sid = fromEnv;
  } else {
    _sid = randomBytes(3).toString("hex");
    process.env[ENV_VAR] = _sid;
  }
  return _sid;
}

/** Read the sid without generating one. Returns null if uninitialised. */
export function peekSid(): string | null {
  return _sid ?? process.env[ENV_VAR] ?? null;
}

// ── Paths ─────────────────────────────────────────────────────────────

/** Per-repo logs directory: `<repo>/.unerr/logs`. */
export function repoLogsDir(repoRoot: string): string {
  return join(repoRoot, ".unerr", "logs");
}

/** Global logs directory: `~/.unerr/logs`. Caller passes the resolved global dir. */
export function globalLogsDir(globalRoot: string): string {
  return join(globalRoot, "logs");
}

/** Canonical per-repo paths. */
export const repoLog = {
  proxy: (repoRoot: string): string => join(repoLogsDir(repoRoot), "proxy.log"),
  bridge: (repoRoot: string): string =>
    join(repoLogsDir(repoRoot), "bridge.log"),
  session: (repoRoot: string): string =>
    join(repoLogsDir(repoRoot), "session.log"),
  events: (repoRoot: string): string =>
    join(repoLogsDir(repoRoot), "events.jsonl"),
};

/** Canonical global paths. */
export const globalLog = {
  unerrd: (globalRoot: string): string =>
    join(globalLogsDir(globalRoot), "unerrd.log"),
  events: (globalRoot: string): string =>
    join(globalLogsDir(globalRoot), "events.jsonl"),
};

// ── Legacy cleanup ────────────────────────────────────────────────────

/**
 * Pre-redesign artefacts that any older proxy / bridge / migration may have
 * left in `.unerr/logs/`. Matched by exact name (`*.bak`, `unerrd.boot.log`)
 * or prefix (`mcp-`, `child-`, `session-2`).
 *
 * Cheap idempotent boot-time sweep — runs every cold start so users who
 * switch branches don't end up with stale files surviving forever.
 */
const LEGACY_PREFIXES = ["mcp-", "child-"];
const LEGACY_EXACT = new Set([
  "unerrd.boot.log",
  "unerr.jsonl",
  "compression.jsonl",
  "file-reads.jsonl",
  "token-flow.jsonl",
]);
const LEGACY_SUFFIXES = [".pre-sqlite.bak"];

function isLegacyTimestampedSession(name: string): boolean {
  // session-2026-05-18-205326.log — distinguish from canonical `session.log`.
  return /^session-\d{4}-\d{2}-\d{2}-\d{6}\.log(?:\.\d+)?$/.test(name);
}

function isLegacyName(name: string): boolean {
  if (LEGACY_EXACT.has(name)) return true;
  if (LEGACY_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (LEGACY_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (isLegacyTimestampedSession(name)) return true;
  return false;
}

/**
 * Sweep legacy log artefacts from `dir`. Best-effort; never throws. Returns
 * the number of files removed (useful for tests + boot reporting).
 *
 * Safe to call on a non-existent directory.
 */
export function cleanupLegacyLogs(dir: string): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!isLegacyName(name)) continue;
      const full = join(dir, name);
      try {
        // Only delete plain files (don't recurse into subdirs).
        if (!statSync(full).isFile()) continue;
        unlinkSync(full);
        removed++;
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* dir disappeared mid-sweep — fine */
  }
  return removed;
}

/** Exposed for tests — same predicate used internally by `cleanupLegacyLogs`. */
export const _internal = { isLegacyName, isLegacyTimestampedSession };

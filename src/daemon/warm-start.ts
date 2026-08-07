/**
 * Warm-start scheduler — optional pre-spawn of MRU repos after daemon boot.
 *
 * OFF by default (`warmStartBudget: 0`) — the daemon is a lazy process manager and
 * spawns nothing proactively on boot; per-repo proxies come up on demand on the
 * first forwarded MCP frame. This module only does work when a user opts in by
 * setting `warmStartBudget` > 0 in ~/.unerr/config.json.
 *
 * When enabled: reads repos from the registry, sorts by lastActivity (MRU first),
 * respects per-repo autostart policy and global budget. Spawns
 * sequentially at low priority. Aborts if load jumps too high or
 * system is on battery.
 *
 * Events emitted for dashboard timeline:
 *   { type: "warm_start", repo, status: "started"|"skipped"|"failed"|"aborted", ms, reason? }
 */

import { type ChildProcess, spawn as cpSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { isCI } from "./detect-ci.js";
import type { ProcessManager } from "./process-manager.js";
import type { RepoEntry } from "./protocol.js";
import { readRegistry } from "./registry.js";
import { loadAverage1, onBattery } from "./system-health.js";

// ── Configuration ─────────────────────────────────────────────

export interface WarmStartConfig {
  warmStartBudget: number;
  warmStartIdleDays: number;
  warmStartDelayMs: number;
}

const DEFAULT_CONFIG: WarmStartConfig = {
  // Disabled by default (0). unerrd is a lazy process manager: on boot it spawns
  // NO per-repo proxy proactively — a proxy is spawned only on demand, when an IDE
  // bridge forwards the first MCP frame for that repo (`pm.ensure`). This keeps
  // repos the user isn't actively driving from running after a daemon restart.
  // Opt back in to MRU pre-warming by setting `warmStartBudget` > 0 in
  // ~/.unerr/config.json; the `warmStartBudget <= 0` gate in runWarmStart then
  // no longer short-circuits.
  warmStartBudget: 0,
  warmStartIdleDays: 14,
  warmStartDelayMs: 30_000,
};

export function loadWarmStartConfig(): WarmStartConfig {
  const configPath = join(homedir(), ".unerr", "config.json");
  try {
    if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    return {
      warmStartBudget:
        typeof raw.warmStartBudget === "number"
          ? raw.warmStartBudget
          : DEFAULT_CONFIG.warmStartBudget,
      warmStartIdleDays:
        typeof raw.warmStartIdleDays === "number"
          ? raw.warmStartIdleDays
          : DEFAULT_CONFIG.warmStartIdleDays,
      warmStartDelayMs:
        typeof raw.warmStartDelayMs === "number"
          ? raw.warmStartDelayMs
          : DEFAULT_CONFIG.warmStartDelayMs,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveWarmStartConfig(partial: Partial<WarmStartConfig>): void {
  const configPath = join(homedir(), ".unerr", "config.json");
  const dir = join(homedir(), ".unerr");
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
    }
  } catch {
    // Corrupted — reset
  }

  const merged = { ...existing, ...partial };
  writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");
}

// ── Warm-start event ──────────────────────────────────────────

export interface WarmStartEvent {
  type: "warm_start";
  repo: string;
  label: string;
  status: "started" | "skipped" | "failed" | "aborted";
  ms: number;
  reason?: string;
}

export type WarmStartEventHandler = (event: WarmStartEvent) => void;

// ── Candidate selection ───────────────────────────────────────

interface WarmCandidate {
  entry: RepoEntry;
  lastActivityTs: number;
}

/**
 * Select repos eligible for warm-start, sorted by MRU.
 * Respects per-repo `autostart` policy and `warmStartIdleDays` cutoff.
 */
export function selectCandidates(
  repos: RepoEntry[],
  config: WarmStartConfig
): {
  candidates: WarmCandidate[];
  skipped: Array<{ entry: RepoEntry; reason: string }>;
} {
  const now = Date.now();
  const idleCutoff = now - config.warmStartIdleDays * 24 * 60 * 60 * 1000;
  const candidates: WarmCandidate[] = [];
  const skipped: Array<{ entry: RepoEntry; reason: string }> = [];

  for (const entry of repos) {
    const autostart = entry.settings?.autostart ?? "auto";

    if (autostart === "never") {
      skipped.push({ entry, reason: "autostart=never" });
      continue;
    }

    if (!existsSync(entry.path)) {
      skipped.push({ entry, reason: "directory not found" });
      continue;
    }

    const lastTs = entry.lastActivity
      ? new Date(entry.lastActivity).getTime()
      : 0;

    if (autostart === "auto" && lastTs < idleCutoff && lastTs > 0) {
      skipped.push({
        entry,
        reason: `inactive >${config.warmStartIdleDays} days`,
      });
      continue;
    }

    candidates.push({ entry, lastActivityTs: lastTs });
  }

  // Eager repos first, then sort by MRU within each tier
  candidates.sort((a, b) => {
    const aEager = a.entry.settings?.autostart === "eager" ? 0 : 1;
    const bEager = b.entry.settings?.autostart === "eager" ? 0 : 1;
    if (aEager !== bEager) return aEager - bEager;
    return b.lastActivityTs - a.lastActivityTs;
  });

  return { candidates, skipped };
}

/**
 * The single most-recently-active repo across `repos`, ranked by
 * `max(lastActivity ?? lastStarted ?? addedAt)`. Returns null for an empty
 * registry.
 */
export function lastActiveRepo(repos: RepoEntry[]): RepoEntry | null {
  let best: RepoEntry | null = null;
  let bestTs = Number.NEGATIVE_INFINITY;
  for (const entry of repos) {
    const stamp = entry.lastActivity ?? entry.lastStarted ?? entry.addedAt;
    const ts = stamp ? new Date(stamp).getTime() : 0;
    if (ts > bestTs) {
      bestTs = ts;
      best = entry;
    }
  }
  return best;
}

// ── Scheduler ─────────────────────────────────────────────────

export interface WarmStartResult {
  started: string[];
  skipped: Array<{ label: string; reason: string }>;
  aborted: boolean;
  totalMs: number;
}

/**
 * Run the warm-start sweep. Called by daemon entrypoint after boot delay.
 *
 * Spawns repos sequentially through ProcessManager.ensure().
 * Aborts if load average jumps >1.5× baseline.
 */
export async function runWarmStart(
  pm: ProcessManager,
  onEvent?: WarmStartEventHandler
): Promise<WarmStartResult> {
  const config = loadWarmStartConfig();
  const result: WarmStartResult = {
    started: [],
    skipped: [],
    aborted: false,
    totalMs: 0,
  };
  const overallStart = Date.now();

  if (config.warmStartBudget <= 0) return result;
  if (isCI()) return result;

  const registry = readRegistry();
  const repos = registry.repos;

  const { candidates, skipped } = selectCandidates(repos, config);

  for (const s of skipped) {
    result.skipped.push({ label: s.entry.label, reason: s.reason });
    onEvent?.({
      type: "warm_start",
      repo: s.entry.path,
      label: s.entry.label,
      status: "skipped",
      ms: 0,
      reason: s.reason,
    });
  }

  const baselineLoad = loadAverage1();
  const toWarm = candidates.slice(0, config.warmStartBudget);

  for (const c of toWarm) {
    // Check system health before each spawn
    if (onBattery()) {
      result.aborted = true;
      onEvent?.({
        type: "warm_start",
        repo: c.entry.path,
        label: c.entry.label,
        status: "aborted",
        ms: 0,
        reason: "on battery",
      });
      break;
    }

    const currentLoad = loadAverage1();
    if (baselineLoad > 0 && currentLoad > baselineLoad * 1.5) {
      result.aborted = true;
      onEvent?.({
        type: "warm_start",
        repo: c.entry.path,
        label: c.entry.label,
        status: "aborted",
        ms: 0,
        reason: `load ${currentLoad.toFixed(1)} > 1.5× baseline ${baselineLoad.toFixed(1)}`,
      });
      break;
    }

    const start = Date.now();
    try {
      await pm.ensure(c.entry.path);
      const ms = Date.now() - start;
      result.started.push(c.entry.label);
      onEvent?.({
        type: "warm_start",
        repo: c.entry.path,
        label: c.entry.label,
        status: "started",
        ms,
      });
    } catch (err) {
      const ms = Date.now() - start;
      onEvent?.({
        type: "warm_start",
        repo: c.entry.path,
        label: c.entry.label,
        status: "failed",
        ms,
        reason: (err as Error).message,
      });
    }
  }

  // Mark remaining candidates beyond budget as skipped
  for (const c of candidates.slice(config.warmStartBudget)) {
    result.skipped.push({ label: c.entry.label, reason: "beyond budget" });
    onEvent?.({
      type: "warm_start",
      repo: c.entry.path,
      label: c.entry.label,
      status: "skipped",
      ms: 0,
      reason: `beyond budget (${config.warmStartBudget})`,
    });
  }

  result.totalMs = Date.now() - overallStart;
  return result;
}

/**
 * Schedule the warm-start sweep after the configured delay.
 * Returns a cancel function.
 */
export function scheduleWarmStart(
  pm: ProcessManager,
  onEvent?: WarmStartEventHandler
): () => void {
  if (isCI()) return () => {};

  const config = loadWarmStartConfig();
  if (config.warmStartBudget <= 0) return () => {};

  const timer = setTimeout(async () => {
    try {
      await runWarmStart(pm, onEvent);
    } catch {
      // Warm-start failure is non-fatal
    }
  }, config.warmStartDelayMs);

  timer.unref();
  return () => clearTimeout(timer);
}

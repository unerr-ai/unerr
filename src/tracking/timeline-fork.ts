/**
 * Timeline Fork — tracks divergence points when rewinds create alternate timelines.
 *
 * When a rewind occurs, the current timeline is "abandoned" and a new one begins.
 * This module persists fork metadata to `.unerr/state/timeline-forks.json`,
 * enabling the system to trace what was tried, why it failed, and what replaced it.
 *
 * Storage format: JSON array of TimelineFork objects, newest first.
 * Active timeline ID: persisted alongside forks, monotonically increasing.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("timeline-fork");

export interface TimelineFork {
  forkPoint: string;
  abandonedBranch: {
    timelineId: number;
    entityChanges: string[];
    promptsTried: string[];
    failureReason?: string;
  };
  newBranch: {
    timelineId: number;
    startedAt: string;
  };
}

interface TimelineForkState {
  activeTimeline: number;
  forks: TimelineFork[];
}

const MAX_FORK_HISTORY = 100;
let inMemoryTimeline = 0;

/**
 * Creates a new timeline fork when a rewind occurs.
 *
 * When called with unerrDir, reads/writes persistent state.
 * When called without unerrDir, uses in-memory counter (for lightweight use).
 */
export function createTimelineFork(
  snapshotId: string,
  abandonedEntities: string[],
  prompts: string[],
  reason?: string,
  unerrDir?: string,
): TimelineFork {
  const state = unerrDir
    ? loadState(unerrDir)
    : { activeTimeline: inMemoryTimeline, forks: [] as TimelineFork[] };
  const now = new Date().toISOString();
  const currentTimeline = state.activeTimeline;
  const nextTimeline = currentTimeline + 1;

  const fork: TimelineFork = {
    forkPoint: snapshotId,
    abandonedBranch: {
      timelineId: currentTimeline,
      entityChanges: deduplicateStrings(abandonedEntities),
      promptsTried: deduplicateStrings(prompts),
      ...(reason ? { failureReason: reason } : {}),
    },
    newBranch: {
      timelineId: nextTimeline,
      startedAt: now,
    },
  };

  state.forks.unshift(fork);
  if (state.forks.length > MAX_FORK_HISTORY) {
    state.forks = state.forks.slice(0, MAX_FORK_HISTORY);
  }

  state.activeTimeline = nextTimeline;

  if (unerrDir) {
    saveState(unerrDir, state);
  } else {
    inMemoryTimeline = nextTimeline;
  }

  log.info(
    `Fork created: timeline ${currentTimeline} → ${nextTimeline} at snapshot ${snapshotId}`,
  );

  return fork;
}

/**
 * Returns the active timeline ID for the repository.
 */
export function getActiveTimeline(unerrDir: string): number {
  const state = loadState(unerrDir);
  return state.activeTimeline;
}

/**
 * Returns the full fork history, newest first.
 */
export function getForkHistory(unerrDir: string): TimelineFork[] {
  const state = loadState(unerrDir);
  return state.forks;
}

/**
 * Returns forks where a specific entity was abandoned.
 */
export function getEntityForkHistory(
  unerrDir: string,
  entityKey: string,
): TimelineFork[] {
  const state = loadState(unerrDir);
  return state.forks.filter((f) =>
    f.abandonedBranch.entityChanges.includes(entityKey),
  );
}

/**
 * Returns the most recent fork, or null if no forks have occurred.
 */
export function getLatestFork(unerrDir: string): TimelineFork | null {
  const state = loadState(unerrDir);
  return state.forks[0] ?? null;
}

/**
 * Returns aggregate statistics about the fork history.
 */
export function getForkStats(unerrDir: string): {
  totalForks: number;
  activeTimeline: number;
  uniqueEntitiesAbandoned: number;
  uniquePromptsAbandoned: number;
  failureReasons: Record<string, number>;
} {
  const state = loadState(unerrDir);
  const entitySet = new Set<string>();
  const promptSet = new Set<string>();
  const reasons: Record<string, number> = {};

  for (const fork of state.forks) {
    for (const entity of fork.abandonedBranch.entityChanges) {
      entitySet.add(entity);
    }
    for (const prompt of fork.abandonedBranch.promptsTried) {
      promptSet.add(prompt);
    }
    if (fork.abandonedBranch.failureReason) {
      const reason = fork.abandonedBranch.failureReason;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }

  return {
    totalForks: state.forks.length,
    activeTimeline: state.activeTimeline,
    uniqueEntitiesAbandoned: entitySet.size,
    uniquePromptsAbandoned: promptSet.size,
    failureReasons: reasons,
  };
}

/**
 * Checks if a fork involved a specific snapshot as its fork point.
 */
export function wasForkPoint(unerrDir: string, snapshotId: string): boolean {
  const state = loadState(unerrDir);
  return state.forks.some((f) => f.forkPoint === snapshotId);
}

/**
 * Returns all prompts tried across abandoned timelines for a given entity.
 * Useful for avoiding repeated failed approaches.
 */
export function getAbandonedPrompts(
  unerrDir: string,
  entityKey: string,
): string[] {
  const state = loadState(unerrDir);
  const prompts = new Set<string>();

  for (const fork of state.forks) {
    if (fork.abandonedBranch.entityChanges.includes(entityKey)) {
      for (const p of fork.abandonedBranch.promptsTried) {
        prompts.add(p);
      }
    }
  }

  return Array.from(prompts);
}

/**
 * Returns the timeline ID at a given fork point, or null if not a fork point.
 */
export function getTimelineAtFork(
  unerrDir: string,
  snapshotId: string,
): { abandoned: number; created: number } | null {
  const state = loadState(unerrDir);
  const fork = state.forks.find((f) => f.forkPoint === snapshotId);
  if (!fork) return null;
  return {
    abandoned: fork.abandonedBranch.timelineId,
    created: fork.newBranch.timelineId,
  };
}

/**
 * Resets the timeline state. Primarily for testing.
 */
export function resetTimelineForks(unerrDir: string): void {
  const defaultState: TimelineForkState = {
    activeTimeline: 0,
    forks: [],
  };
  saveState(unerrDir, defaultState);
  log.info("Timeline fork state reset");
}

/**
 * Compacts the fork history by removing forks older than the given cutoff.
 */
export function compactForkHistory(unerrDir: string, maxAge: number): number {
  const state = loadState(unerrDir);
  const cutoff = Date.now() - maxAge;
  const originalCount = state.forks.length;

  state.forks = state.forks.filter((f) => {
    const forkTs = new Date(f.newBranch.startedAt).getTime();
    return forkTs >= cutoff;
  });

  const removed = originalCount - state.forks.length;
  if (removed > 0) {
    saveState(unerrDir, state);
    log.info(`Compacted ${removed} old forks`);
  }

  return removed;
}

// ── Persistence ─────────────────────────────────────────────────────

function getStatePath(unerrDir: string): string {
  return join(unerrDir, "state", "timeline-forks.json");
}

function ensureStateDir(unerrDir: string): void {
  const stateDir = join(unerrDir, "state");
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

function loadState(unerrDir: string): TimelineForkState {
  const path = getStatePath(unerrDir);
  if (!existsSync(path)) {
    return { activeTimeline: 0, forks: [] };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TimelineForkState>;
    return {
      activeTimeline:
        typeof parsed.activeTimeline === "number" ? parsed.activeTimeline : 0,
      forks: Array.isArray(parsed.forks) ? parsed.forks : [],
    };
  } catch {
    log.warn("Failed to parse timeline-forks.json, starting fresh");
    return { activeTimeline: 0, forks: [] };
  }
}

function saveState(unerrDir: string, state: TimelineForkState): void {
  ensureStateDir(unerrDir);
  const path = getStatePath(unerrDir);
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

function deduplicateStrings(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * Durable, monotonic counter store that survives cloud-drain truncation of
 * proxy.jsonl. Counters accumulate across the lifetime of a repo and are
 * written atomically to avoid partial reads.
 *
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface LifetimeCounters {
  /** MEASURED token savings (real byte/token deltas) — the all-time headline. */
  tokens_saved_total: number;
  hard_prevention_total: number;
  reversible_saved_total: number;
  /** MODELED token savings (round-trip estimates) — kept separate so the
   *  all-time "tokens saved" never folds in an estimate; shown labeled. */
  modeled_saved_total: number;
  updated_at: string;
}

const ZERO: LifetimeCounters = {
  tokens_saved_total: 0,
  hard_prevention_total: 0,
  reversible_saved_total: 0,
  modeled_saved_total: 0,
  updated_at: "",
};

/** Returns the absolute path to the lifetime-counters JSON file. */
export function lifetimeCountersPath(repoRoot: string): string {
  return join(repoRoot, ".unerr", "state", "lifetime-counters.json");
}

function guardNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Reads the counter file. Returns all-zero struct on missing file, parse error, or corrupt fields. */
export function readLifetimeCounters(repoRoot: string): LifetimeCounters {
  try {
    const raw = readFileSync(lifetimeCountersPath(repoRoot), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      tokens_saved_total: guardNum(parsed.tokens_saved_total),
      hard_prevention_total: guardNum(parsed.hard_prevention_total),
      reversible_saved_total: guardNum(parsed.reversible_saved_total),
      modeled_saved_total: guardNum(parsed.modeled_saved_total),
      updated_at:
        typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    };
  } catch {
    return { ...ZERO };
  }
}

/** Writes counters atomically (tmp → rename). Swallows all I/O errors. */
export function writeLifetimeCounters(
  repoRoot: string,
  counters: LifetimeCounters
): void {
  try {
    const path = lifetimeCountersPath(repoRoot);
    const tmp = `${path}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(counters), "utf8");
    renameSync(tmp, path);
  } catch {
    // swallow — telemetry must never throw into the write path
  }
}

/**
 * Adds each provided delta to the current counters and persists atomically.
 * Missing delta fields are treated as 0. Swallows all I/O errors.
 */
export function bumpLifetimeCounters(
  repoRoot: string,
  delta: {
    tokens_saved_total?: number;
    hard_prevention_total?: number;
    reversible_saved_total?: number;
    modeled_saved_total?: number;
  }
): void {
  try {
    const current = readLifetimeCounters(repoRoot);
    const next: LifetimeCounters = {
      tokens_saved_total:
        current.tokens_saved_total + (delta.tokens_saved_total ?? 0),
      hard_prevention_total:
        current.hard_prevention_total + (delta.hard_prevention_total ?? 0),
      reversible_saved_total:
        current.reversible_saved_total + (delta.reversible_saved_total ?? 0),
      modeled_saved_total:
        current.modeled_saved_total + (delta.modeled_saved_total ?? 0),
      updated_at: new Date().toISOString(),
    };
    writeLifetimeCounters(repoRoot, next);
  } catch {
    // swallow
  }
}

/**
 * Seeds the counter file with the provided values only if it does not already
 * exist. Idempotent — never overwrites an accumulated counter.
 */
export function seedLifetimeCountersIfAbsent(
  repoRoot: string,
  seed: () => {
    tokens_saved_total: number;
    hard_prevention_total: number;
    reversible_saved_total: number;
    modeled_saved_total: number;
  }
): void {
  try {
    if (existsSync(lifetimeCountersPath(repoRoot))) {
      return;
    }
    const values = seed();
    const counters: LifetimeCounters = {
      tokens_saved_total: guardNum(values.tokens_saved_total),
      hard_prevention_total: guardNum(values.hard_prevention_total),
      reversible_saved_total: guardNum(values.reversible_saved_total),
      modeled_saved_total: guardNum(values.modeled_saved_total),
      updated_at: new Date().toISOString(),
    };
    writeLifetimeCounters(repoRoot, counters);
  } catch {
    // swallow
  }
}

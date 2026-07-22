/**
 * Graph readiness — the single predicate answering "does this repo have a graph
 * worth steering an agent toward?".
 *
 * unerr's instruction section, navigation hooks, and tool responses all push the
 * agent from built-in Read/Grep/Glob onto graph-backed tools. That push is only
 * honest when a graph exists. Steering at an absent or empty graph is strictly
 * negative: the agent spends turns reaching for tools that return nothing, then
 * falls back to the shell it would have used anyway. A benchmark of that state
 * (agents installed against a repo whose proxy never booted) cost +54.5% versus
 * no unerr at all, with zero graph-tool calls made.
 *
 * Deliberately filesystem-only and synchronous: navigation hooks are short-lived
 * CLI processes that cannot afford to open CozoDB, and they need this answer on
 * every Read/Grep/Glob. The per-repo proxy publishes the counts to
 * `.unerr/state/graph-stats.json` after each index; this module only reads them.
 *
 * @sem domain=intelligence role=policy
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Entity floor for steering. A graph holding only a handful of entities cannot
 * answer "who calls this" or "what does the codebase already do", so pointing an
 * agent at it wastes the same turns an empty graph does. Chosen well below any
 * real project's entity count and well above the stray-file noise a partial or
 * failed index leaves behind.
 */
export const MIN_USEFUL_ENTITIES = 25;

/** Why the graph is (not) ready — diagnostic, and drives the message an agent sees. */
export type GraphReadinessReason =
  | "ready"
  | "no-config"
  | "no-graph"
  | "indexing"
  | "empty";

export interface GraphReadiness {
  /** True only when a graph exists AND carries enough entities to be worth steering toward. */
  ready: boolean;
  /** Entity count as of the last published index; null when never published. */
  entities: number | null;
  reason: GraphReadinessReason;
}

interface PublishedGraphStats {
  entities?: number;
  edges?: number;
  rules?: number;
  indexedAt?: string;
}

/** Path of the counts file the proxy publishes after each index. */
export function graphStatsPath(cwd: string): string {
  return join(cwd, ".unerr", "state", "graph-stats.json");
}

/**
 * Read the readiness of the repo's graph. Never throws — an unreadable or
 * malformed stats file is treated as "indexing", which suppresses steering
 * without claiming the graph is absent.
 */
export function readGraphReadiness(cwd: string): GraphReadiness {
  const unerrDir = join(cwd, ".unerr");

  if (!existsSync(join(unerrDir, "config.json"))) {
    return { ready: false, entities: null, reason: "no-config" };
  }
  if (!existsSync(join(unerrDir, "graph.db"))) {
    return { ready: false, entities: null, reason: "no-graph" };
  }

  let stats: PublishedGraphStats | null = null;
  try {
    stats = JSON.parse(
      readFileSync(graphStatsPath(cwd), "utf-8")
    ) as PublishedGraphStats;
  } catch {
    // Missing or malformed: the graph file exists but no index has published
    // counts yet. Report "indexing" so callers stay quiet rather than assert
    // an absence that may be a few seconds from being false.
    return { ready: false, entities: null, reason: "indexing" };
  }

  const entities = typeof stats?.entities === "number" ? stats.entities : null;
  if (entities === null)
    return { ready: false, entities: null, reason: "indexing" };
  if (entities < MIN_USEFUL_ENTITIES) {
    return { ready: false, entities, reason: "empty" };
  }
  return { ready: true, entities, reason: "ready" };
}

/** Convenience predicate for call sites that only gate on the boolean. */
export function isGraphReady(cwd: string): boolean {
  return readGraphReadiness(cwd).ready;
}

/**
 * Publish index counts for the cheap readers above. Called by the per-repo proxy
 * after an index or graph swap. Best-effort: a failed write leaves readers
 * reporting "indexing", which is the safe direction.
 */
export function publishGraphStats(
  cwd: string,
  stats: { entities: number; edges: number; rules: number },
  now: () => Date = () => new Date()
): boolean {
  try {
    writeFileSync(
      graphStatsPath(cwd),
      `${JSON.stringify({ ...stats, indexedAt: now().toISOString() }, null, 2)}\n`
    );
    return true;
  } catch {
    return false;
  }
}

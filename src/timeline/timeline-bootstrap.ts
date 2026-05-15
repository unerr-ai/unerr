/**
 * Timeline subsystem bootstrap.
 *
 * Wires together the three pieces of the Timeline Layer:
 *   1. CozoTimelineStore (timeline.db)
 *   2. The TurnSegmenter embedded in the active ShadowLedger
 *   3. A turn-close listener that computes a rollup and upserts it into turns
 *
 * Kill-switch: `UNERR_TIMELINE_V2=0` short-circuits everything — no db is
 * opened, no listener attaches, the existing proxy/mcp-server code paths are
 * unaffected. Same is true if startup throws — the bootstrap swallows errors
 * after logging so the host process never crashes on timeline issues.
 *
 * No reads or writes to graph.db / facts.db. No edits to the shadow ledger.
 */

import type { LedgerEntry, ShadowLedger } from "../tracking/shadow-ledger.js";
import type { TurnCloseEvent } from "../tracking/turn-segmenter.js";
import { CozoTimelineStore, type TurnRow } from "./timeline-store.js";

export interface TimelineBootstrapOptions {
  projectRoot: string;
  ledger: ShadowLedger;
  /** Optional logger; defaults to stderr writes prefixed `[unerr:timeline]`. */
  log?: (level: "info" | "warn", msg: string) => void;
  /**
   * UX-2: Lazy resolver for the agent name driving this session. Called once
   * per turn close so late-arriving identity (MCP `initialize` handshake)
   * still gets recorded. Return `undefined` when unknown — the store no-ops.
   */
  getAgentName?: () => string | undefined;
}

export interface TimelineBootstrapHandle {
  store: CozoTimelineStore;
  /** Detaches the turn-close listener and closes the db handle. */
  stop: () => void;
}

const EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "edit_file",
  "write_file",
]);

function defaultLog(level: "info" | "warn", msg: string): void {
  process.stderr.write(`[unerr:timeline] ${level.toUpperCase()}: ${msg}\n`);
}

/**
 * Start the timeline subsystem. Returns null when disabled via env, or when
 * initialisation fails (after logging the error). Callers should treat null
 * as "timeline is off" and continue normally.
 */
export async function startTimelineBootstrap(
  opts: TimelineBootstrapOptions
): Promise<TimelineBootstrapHandle | null> {
  if (process.env.UNERR_TIMELINE_V2 === "0") return null;

  const log = opts.log ?? defaultLog;

  let store: CozoTimelineStore;
  try {
    store = await CozoTimelineStore.create(opts.projectRoot);
  } catch (err) {
    log(
      "warn",
      `init failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const segmenter = opts.ledger.getTurnSegmenter();
  const unsubscribe = segmenter.onTurnClose((event) => {
    const entries = opts.ledger
      .getRecentEntries(100)
      .filter((e) => e.turn_id === event.turn_id);
    const rollup = computeTurnRollup(event, entries);
    store.upsertTurn(rollup).catch((err: unknown) => {
      log(
        "warn",
        `upsertTurn failed for ${rollup.turn_id}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    // ST-4: persist distinct files touched in this turn so the intent stitcher
    // has a file set to Jaccard against.
    const files = collectFilePaths(entries);
    if (files.length > 0) {
      store
        .recordSessionFiles(event.session_id, files)
        .catch((err: unknown) => {
          log(
            "warn",
            `recordSessionFiles failed for ${event.session_id}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    }
    // UX-2: best-effort agent name capture. Lazy resolver so late identity
    // (after MCP `initialize`) still gets recorded.
    const agentName = opts.getAgentName?.();
    if (agentName) {
      store
        .setSessionAgent(event.session_id, agentName)
        .catch((err: unknown) => {
          log(
            "warn",
            `setSessionAgent failed for ${event.session_id}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    }
  });

  log("info", `active (db ${store.dbPath})`);

  return {
    store,
    stop: () => {
      unsubscribe();
      store.close();
    },
  };
}

/**
 * Build a turn rollup from a close event + the entries that belong to it.
 * Exported for testing.
 */
export function computeTurnRollup(
  event: TurnCloseEvent,
  entries: LedgerEntry[]
): TurnRow {
  const tsValues = entries
    .map((e) => Date.parse(e.ts))
    .filter((n) => Number.isFinite(n));
  const started_at =
    tsValues.length > 0 ? Math.min(...tsValues) : event.closed_at;

  const filePaths = new Set<string>();
  let edit_count = 0;
  let intentText: string | undefined;
  const opened_by = entries[0]?.turn_confidence ?? "first_call";

  for (const e of entries) {
    const fp =
      (e.args_summary?.file_path as string | undefined) ??
      (e.args_summary?.path as string | undefined);
    if (typeof fp === "string" && fp.length > 0) filePaths.add(fp);
    if (EDIT_TOOLS.has(e.tool)) edit_count += 1;
    if (
      !intentText &&
      e.tool === "mark_intent" &&
      typeof e.args_summary?.text === "string"
    ) {
      intentText = e.args_summary.text;
    }
  }

  const title = intentText ?? deriveTitleFromFiles(filePaths);

  return {
    turn_id: event.turn_id,
    session_id: event.session_id,
    started_at,
    ended_at: event.closed_at,
    opened_by,
    closed_reason: event.reason,
    tool_count: entries.length,
    file_count: filePaths.size,
    edit_count,
    title,
    outcome: "unknown",
  };
}

/** Extract distinct file paths touched by these entries. */
export function collectFilePaths(entries: LedgerEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    const fp =
      (e.args_summary?.file_path as string | undefined) ??
      (e.args_summary?.path as string | undefined);
    if (typeof fp === "string" && fp.length > 0) set.add(fp);
  }
  return [...set];
}

function deriveTitleFromFiles(paths: Set<string>): string {
  if (paths.size === 0) return "";
  // Pick the shortest path as a rough proxy for "most important file" (entry
  // points, index files, top-level modules tend to be shorter). Cheap heuristic
  // until ST-3 adds a smarter title miner.
  let shortest: string | null = null;
  for (const p of paths) {
    if (shortest === null || p.length < shortest.length) shortest = p;
  }
  if (!shortest) return "";
  const base = shortest.split("/").pop() ?? shortest;
  return base;
}

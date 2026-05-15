/**
 * Sprint 10.3: Timeline View — chronological ledger entries per branch.
 *
 * Provides `unerr_get_timeline` MCP tool: returns ledger entries
 * grouped by branch with timeline branch counter for rewind context.
 *
 * Design authority: Phase 5.5 §1.5 (Timeline View)
 */

import type { LedgerEntry, ShadowLedger } from "./shadow-ledger.js";

/** stderr logger */
const _log = {
  info: (msg: string) => process.stderr.write(`[unerr:timeline] ${msg}\n`),
};

export interface TimelineEntry {
  /** Ledger entry ID */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** MCP tool name */
  tool: string;
  /** Truncated argument summary */
  argsSummary: Record<string, unknown>;
  /** Result summary */
  resultSummary: Record<string, unknown>;
  /** Git branch */
  branch: string;
  /** Git HEAD SHA */
  headSha: string;
  /** Correlation ID (null for root intents) */
  correlationId: string | null;
  /** Commit SHA if associated */
  commitSha?: string;
  /** Prompt context (Sprint 10.4) */
  planSummary?: string;
  changeType?: string;
  featureArea?: string;
}

export interface TimelineResult {
  /** Filtered entries */
  entries: TimelineEntry[];
  /** Current branch */
  branch: string;
  /** Timeline branch counter (incremented on rewind) */
  timelineBranch: number;
  /** Total entry count (before limit) */
  totalCount: number;
  /** Session ID */
  sessionId: string;
}

export interface TimelineOptions {
  /** Filter by branch (default: current branch) */
  branch?: string;
  /** Max entries to return (default: 50) */
  limit?: number;
  /** Filter by tool name */
  tool?: string;
  /** Only return root intents (no correlated entries) */
  rootsOnly?: boolean;
  /** Return entries after this timestamp (ISO) */
  after?: string;
  /** Return entries before this timestamp (ISO) */
  before?: string;
}

/**
 * Build a timeline view from the shadow ledger.
 */
export function getTimeline(
  ledger: ShadowLedger,
  currentBranch: string,
  timelineBranch: number,
  opts: TimelineOptions = {}
): TimelineResult {
  const limit = opts.limit ?? 50;
  const branch = opts.branch ?? currentBranch;

  // Read all entries from buffer (fast path) or file (full history)
  let entries: LedgerEntry[];
  if (limit <= 100) {
    entries = ledger.getRecentEntries(100);
  } else {
    entries = ledger.readAllEntries();
  }

  // Apply filters
  let filtered = entries.filter((e) => e.branch === branch);

  if (opts.tool) {
    filtered = filtered.filter((e) => e.tool === opts.tool);
  }

  if (opts.rootsOnly) {
    filtered = filtered.filter((e) => e.correlation_id === null);
  }

  if (opts.after) {
    const afterMs = new Date(opts.after).getTime();
    filtered = filtered.filter((e) => new Date(e.ts).getTime() > afterMs);
  }

  if (opts.before) {
    const beforeMs = new Date(opts.before).getTime();
    filtered = filtered.filter((e) => new Date(e.ts).getTime() < beforeMs);
  }

  const totalCount = filtered.length;

  // Most recent first, then apply limit
  filtered.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const limited = filtered.slice(0, limit);

  // Map to timeline entries
  const timelineEntries: TimelineEntry[] = limited.map((e) => ({
    id: e.id,
    timestamp: e.ts,
    tool: e.tool,
    argsSummary: e.args_summary,
    resultSummary: e.result_summary,
    branch: e.branch,
    headSha: e.head_sha,
    correlationId: e.correlation_id,
    commitSha: e.commit_sha,
    planSummary: e.plan_summary,
    changeType: e.change_type,
    featureArea: e.feature_area,
  }));

  return {
    entries: timelineEntries,
    branch,
    timelineBranch,
    totalCount,
    sessionId: ledger.getSessionId(),
  };
}

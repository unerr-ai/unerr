/**
 * User-facing cost-economics report for `unerr status` — TERMINAL OUTPUT ONLY.
 *
 * Completes Lever 5 (cache-economics telemetry) and the phase-0 part of
 * Lever 2 (delegation-rate surfacing) from
 * `.internal/roadmap/COST_LEVERS_PLAN.md`. Deliberate deviation from that
 * plan: the numbers here go to the human reading the terminal, never to the
 * agent. The agent cannot act on a cache-hit rate, so paying context tokens
 * for it is pure waste (CLAUDE.md's maximum-cut rule) — and Lever 1 is
 * actively trying to SHRINK the injected surface. Nothing in this module
 * writes a `ur|` line, an MCP `_hint` field, or any Stop-hook injection
 * string. Call `buildCostEconomicsReport` + `renderCostEconomicsReport` only
 * from a CLI command's stderr output path.
 *
 * Fail-soft throughout: a missing session id, a missing/corrupt transcript
 * cache, or a missing event store all degrade to `null` (rendered as one
 * "no session data yet" line) — never throws, never fabricates a zero-row
 * table.
 */

import { readProxySessionId } from "../hooks/prompt-capture.js";
import type { DelegationAgentTier } from "../skills/subagent-manager.js";
import { startupLog } from "../utils/startup-log.js";
import { readBehaviorEvents } from "./behavior-events.js";
import { openMetricsStore } from "./metrics-store.js";
import { delegationTierCounts } from "./savings-events.js";
import {
  computeSessionCacheMetrics,
  weightedInputUnits,
} from "./session-metrics.js";

const TIER_ORDER: DelegationAgentTier[] = [
  "junior",
  "worker",
  "architect",
  "other",
];

export interface CostEconomicsReport {
  /** First 8 chars of the session id — enough to distinguish, short enough
   *  for a terminal line. */
  sessionIdShort: string;
  /** Transcript rows the numbers were summed over. */
  turns: number;
  /** Cache-hit rate as a whole-number percentage. */
  cacheHitRatePct: number;
  /** Re-read amplification (cache_read / cache_create), unrounded. */
  rereadAmplification: number;
  /** Weighted input-token units (1h TTL — subscription main conversation). */
  weightedUnits: number;
  /** Sub-agent runs this session, by tier. */
  delegationCounts: Record<DelegationAgentTier, number>;
  /** Sum of `delegationCounts` across all tiers. */
  delegationTotal: number;
  /** `delegationTotal / (delegationTotal + turns)`, as a whole-number
   *  percentage — a coarse proxy for delegated-vs-main-thread share (no new
   *  collection: reuses the turn count already computed for the cache
   *  section). 0 when both are 0. */
  delegatedSharePct: number;
}

/**
 * Build the report for the most recent session with transcript rows.
 * Resolves the session id from `UNERR_SESSION_ID` or
 * `.unerr/state/session.id` (`readProxySessionId`). Returns `null` when no
 * session id resolves, or that session has no materialized transcript rows
 * yet, or a transcript cache read failed — the caller renders one "no data"
 * line in every one of those cases instead of a fake zero-row table.
 */
export function buildCostEconomicsReport(
  unerrDir: string
): CostEconomicsReport | null {
  try {
    const sessionId = readProxySessionId(unerrDir);
    if (!sessionId) return null;

    const store = openMetricsStore(unerrDir);
    const cache = computeSessionCacheMetrics(store, sessionId);
    if (cache.turns === 0) return null;

    const weightedUnits = Math.round(weightedInputUnits(cache, "1h"));

    const events = readBehaviorEvents(unerrDir, { session_id: sessionId });
    const delegationCounts = delegationTierCounts(events);
    const delegationTotal = TIER_ORDER.reduce(
      (sum, tier) => sum + delegationCounts[tier],
      0
    );
    const shareDenominator = delegationTotal + cache.turns;
    const delegatedSharePct =
      shareDenominator > 0
        ? Math.round((delegationTotal / shareDenominator) * 100)
        : 0;

    return {
      sessionIdShort: sessionId.slice(0, 8),
      turns: cache.turns,
      cacheHitRatePct: Math.round(cache.cache_hit_rate * 100),
      rereadAmplification: cache.reread_amplification,
      weightedUnits,
      delegationCounts,
      delegationTotal,
      delegatedSharePct,
    };
  } catch {
    return null;
  }
}

/**
 * Print the compact terminal section for `unerr status` via `startupLog`
 * (stderr only). Always writes something — a "no session data yet" line
 * when `report` is `null`, so a broken cache never looks like a real
 * zero-row session.
 */
export function renderCostEconomicsReport(
  report: CostEconomicsReport | null
): void {
  startupLog.blank();
  if (!report) {
    startupLog.detail("Cost economics: no session data yet.");
    return;
  }

  startupLog.insight(`Cost economics — session ${report.sessionIdShort}`);
  startupLog.metric("cache-hit rate", `${report.cacheHitRatePct}%`);
  startupLog.metric(
    "re-read amplification",
    `${report.rereadAmplification.toFixed(1)}x`
  );
  startupLog.metric(
    "weighted input",
    report.weightedUnits.toLocaleString(),
    "units"
  );
  startupLog.metric("turns", report.turns);

  const tierParts: string[] = [];
  for (const tier of TIER_ORDER) {
    const n = report.delegationCounts[tier];
    if (n > 0) tierParts.push(`${n} ${tier}`);
  }
  const delegationValue =
    report.delegationTotal === 0
      ? "0 sub-agent runs"
      : `${report.delegationTotal} sub-agent run${report.delegationTotal === 1 ? "" : "s"} (${tierParts.join(", ")}) — ${report.delegatedSharePct}% of turns delegated`;
  startupLog.metric("delegation", delegationValue);

  startupLog.detail(
    "High re-read amplification means content is resent each turn — delegation and dedup lower it."
  );
}

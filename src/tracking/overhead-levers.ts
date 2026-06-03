/**
 * Token-overhead levers aggregator — Sprint 5 (T5.3).
 *
 * The dashboard cannot see the LLM client's billing (`cache_read` /
 * `cache_write`); those live in the agent transcript and are proven offline by
 * `scripts/measure-token-baseline.mjs` against the frozen corpus
 * (`.internal/research/benchmark-corpus.md`). What unerr CAN see server-side is
 * whether the token-overhead LEVERS are firing:
 *
 *   - how often `unerr recon` collapsed the discovery fan-out into one call (R1),
 *   - the task-size mix the footprint router self-selected (R5),
 *   - how often the verbose hook banners were suppressed after their
 *     once-per-session emission (R4).
 *
 * This module aggregates those signals from `.unerr/logs/events.jsonl` for an
 * ADDITIVE dashboard card — it never replaces the byte-savings token-flow panel.
 * Pure + I/O split: `summarizeOverheadLevers(events)` is a pure reducer;
 * `readOverheadLeverEvents(eventsPath)` is the thin file reader.
 */

import { readFileSync } from "node:fs";

export type LeverTaskSize = "trivial" | "single_entity" | "large_sweep";

/** The telemetry `msg` values this aggregator consumes. */
export const RECON_LEVER_MSG = "recon_cli_served";
export const CEREMONY_LEVER_MSG = "ceremony_suppressed";

/** A parsed events.jsonl row narrowed to the lever events (extra keys allowed). */
export type LeverEvent = Record<string, unknown> & { msg: string };

export interface OverheadLeversSummary {
  recon: {
    /** Number of `unerr recon` invocations (each replaces a ~5-call fan-out). */
    count: number;
    avg_sections: number;
    avg_tokens: number;
    /** % of recon runs that emitted the flat large-sweep digest. */
    pct_digest: number;
    /** % of recon runs the router classified as a large sweep. */
    pct_large_sweep: number;
    /** task_size → count (trivial / single_entity / large_sweep / unknown). */
    by_task_size: Record<string, number>;
  };
  ceremony: {
    /** Verbose banners served in terse form after their first full emission. */
    suppressed_count: number;
    /** banner key → suppression count. */
    by_banner: Record<string, number>;
  };
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Reduce lever events to dashboard-ready counters. Order-independent and
 * tolerant of missing fields — an event with no `task_size` lands in `unknown`,
 * a recon row with no `sections` simply doesn't contribute to the average.
 */
export function summarizeOverheadLevers(
  events: LeverEvent[]
): OverheadLeversSummary {
  let reconCount = 0;
  let sectionsSum = 0;
  let tokensSum = 0;
  let digestCount = 0;
  let largeSweepCount = 0;
  const byTaskSize: Record<string, number> = {};

  let suppressed = 0;
  const byBanner: Record<string, number> = {};

  for (const e of events) {
    if (e.msg === RECON_LEVER_MSG) {
      reconCount++;
      const sections = asNumber(e.sections);
      if (sections !== null) sectionsSum += sections;
      const tokens = asNumber(e.tokens);
      if (tokens !== null) tokensSum += tokens;
      if (e.digest === true) digestCount++;
      const size = typeof e.task_size === "string" ? e.task_size : "unknown";
      byTaskSize[size] = (byTaskSize[size] ?? 0) + 1;
      if (size === "large_sweep") largeSweepCount++;
    } else if (e.msg === CEREMONY_LEVER_MSG) {
      suppressed++;
      const banner = typeof e.banner === "string" ? e.banner : "unknown";
      byBanner[banner] = (byBanner[banner] ?? 0) + 1;
    }
  }

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

  return {
    recon: {
      count: reconCount,
      avg_sections:
        reconCount > 0 ? Math.round((sectionsSum / reconCount) * 10) / 10 : 0,
      avg_tokens: reconCount > 0 ? Math.round(tokensSum / reconCount) : 0,
      pct_digest: pct(digestCount, reconCount),
      pct_large_sweep: pct(largeSweepCount, reconCount),
      by_task_size: byTaskSize,
    },
    ceremony: {
      suppressed_count: suppressed,
      by_banner: byBanner,
    },
  };
}

/**
 * Read lever events from a `.unerr/logs/events.jsonl` file. Skips malformed
 * lines and the mirrored `level:"step"` rows (whose `msg` is prefixed with
 * `[pid:N]`, so the exact-match filter excludes them). Returns [] if the file
 * is absent — a fresh repo has fired no levers yet.
 */
export function readOverheadLeverEvents(eventsPath: string): LeverEvent[] {
  let raw: string;
  try {
    raw = readFileSync(eventsPath, "utf8");
  } catch {
    return [];
  }
  const out: LeverEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.msg === RECON_LEVER_MSG || obj.msg === CEREMONY_LEVER_MSG) {
      out.push(obj as LeverEvent);
    }
  }
  return out;
}

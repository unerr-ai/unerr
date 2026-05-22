/**
 * Surface 4a — Attribution panel (Phase 2 Sprint 7).
 *
 * Renders provenance for facts and named events surfaced this turn. The
 * fourth surface in the perception-to-presence model is where the user
 * sees *who said what, when*. For user_fed facts that means quoting the
 * verbatim user phrase that produced the capture; for auto-detected
 * conventions it means naming the detector and the moment it fired.
 *
 * Pure renderer. Inputs are immutable. No IO, no module-level state,
 * deterministic output. Live wrappers belong in a separate file (`*-live.ts`)
 * if needed — this module stays unit-testable in isolation.
 */

import type { NamedEvent } from "../tracking/named-events.js";

export interface FactProvenance {
  fact_id: string;
  /** Fact's short content (≤ 80 chars on display). */
  content: string;
  /** "user_fed", "agent_explicit", "convention_detector", … */
  source: string;
  /** When the fact was first stored. ISO string. */
  created_at: string;
  /** Verbatim user phrase (user_fed only). */
  source_quote?: string;
  /** Display name of the user / agent / detector that produced this. */
  attributed_to?: string;
  /** Subject the fact governs. */
  subject?: string;
  /** Scope the fact applies to (file path, entity key, or "project"). */
  scope?: string;
}

export interface AttributionRow {
  /** Short head — what surfaced. */
  head: string;
  /** Detail — verbatim quote or detector name. */
  detail: string;
  /** Where it applies. */
  where: string;
  /** When it was produced (ISO or relative). */
  when: string;
}

const MAX_HEAD = 80;
const MAX_DETAIL = 120;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function attributedFor(source: string, fallback?: string): string {
  switch (source) {
    case "user_fed":
      return fallback ?? "user";
    case "agent_explicit":
      return fallback ?? "agent";
    case "convention_detector":
      return "convention detector";
    case "negative_knowledge":
      return "negative-knowledge detector";
    case "causal_bridge":
      return "causal-bridge detector";
    case "session_analysis":
      return "session analyser";
    default:
      return fallback ?? source;
  }
}

/**
 * Render an attribution row for one fact. Pure, deterministic.
 *
 * For user_fed facts the detail is the verbatim source_quote so the user
 * sees the exact statement that produced the capture. For auto-detected
 * facts the detail names the detector.
 */
export function renderFactAttribution(fact: FactProvenance): AttributionRow {
  const who = attributedFor(fact.source, fact.attributed_to);
  const head = truncate(`${who} → "${fact.content}"`, MAX_HEAD);
  const detail =
    fact.source === "user_fed" && fact.source_quote
      ? `said: "${truncate(fact.source_quote, MAX_DETAIL - 8)}"`
      : `via ${who}`;
  const where = fact.scope ? `scope: ${fact.scope}` : "";
  const when = fact.created_at;
  return { head, detail, where, when };
}

/**
 * Filter named events to those carrying attribution-worthy provenance.
 * Right now: any `fact_stored_*` or `fact_recalled` event.
 */
export function eventsWithAttribution(events: NamedEvent[]): NamedEvent[] {
  const KINDS = new Set([
    "fact_stored_user_fed",
    "fact_stored_auto",
    "fact_recalled",
    "convention_applied",
  ]);
  return events.filter((e) => KINDS.has(e.event_type));
}

/**
 * Render the attribution block: one line per provenance row, prefixed
 * with the `attribution:` head. Empty input returns an empty string so
 * the caller can decide whether to render the block at all.
 */
export function renderAttributionBlock(
  rows: readonly AttributionRow[]
): string[] {
  if (rows.length === 0) return [];
  const out: string[] = [];
  for (const r of rows) {
    const tail = [r.detail, r.where].filter((x) => x.length > 0).join(" · ");
    out.push(`attribution: ${r.head} — ${tail}`);
  }
  return out;
}

/**
 * Single-shot helper: take a list of fact provenances and produce the
 * lines for the block. Equivalent to `renderAttributionBlock(rows.map(renderFactAttribution))`.
 */
export function renderFactAttributionBlock(
  facts: readonly FactProvenance[]
): string[] {
  return renderAttributionBlock(facts.map(renderFactAttribution));
}

/**
 * Receipt block renderer — the end-of-turn "show your work" narrative.
 *
 * Pure function. Composes the multi-line end-of-turn receipt the user sees
 * in chat. The redesign (May 2026) moves the block from COUNTS ("applied 2
 * rules · joined 3 nodes") to CONCRETE NOUNS: the headline carries the exact
 * per-turn token number + headroom, and each bullet names the actual file
 * skipped, command compressed, rule recalled, entity looked up, or cross-tier
 * join made this turn. The aim is a single surprising specific — "skipped
 * reading proxy.ts (4,311 lines)" — not a row of vanity metrics.
 *
 * Layout (variable height, 1-5 lines):
 *   1     headline:  `unerr » this turn: saved 74,632 tokens (≈37 turns of headroom kept open)`
 *   2-4   bullets:   `  ◆ skipped reading proxy.ts (4,311 lines) — served the outline instead  (+38,566)`
 *   last  footer:    `  · 258k saved this session · +2 more`
 *
 * Bullets are ranked by DIFFERENTIATION, not raw token count (the headline
 * already carries the token number). Priority tiers, highest first:
 * prevention/interjection (blocked a call, caught a stale edit, broke a loop)
 * → recalled/captured rules → drift → large file-read gated →
 * commodity compressions (shell, graph lookups). Within a tier, the largest
 * saver leads. Trivial shell compressions (< SHELL_BULLET_MIN_SAVED) are
 * suppressed entirely. Capped at 3 with a `+N more` overflow tail.
 *
 * Quiet turns (no token savings AND no nameable intervention) fall through
 * to the legacy single-line `fallbackLine`, preserving the pre-redesign UX.
 *
 * Per-turn integers are EXACT (instrumentation-trust convention on
 * turn-footer.ts); the session number rounds via formatTokens so the tail
 * stays compact. Deterministic, no IO, no module-level state.
 */

import {
  type NamedEvent,
  eventBucket,
  isHardPrevention,
} from "../tracking/named-events.js";
import type { RuntimeJoinCounts } from "../tracking/runtime-joins.js";
import type {
  AttributionDrift,
  AttributionRecall,
  ReceiptAttribution,
} from "./receipt-attribution.js";

const BULLET = "◆";
/** 2-space indent — markdown-safe (4+ spaces would render as a code block
 *  when the agent pastes the line) and aligns under the headline. */
const BULLET_INDENT = "  ";
const MAX_BULLETS = 3;
const MAX_CMD_CHARS = 48;

/**
 * Bullet priority tiers (lower wins a scarce slot first). The headline always
 * carries the raw token number, so the bullets are free to lead with what is
 * DIFFERENTIATED about unerr rather than the largest commodity compression.
 *
 * Order rationale (most → least unique):
 *   PREVENTION — unerr actively stopped a mistake (blocked/warned a call,
 *                caught a stale edit, guarded a cascade, broke a retry loop).
 *                Rarest + highest stakes; nothing else does this.
 *   JOURNAL    — a dated past incident resurfaced (trace recall) + session
 *                markers. Core unerr value.
 *   DRIFT      — stale-code drift caught and applied.
 *   FILE_READ  — gated a large file read. A real saver and a concrete
 *                surprise ("skipped 4,311 lines"), so it outranks commodity.
 *   COMMODITY  — shell-output compression and graph lookups. Useful but not
 *                differentiated; any tool does these. Deprioritised so they
 *                fill slots only when nothing rarer fired.
 */
const PRIORITY = {
  PREVENTION: 0,
  JOURNAL: 2,
  DRIFT: 3,
  FILE_READ: 4,
  COMMODITY: 5,
} as const;

/**
 * Noise floor for the shell-compression bullet. A compression that saved
 * fewer than this many tokens (e.g. a `cd … && echo` worth +78) is commodity
 * noise — it never earns a scarce bullet slot. The session/turn token totals
 * in the headline still account for it; we just don't narrate it.
 */
const SHELL_BULLET_MIN_SAVED = 200;

export interface ReceiptBlockInputs {
  attribution: ReceiptAttribution;
  runtimeJoins: RuntimeJoinCounts;
  /** MEASURED tokens saved during the current turn (token_flow_events sum,
   *  modeled mechanisms excluded). This is the only number the headline claims. */
  turnTokensSaved: number;
  /** MODELED tokens saved this turn (context_bundle round-trip estimates). Kept
   *  out of the headline; surfaced on its own "(modeled)" bullet + footer note
   *  so an estimate never reads as a measured saving. 0 → omitted. */
  turnModeledSaved?: number;
  /** MEASURED tokens saved across the session so far. */
  sessionTokensSaved: number;
  /** MODELED tokens saved across the session so far — separate recap row. */
  sessionModeledSaved?: number;
  /** Compounded turns of headroom the session has banked — surfaced in
   *  the headline so the saved number lands in an emotionally legible unit
   *  ("≈37 turns of chat room kept open"). */
  sessionHeadroom: number;
  /** NamedEvents of the CURRENT TURN only — the source of the concrete
   *  WHERE bullets (file skipped, shell compressed, code looked up). Must
   *  already be sliced to the conversational turn by the caller. */
  turnEvents: readonly NamedEvent[];
  /**
   * Legacy single-line receipt produced by `renderSessionEconomyLineLive`.
   * Returned untouched on quiet turns (no savings, no nameable
   * intervention) — preserves the pre-redesign UX when nothing fired.
   */
  fallbackLine: string;
  /** When true (a recap turn — `currentTurn % RECAP_EVERY_N_TURNS === 0` or a
   *  quiet turn, decided in `turn-report.ts`), append the session recap block
   *  (Prevented / Remembered / Saved across the whole session). The recap is
   *  folded into the per-turn line periodically because there is no reliable
   *  user-visible session-end signal across agents. */
  recapTurn?: boolean;
  /** Whole-session event tally (count desc) — source of the recap buckets.
   *  Ignored when `recapTurn` is false. */
  sessionHighlights?: readonly ReportHighlight[];
  /** Lifetime (cross-session, per-repo) anchors. When present, the recap shows
   *  an All-time line; omitted → no All-time line (honest-zero). */
  lifetime?: {
    prevented?: number;
    tokensSaved?: number;
    /** Lifetime MODELED tokens saved — shown as a separate "~Y modeled"
     *  segment on the All-time line, never folded into `tokensSaved`. */
    modeledSaved?: number;
    spendUsd?: number;
  };
  /** Render a one-line summary for surfaces without a multi-line channel —
   *  selected via agent-registry capability, never agent-name special-casing. */
  singleLine?: boolean;
}

/** One session event-type tally — `phrasing` is already singular/plural-correct
 *  for `count` (the shape `renderSessionEconomyLineLive` returns). */
export interface ReportHighlight {
  event_type: string;
  count: number;
  phrasing: string;
}

interface Bullet {
  text: string;
  /** Priority tier (see PRIORITY) — lower is shown first. */
  priority: number;
  /** Intra-tier tiebreak — tokens saved for savers, 0 otherwise. Larger
   *  wins, so the biggest saver leads among equal-priority bullets. */
  weight: number;
}

function numberOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function stringOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function exact(n: number): string {
  return n.toLocaleString("en-US");
}

function baseName(p: string): string {
  const clean = p.replace(/[\\/]+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    const fixed = m >= 10 ? m.toFixed(0) : m.toFixed(1);
    return `${sign}${fixed.replace(/\.0$/, "")}M`;
  }
  if (abs >= 1000) {
    const k = abs / 1000;
    const fixed = k >= 10 ? k.toFixed(0) : k.toFixed(1);
    return `${sign}${fixed.replace(/\.0$/, "")}k`;
  }
  return `${n}`;
}

// ── Concrete bullet builders ─────────────────────────────────────────

/** Biggest file-read gating this turn → "skipped reading X (N lines) — …". */
function fileReadBullet(turnEvents: readonly NamedEvent[]): Bullet | null {
  let best: {
    saved: number;
    meta: Record<string, unknown>;
    file: string;
  } | null = null;
  for (const e of turnEvents) {
    if (e.event_type !== "tokenflow.file_read") continue;
    const saved = numberOf(e.metadata.tokens_saved);
    if (saved <= 0) continue;
    if (!best || saved > best.saved) {
      best = {
        saved,
        meta: e.metadata,
        file: stringOf(e.metadata.file_path) || e.file_path || "a large file",
      };
    }
  }
  if (!best) return null;
  const lines = numberOf(best.meta.total_lines);
  const opt = stringOf(best.meta.optimization);
  const how = opt.includes("outline")
    ? "served the outline instead"
    : opt.includes("window")
      ? "served just the lines you needed"
      : opt.includes("chunk")
        ? "served a focused chunk"
        : "served only what you needed";
  const linePart = lines > 0 ? ` (${exact(lines)} lines)` : "";
  return {
    text: `skipped reading ${baseName(best.file)}${linePart} — ${how}  (+${exact(best.saved)})`,
    priority: PRIORITY.FILE_READ,
    weight: best.saved,
  };
}

/** Biggest shell compression this turn → "compressed `cmd` to its summary".
 *  Suppressed below SHELL_BULLET_MIN_SAVED — a trivial compression is
 *  commodity noise that shouldn't consume a scarce bullet slot. */
function shellBullet(turnEvents: readonly NamedEvent[]): Bullet | null {
  let best: { saved: number; cmd: string } | null = null;
  for (const e of turnEvents) {
    if (e.event_type !== "tokenflow.shell_compression") continue;
    const saved = numberOf(e.metadata.tokens_saved);
    if (saved <= 0) continue;
    if (!best || saved > best.saved) {
      best = { saved, cmd: stringOf(e.metadata.command) };
    }
  }
  if (!best || best.saved < SHELL_BULLET_MIN_SAVED) return null;
  let cmd = best.cmd
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^cd\s+\S+\s*&&\s*/, "");
  if (cmd.length === 0) cmd = "a shell command";
  if (cmd.length > MAX_CMD_CHARS) {
    cmd = `${cmd.slice(0, MAX_CMD_CHARS - 1).trimEnd()}…`;
  }
  return {
    text: `compressed \`${cmd}\` to its summary  (+${exact(best.saved)})`,
    priority: PRIORITY.COMMODITY,
    weight: best.saved,
  };
}

/** Biggest format-encoding compaction this turn → "compacted the reply".
 *  MEASURED (a real byte/token delta) — it belongs to the headline total, so
 *  it carries a `+exact` figure like the other measured savers. Suppressed
 *  below SHELL_BULLET_MIN_SAVED — a trivial compaction is commodity noise. */
function formatEncodingBullet(
  turnEvents: readonly NamedEvent[]
): Bullet | null {
  let best = 0;
  for (const e of turnEvents) {
    if (e.event_type !== "tokenflow.format_encoding") continue;
    const saved = numberOf(e.metadata.tokens_saved);
    if (saved > best) best = saved;
  }
  if (best < SHELL_BULLET_MIN_SAVED) return null;
  return {
    text: `compacted the reply encoding  (+${exact(best)})`,
    priority: PRIORITY.COMMODITY,
    weight: best,
  };
}

/** Context-bundle savings this turn → "bundled the discovery fan-out into one
 *  call". MODELED (round-trip estimate, not a measured delta) — it is NOT in
 *  the headline total, so it is labeled "(modeled)" and given weight 0 so it
 *  never out-ranks a measured saver in the same tier. Summed across every
 *  context_bundle event this turn. */
function contextBundleBullet(turnEvents: readonly NamedEvent[]): Bullet | null {
  let saved = 0;
  let sources = 0;
  for (const e of turnEvents) {
    if (e.event_type !== "tokenflow.context_bundle") continue;
    saved += numberOf(e.metadata.tokens_saved);
    sources += numberOf(e.metadata.sources_collapsed);
  }
  if (saved <= 0) return null;
  const what =
    sources > 0
      ? `bundled ${exact(sources)} ${sources === 1 ? "source" : "sources"} into one call`
      : "bundled the discovery fan-out into one call";
  return {
    text: `${what}  (~${formatTokens(saved)} modeled)`,
    priority: PRIORITY.COMMODITY,
    weight: 0,
  };
}

/** A trace_recalled event this turn → "resurfaced N dated incidents" — a past
 *  resolved incident from the timeline store, not a stored rule. */
function recallBullet(recall: AttributionRecall | undefined): Bullet | null {
  if (!recall || recall.count <= 0) return null;
  const noun = recall.count === 1 ? "incident" : "incidents";
  return {
    text: `resurfaced ${exact(recall.count)} dated ${noun}  (recall)`,
    priority: PRIORITY.JOURNAL,
    weight: 0,
  };
}

/** Code lookups served this turn → "looked up callers of X (+2 more)". */
function graphBullet(turnEvents: readonly NamedEvent[]): Bullet | null {
  const named: Array<{ ent: string; tool: string }> = [];
  for (const e of turnEvents) {
    if (e.event_type !== "graph_query_served") continue;
    const ent = e.entity_key ?? stringOf(e.metadata.entity_key);
    if (!ent) continue;
    named.push({ ent, tool: stringOf(e.metadata.tool) });
  }
  const first = named[0];
  if (!first) return null;
  const verb =
    first.tool === "get_references"
      ? "looked up callers of"
      : first.tool === "get_entity"
        ? "pulled up"
        : first.tool === "get_imports"
          ? "mapped imports of"
          : "looked up";
  const more = named.length > 1 ? ` (+${named.length - 1} more)` : "";
  return {
    text: `${verb} ${first.ent}${more}  (graph)`,
    priority: PRIORITY.COMMODITY,
    weight: 0,
  };
}

function driftBullet(drift: AttributionDrift): Bullet {
  return {
    text: `caught drift on ${baseName(drift.file_path)}  (drift)`,
    priority: PRIORITY.DRIFT,
    weight: 0,
  };
}

/**
 * Prevention + interjection bullets — the most differentiated signals unerr
 * emits: it actively stopped a mistake (blocked/warned a tool call, caught a
 * stale edit, guarded a cascade, broke a retry loop). These never render today
 * yet are exactly what the user wants surfaced over commodity compressions.
 *
 * Ranked here by severity (block > stale > cascade > loop > warn) and emitted
 * at PRIORITY.PREVENTION so they lead the bullet list. One bullet per
 * (type, target) pair — repeats of the same prevention on the same file are
 * collapsed so a tight loop doesn't flood the receipt.
 */
const PREVENTION_SEVERITY: Record<string, number> = {
  intervention_halted: 0,
  stale_edit_prevented: 1,
  cascade_guard: 2,
  loop_broken: 3,
  intervention_warned: 4,
  // Softest prevention: a pre-trip nudge that never halted a call. Ranks last.
  loop_redirect: 5,
};

function preventionText(e: NamedEvent): string {
  const where = e.file_path ? ` to ${baseName(e.file_path)}` : "";
  const target = e.file_path
    ? baseName(e.file_path)
    : e.entity_key || stringOf(e.metadata.tool);
  switch (e.event_type) {
    case "intervention_halted":
      return `blocked a risky edit${where} before it ran  (blocked)`;
    case "stale_edit_prevented":
      return `caught a stale edit${where} — you'd have overwritten newer code  (prevented)`;
    case "cascade_guard":
      return `guarded a cascading edit${where} from breaking callers  (guarded)`;
    case "loop_broken": {
      const attempts = numberOf(e.metadata.attempts);
      const on = target ? ` on ${target}` : "";
      const count = attempts > 0 ? ` (${attempts} attempts)` : "";
      return `broke a repeated retry loop${on}${count}  (loop broken)`;
    }
    case "intervention_warned":
      return `flagged a risky edit${where} before you ran it  (flagged)`;
    case "loop_redirect": {
      const attempts = numberOf(e.metadata.attempts);
      const on = target ? ` on ${target}` : "";
      const count = attempts > 0 ? ` (${attempts} attempts)` : "";
      return `redirected a stuck retry${on}${count} to a different tool  (redirected)`;
    }
    default:
      return "";
  }
}

/** Deduped prevention events this turn — one per (type, target), severity
 *  order (block > stale > cascade > loop > warn). Source of BOTH the prevention
 *  bullets and the State-1 averted-loss headline, so the headline count always
 *  matches the bullets shown. */
function collectPreventions(turnEvents: readonly NamedEvent[]): NamedEvent[] {
  const seen = new Set<string>();
  const picked: NamedEvent[] = [];
  for (const e of turnEvents) {
    if (!(e.event_type in PREVENTION_SEVERITY)) continue;
    const key = `${e.event_type}|${e.file_path ?? e.entity_key ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(e);
  }
  picked.sort(
    (a, b) =>
      (PREVENTION_SEVERITY[a.event_type] ?? 9) -
      (PREVENTION_SEVERITY[b.event_type] ?? 9)
  );
  return picked;
}

function preventionBullets(turnEvents: readonly NamedEvent[]): Bullet[] {
  return collectPreventions(turnEvents)
    .map((e) => preventionText(e))
    .filter((text) => text.length > 0)
    .map((text) => ({ text, priority: PRIORITY.PREVENTION, weight: 0 }));
}

/**
 * State 1 — averted-loss headline. When unerr stopped something this turn,
 * the headline leads with WHAT IT STOPPED (the rarest, highest-stakes signal)
 * instead of the token number, which moves to the footer. Hard stops
 * (`isHardPrevention`: blocked / stale-edit / cascade / loop) drive
 * "stopped N changes before they broke"; a soft-only turn (warned) reads
 * "flagged N risky edits before they ran".
 */
function buildPreventionHeadline(preventions: readonly NamedEvent[]): string {
  const hard = preventions.filter((e) => isHardPrevention(e.event_type)).length;
  if (hard > 0) {
    const noun = hard === 1 ? "change" : "changes";
    const pron = hard === 1 ? "it" : "they";
    return `unerr » stopped ${hard} ${noun} before ${pron} broke this turn`;
  }
  const soft = preventions.length;
  const noun = soft === 1 ? "edit" : "edits";
  const pron = soft === 1 ? "it" : "they";
  return `unerr » flagged ${soft} risky ${noun} before ${pron} ran this turn`;
}

function buildHeadline(
  turnTokensSaved: number,
  sessionHeadroom: number
): string {
  if (turnTokensSaved > 0) {
    const hr =
      sessionHeadroom > 0
        ? ` (≈${sessionHeadroom} ${sessionHeadroom === 1 ? "turn" : "turns"} of headroom kept open)`
        : "";
    return `unerr » this turn: saved ${exact(turnTokensSaved)} tokens${hr}`;
  }
  // No token savings, but a nameable intervention fired — the bullets
  // carry the concrete story.
  return "unerr » this turn — here's where unerr helped";
}

/** 2-space indent for the session-recap rows — aligns the bucket labels under
 *  the recap header, markdown-safe (4+ spaces renders as a code block). */
const RECAP_INDENT = "  ";

interface RecapBucket {
  total: number;
  /** Hard-stop count (prevented bucket only) — drives "likely breakages". */
  hard: number;
  /** Per-event-type phrases, count desc — "4 risky cascading edits". */
  parts: string[];
}

/** Group a whole-session highlights tally into the three report buckets
 *  (Prevented / Remembered / Saved). Events with no bucket — neutral markers,
 *  `user_prompt_received` — return null from `eventBucket` and are dropped. */
function bucketizeSession(
  highlights: readonly ReportHighlight[]
): Record<"prevented" | "flagged" | "remembered" | "saved", RecapBucket> {
  const out = {
    prevented: { total: 0, hard: 0, parts: [] as string[] },
    flagged: { total: 0, hard: 0, parts: [] as string[] },
    remembered: { total: 0, hard: 0, parts: [] as string[] },
    saved: { total: 0, hard: 0, parts: [] as string[] },
  };
  for (const h of highlights) {
    const bucket = eventBucket(h.event_type);
    if (!bucket) continue;
    // Soft prevention-bucket events (review findings, drift, warnings) are
    // "flagged for review", NOT "breakages prevented" — route them to a
    // separate `flagged` bucket so the session "Prevented" count uses the same
    // hard-stop definition as the All-time line
    // (MetricsStore.hardPreventionTotal). Without this split the session shows
    // a broad count (e.g. 444) while All-time shows hard-only (101) — reads as
    // a contradiction.
    const soft = bucket === "prevented" && !isHardPrevention(h.event_type);
    const s = soft ? out.flagged : out[bucket];
    s.total += h.count;
    if (bucket === "prevented" && !soft) s.hard += h.count;
    s.parts.push(`${h.count} ${h.phrasing}`);
  }
  return out;
}

/**
 * State 3 — the session recap, folded into the per-turn line on recap turns.
 * Three labelled rows (only those with content), plus an optional All-time
 * line when lifetime anchors are supplied. Returns [] when the session has
 * nothing to report (so the caller can fall through to the turn line alone).
 */
function recapBlock(inputs: ReceiptBlockInputs): string[] {
  const sess = bucketizeSession(inputs.sessionHighlights ?? []);
  const rows: string[] = [];

  if (sess.prevented.total > 0) {
    const n = sess.prevented.total;
    rows.push(
      `${RECAP_INDENT}Prevented   ${n} likely ${n === 1 ? "breakage" : "breakages"} — ${sess.prevented.parts.join(", ")}`
    );
  }
  if (sess.flagged.total > 0) {
    const n = sess.flagged.total;
    rows.push(
      `${RECAP_INDENT}Flagged     ${n} ${n === 1 ? "thing" : "things"} for review — ${sess.flagged.parts.join(", ")}`
    );
  }
  if (sess.remembered.total > 0) {
    rows.push(
      `${RECAP_INDENT}Journal     ${sess.remembered.parts.join(" · ")}`
    );
  }
  if (inputs.sessionTokensSaved > 0 || inputs.sessionHeadroom > 0) {
    const room =
      inputs.sessionHeadroom > 0
        ? `  (~${inputs.sessionHeadroom} ${inputs.sessionHeadroom === 1 ? "turn" : "turns"} of extra room)`
        : "";
    rows.push(
      `${RECAP_INDENT}Saved       ${formatTokens(inputs.sessionTokensSaved)} tokens${room}`
    );
  }
  // Modeled (context-bundle round-trip estimates) on its own labeled row so it
  // is never read as part of the measured "Saved" figure above.
  const sessModeled = inputs.sessionModeledSaved ?? 0;
  if (sessModeled > 0) {
    rows.push(
      `${RECAP_INDENT}Modeled     ~${formatTokens(sessModeled)} tokens (round-trips avoided, estimated)`
    );
  }

  const lt = inputs.lifetime;
  if (lt) {
    const segs: string[] = [];
    if (lt.prevented != null && lt.prevented > 0) {
      segs.push(
        `${exact(lt.prevented)} ${lt.prevented === 1 ? "breakage" : "breakages"} prevented`
      );
    }
    if (lt.tokensSaved != null && lt.tokensSaved > 0) {
      const spend =
        lt.spendUsd != null && lt.spendUsd > 0
          ? ` (≈ $${Math.round(lt.spendUsd)} of agent spend)`
          : "";
      segs.push(`${formatTokens(lt.tokensSaved)} tokens saved${spend}`);
    }
    if (lt.modeledSaved != null && lt.modeledSaved > 0) {
      segs.push(`~${formatTokens(lt.modeledSaved)} modeled`);
    }
    if (segs.length > 0) {
      rows.push(`${RECAP_INDENT}All-time: ${segs.join(" · ")}.`);
    }
  }

  if (rows.length === 0) return [];
  return ["unerr » this session, unerr kept your agent on track:", ...rows];
}

// ── Files-changed section ────────────────────────────────────────────
//
// A deterministic, host-emitted list of every file the agent edited this turn
// with its changed line ranges — independent of the model echoing the change
// in its reply (which it dropped ~94% of the time). Sourced from the
// `code_edit_applied` behavior events the proxy records on each successful
// `file_edit`. Renders on ANY edit turn, even one with no token savings.

/** Max line ranges shown per file before collapsing to a `+N more` tail. */
const MAX_RANGES_PER_FILE = 5;

interface FileChange {
  file: string;
  added: number;
  removed: number;
  ranges: Array<{ start: number; end: number }>;
}

/** Coerce a metadata `ranges` blob into typed {start,end} pairs, dropping any
 *  malformed entry. The blob arrives via JSON projection, so values are
 *  untrusted. */
function parseRanges(raw: unknown): Array<{ start: number; end: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ start: number; end: number }> = [];
  for (const r of raw) {
    const start = numberOf((r as { start?: unknown })?.start);
    const end = numberOf((r as { end?: unknown })?.end);
    if (start > 0 && end >= start) out.push({ start, end });
  }
  return out;
}

/** Merge overlapping / adjacent ranges (sorted by start) so "lines 10–12,
 *  13–15" collapses to "lines 10–15". */
function mergeRanges(
  ranges: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end + 1) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Render merged ranges as "line 12" / "lines 12, 40–58 (+2 more)". */
function formatRanges(ranges: Array<{ start: number; end: number }>): string {
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return "";
  const shown = merged.slice(0, MAX_RANGES_PER_FILE);
  const parts = shown.map((r) =>
    r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`
  );
  const overflow = merged.length - shown.length;
  const tail = overflow > 0 ? ` (+${overflow} more)` : "";
  const single = merged.length === 1 && merged[0]!.start === merged[0]!.end;
  return `${single ? "line" : "lines"} ${parts.join(", ")}${tail}`;
}

/** Aggregate this turn's `code_edit_applied` events into one row per file,
 *  preserving first-edit order. Multiple edits to the same file sum their
 *  counts and concatenate their ranges (merged at render time). */
function collectFileChanges(turnEvents: readonly NamedEvent[]): FileChange[] {
  const byFile = new Map<string, FileChange>();
  for (const e of turnEvents) {
    if (e.event_type !== "code_edit_applied") continue;
    const file = e.file_path || stringOf(e.metadata.file_path);
    if (!file) continue;
    const added = numberOf(e.metadata.added);
    const removed = numberOf(e.metadata.removed);
    const ranges = parseRanges(e.metadata.ranges);
    const existing = byFile.get(file);
    if (existing) {
      existing.added += added;
      existing.removed += removed;
      existing.ranges.push(...ranges);
    } else {
      byFile.set(file, { file, added, removed, ranges });
    }
  }
  return [...byFile.values()];
}

/**
 * The deterministic "files changed this turn" block — a header plus one row
 * per edited file with its added/removed line counts and changed line ranges.
 * Returns [] when no file was edited this turn.
 */
function renderFilesChanged(turnEvents: readonly NamedEvent[]): string[] {
  const changes = collectFileChanges(turnEvents);
  if (changes.length === 0) return [];
  const n = changes.length;
  const out = [`unerr » ${n} ${n === 1 ? "file" : "files"} changed this turn`];
  for (const c of changes) {
    const ranges = formatRanges(c.ranges);
    const where = ranges ? `  (${ranges})` : "";
    out.push(
      `${BULLET_INDENT}${BULLET} ${c.file}  +${c.added} -${c.removed}${where}`
    );
  }
  return out;
}

/** Per-turn lines: prevention-first (State 1) or token-first (State 2)
 *  headline + up to 3 ranked concrete bullets + optional footer. Returns []
 *  on a quiet turn (no savings AND no nameable bullet) so the caller can fold
 *  in the recap alone or fall back to the legacy single-liner. */
function renderTurnLines(inputs: ReceiptBlockInputs): string[] {
  const {
    attribution,
    turnTokensSaved,
    sessionTokensSaved,
    sessionHeadroom,
    turnEvents,
  } = inputs;

  const preventions = collectPreventions(turnEvents);

  // Collect every candidate bullet, each tagged with its priority tier. The
  // differentiated signals (prevention/interjection, recall, drift) rank
  // ABOVE commodity compressions (shell, graph) — the headline already carries
  // the raw token number, so the bullets lead with what only unerr does. A
  // single (priority asc, weight desc) sort then picks the scarce slots.
  const candidates: Bullet[] = [];
  candidates.push(...preventionBullets(turnEvents));
  const rb = recallBullet(attribution.recalls[0]);
  if (rb) candidates.push(rb);
  for (const d of attribution.drift) candidates.push(driftBullet(d));
  const fr = fileReadBullet(turnEvents);
  if (fr) candidates.push(fr);
  const sh = shellBullet(turnEvents);
  if (sh) candidates.push(sh);
  const fe = formatEncodingBullet(turnEvents);
  if (fe) candidates.push(fe);
  const cb = contextBundleBullet(turnEvents);
  if (cb) candidates.push(cb);
  const gb = graphBullet(turnEvents);
  if (gb) candidates.push(gb);

  candidates.sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : b.weight - a.weight
  );

  const shown = candidates.slice(0, MAX_BULLETS);
  const overflow = candidates.length - shown.length;

  if (shown.length === 0 && turnTokensSaved <= 0) return [];

  // Prevention-led when a guardrail fired this turn — the averted loss is the
  // headline, the token number moves to the footer.
  const preventionLed = preventions.length > 0;
  const out = [
    preventionLed
      ? buildPreventionHeadline(preventions)
      : buildHeadline(turnTokensSaved, sessionHeadroom),
    ...shown.map((b) => `${BULLET_INDENT}${BULLET} ${b.text}`),
  ];

  const footerParts: string[] = [];
  // Prevention-led: the headline no longer carries the token number, so add
  // this turn's savings to the footer rather than dropping them.
  if (preventionLed && turnTokensSaved > 0) {
    footerParts.push(`saved ${formatTokens(turnTokensSaved)} this turn`);
  }
  if (sessionTokensSaved > 0) {
    footerParts.push(`${formatTokens(sessionTokensSaved)} saved this session`);
  }
  // Modeled savings ride a separate, explicitly-labeled footer segment so an
  // estimate never sits inside the measured "saved" figure.
  const turnModeledSaved = inputs.turnModeledSaved ?? 0;
  if (turnModeledSaved > 0) {
    footerParts.push(`~${formatTokens(turnModeledSaved)} modeled this turn`);
  }
  if (overflow > 0) footerParts.push(`+${overflow} more`);
  if (footerParts.length > 0) {
    out.push(`${BULLET_INDENT}· ${footerParts.join(" · ")}`);
  }

  return out;
}

/** One-line fallback for surfaces without a multi-line channel — a session
 *  summary (prevented · recalled · saved). Selected by the caller via an
 *  agent-registry capability, never agent-name special-casing. */
function renderSingleLine(inputs: ReceiptBlockInputs): string[] {
  const sess = bucketizeSession(inputs.sessionHighlights ?? []);
  const segs: string[] = [];
  if (sess.prevented.total > 0) segs.push(`prevented ${sess.prevented.total}`);
  if (inputs.sessionTokensSaved > 0) {
    const room =
      inputs.sessionHeadroom > 0
        ? ` (~${inputs.sessionHeadroom} ${inputs.sessionHeadroom === 1 ? "turn" : "turns"})`
        : "";
    segs.push(`saved ${formatTokens(inputs.sessionTokensSaved)} tokens${room}`);
  }
  if (segs.length === 0) {
    return inputs.fallbackLine ? [inputs.fallbackLine] : [];
  }
  return [`unerr » session: ${segs.join(" · ")}`];
}

/**
 * Render the per-turn receipt block. Returns 1 to ~9 lines. The single shared
 * renderer behind BOTH close-out surfaces (the `unerr_turn_summary` MCP tool
 * and the Stop hook) so output is byte-identical regardless of agent.
 *
 * Behaviour:
 *   - `singleLine` → one-line session summary (constrained surfaces).
 *   - Quiet turn AND no recap → `[fallbackLine]` (legacy single-liner).
 *   - Otherwise → per-turn lines (prevention-first or token-first headline +
 *     ranked bullets + footer), with the session recap appended on recap turns.
 */
export function renderReceiptBlock(inputs: ReceiptBlockInputs): string[] {
  if (inputs.singleLine) return renderSingleLine(inputs);

  const turnLines = renderTurnLines(inputs);
  const filesChanged = renderFilesChanged(inputs.turnEvents);
  const recap = inputs.recapTurn ? recapBlock(inputs) : [];

  // The files-changed block renders on ANY edit turn, even one with no token
  // savings and no bucketed event — so a pure-edit turn still gets a receipt
  // (it would otherwise fall through to the fallback line / nothing).
  if (
    turnLines.length === 0 &&
    filesChanged.length === 0 &&
    recap.length === 0
  ) {
    return inputs.fallbackLine ? [inputs.fallbackLine] : [];
  }
  return [...turnLines, ...filesChanged, ...recap];
}

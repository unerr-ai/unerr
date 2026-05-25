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
 * → 3-way join → recalled/captured rules → drift → large file-read gated →
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

import type { NamedEvent } from "../tracking/named-events.js";
import type { RuntimeJoinCounts } from "../tracking/runtime-joins.js";
import type {
  AttributionCapture,
  AttributionDrift,
  AttributionRecall,
  ReceiptAttribution,
} from "./receipt-attribution.js";

const BULLET = "◆";
/** 2-space indent — markdown-safe (4+ spaces would render as a code block
 *  when the agent pastes the line) and aligns under the headline. */
const BULLET_INDENT = "  ";
const MAX_BULLETS = 3;
const MAX_QUOTE_CHARS = 60;
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
 *   JOIN       — 3-way cross-tier join (memory → graph → drift). Very rare.
 *   MEMORY     — your recalled / captured rules. Core unerr value.
 *   DRIFT      — stale-code drift caught and applied.
 *   FILE_READ  — gated a large file read. A real saver and a concrete
 *                surprise ("skipped 4,311 lines"), so it outranks commodity.
 *   COMMODITY  — shell-output compression and graph lookups. Useful but not
 *                differentiated; any tool does these. Deprioritised so they
 *                fill slots only when nothing rarer fired.
 */
const PRIORITY = {
  PREVENTION: 0,
  JOIN: 1,
  MEMORY: 2,
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
  /** Tokens saved during the current turn (token_flow_events sum). */
  turnTokensSaved: number;
  /** Tokens saved across the session so far. */
  sessionTokensSaved: number;
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

function truncateQuote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MAX_QUOTE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
}

function pickQuote(row: AttributionRecall | AttributionCapture): string {
  if (row.source_quote && row.source_quote.length <= MAX_QUOTE_CHARS) {
    return row.source_quote.trim();
  }
  return truncateQuote(row.content);
}

function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) {
    const k = abs / 1000;
    const fixed = k >= 10 ? k.toFixed(0) : k.toFixed(1);
    return `${n < 0 ? "-" : ""}${fixed.replace(/\.0$/, "")}k`;
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

/** Three-way cross-tier join (memory + graph + drift on one entity) — the
 *  rarest, most differentiated signal. Named entity required. */
function joinBullet(joins: RuntimeJoinCounts): Bullet | null {
  if (joins.three_way <= 0) return null;
  const entity = joins.entities.find((e) => e.length > 0);
  if (!entity) return null;
  return {
    text: `connected your memory → the graph → live drift on ${baseName(entity)}  (3-way join)`,
    priority: PRIORITY.JOIN,
    weight: 0,
  };
}

/** First recalled rule this turn → 'reminded you: "…"'. */
function recallBullet(recall: AttributionRecall | undefined): Bullet | null {
  if (!recall) return null;
  const quote = pickQuote(recall);
  const where =
    recall.scope && recall.scope !== "project"
      ? ` at ${baseName(recall.scope)}`
      : "";
  return {
    text: `reminded you: "${quote}"${where}  (recall)`,
    priority: PRIORITY.MEMORY,
    weight: 0,
  };
}

/** A rule captured this turn → 'remembered "…"'. */
function captureBullet(capture: AttributionCapture): Bullet {
  return {
    text: `remembered "${pickQuote(capture)}"  (capture)`,
    priority: PRIORITY.MEMORY,
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
    default:
      return "";
  }
}

function preventionBullets(turnEvents: readonly NamedEvent[]): Bullet[] {
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
  return picked
    .map((e) => preventionText(e))
    .filter((text) => text.length > 0)
    .map((text) => ({ text, priority: PRIORITY.PREVENTION, weight: 0 }));
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

/**
 * Render the per-turn receipt block. Returns 1 to 5 lines.
 *
 * Behaviour:
 *   - No token savings AND no nameable bullet → `[fallbackLine]` (legacy).
 *   - Otherwise → headline (savings + headroom) + up to 3 ranked concrete
 *     bullets + optional footer (session savings, overflow count).
 */
export function renderReceiptBlock(inputs: ReceiptBlockInputs): string[] {
  const {
    attribution,
    runtimeJoins,
    turnTokensSaved,
    sessionTokensSaved,
    sessionHeadroom,
    turnEvents,
  } = inputs;

  // Collect every candidate bullet, each tagged with its priority tier. The
  // differentiated signals (prevention/interjection, join, memory, drift) rank
  // ABOVE commodity compressions (shell, graph) — the headline already carries
  // the raw token number, so the bullets lead with what only unerr does. A
  // single (priority asc, weight desc) sort then picks the scarce slots.
  const candidates: Bullet[] = [];
  candidates.push(...preventionBullets(turnEvents));
  const jb = joinBullet(runtimeJoins);
  if (jb) candidates.push(jb);
  const rb = recallBullet(attribution.recalls[0]);
  if (rb) candidates.push(rb);
  for (const c of attribution.captures) candidates.push(captureBullet(c));
  for (const d of attribution.drift) candidates.push(driftBullet(d));
  const fr = fileReadBullet(turnEvents);
  if (fr) candidates.push(fr);
  const sh = shellBullet(turnEvents);
  if (sh) candidates.push(sh);
  const gb = graphBullet(turnEvents);
  if (gb) candidates.push(gb);

  candidates.sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : b.weight - a.weight
  );

  const shown = candidates.slice(0, MAX_BULLETS);
  const overflow = candidates.length - shown.length;

  if (shown.length === 0 && turnTokensSaved <= 0) {
    return [inputs.fallbackLine];
  }

  const out = [
    buildHeadline(turnTokensSaved, sessionHeadroom),
    ...shown.map((b) => `${BULLET_INDENT}${BULLET} ${b.text}`),
  ];

  const footerParts: string[] = [];
  if (sessionTokensSaved > 0) {
    footerParts.push(`${formatTokens(sessionTokensSaved)} saved this session`);
  }
  if (overflow > 0) footerParts.push(`+${overflow} more`);
  if (footerParts.length > 0) {
    out.push(`${BULLET_INDENT}· ${footerParts.join(" · ")}`);
  }

  return out;
}

/**
 * Session-journal sentinel grammar + scraper (Phase-2 Sprint 7, T7.9).
 *
 * §7.6: agent-derived markers (intent, decisions, blockers, resolutions)
 * return nothing the model needs THIS turn, so they don't earn an MCP
 * round-trip. Instead the model emits a strict sentinel line in the closing
 * message it writes anyway; a Stop hook scrapes + persists it (no round-trip —
 * it rides the existing message, only cheap output tokens).
 *
 * The USER reads these lines, so the visible grammar uses plain words and names
 * itself a journal (a dated audit + analytics trail, NOT memory). The plain
 * labels map back to the FROZEN contract ops at scrape time, so timeline.db, the
 * `type:"timeline"` wire events, and `@unerr-ai/contracts` are byte-for-byte
 * unchanged — this is a display rename only:
 *
 *   unerr journal - goal - <one-line>      → op:intent
 *   unerr journal - decided - <one-line>   → op:decision
 *   unerr journal - stuck - <one-line>     → op:blocker
 *   unerr journal - fixed - <one-line>     → op:resolution
 *
 * The label is one fixed keyword, so a "-" inside the free text can't confuse
 * the split (the trailing capture is greedy). The legacy
 * `unerr-save: <op> <one-line>` form is still ACCEPTED (transcripts emitted
 * before a rebuild, instruction files not yet regenerated) but no longer
 * emitted. Parsing is pure + total — it never throws; bad lines drop to nothing.
 */

/** Legacy sentinel prefix — still accepted on scrape, no longer emitted. */
export const SENTINEL_PREFIX = "unerr-save:";

/** Valid internal marker ops (frozen contract vocabulary). */
const MARKER_OPS = new Set(["intent", "decision", "blocker", "resolution"]);

/**
 * Visible journal label → frozen contract op. The user sees the left column;
 * everything stored and synced uses the right column. Editing a label here is a
 * pure display change — it never touches the wire, the DB, or the contract.
 */
const JOURNAL_LABEL_TO_OP: Record<string, MarkerSave["op"]> = {
  goal: "intent",
  decided: "decision",
  stuck: "blocker",
  fixed: "resolution",
};

/**
 * New visible form: "[list markers] unerr journal - <label> - <free text>".
 * Anchored at line start (after list-marker/quote prefixes only), so prose that
 * merely mentions the phrase mid-sentence is not scraped.
 */
const JOURNAL_LINE_RE =
  /^[-*>\s]*unerr\s+journal\s*-\s*(goal|decided|stuck|fixed)\s*-\s*(.+)$/i;

/** A parsed marker save — routed to the matching mark_* tool. */
export interface MarkerSave {
  kind: "marker";
  op: "intent" | "decision" | "blocker" | "resolution";
  text: string;
  /**
   * Resolution-only: agent-refined dead-ends that override the auto-derived
   * list. Parsed from `| dead_ends:<comma-csv>` suffix on a resolution line.
   * Absent means use the auto-derived value from the ledger span.
   */
  refinedDeadEnds?: string[];
}

export type SentinelSave = MarkerSave;

/**
 * Scrape every well-formed journal sentinel from a closing message. Returns the
 * parsed saves in document order; malformed sentinels are dropped. Pure + total:
 * never throws, never reads I/O.
 */
export function scrapeSentinels(message: string): SentinelSave[] {
  if (!message || typeof message !== "string") return [];
  const out: SentinelSave[] = [];
  for (const rawLine of message.split("\n")) {
    const save = parseSentinelLine(rawLine);
    if (save) out.push(save);
  }
  return out;
}

/**
 * Parse one raw line into a save, trying the new journal form first and the
 * legacy `unerr-save:` form second. Returns null for any non-sentinel line.
 */
function parseSentinelLine(rawLine: string): SentinelSave | null {
  const line = rawLine.trim();

  const journal = JOURNAL_LINE_RE.exec(line);
  if (journal) {
    const label = journal[1]?.toLowerCase();
    const text = journal[2]?.trim();
    const op = label ? JOURNAL_LABEL_TO_OP[label] : undefined;
    return op && text ? finalizeMarker(op, text) : null;
  }

  // Legacy form: "unerr-save: <op> <free text>" (accepted, no longer emitted).
  const idx = line.indexOf(SENTINEL_PREFIX);
  if (idx === -1) return null;
  // Allow leading list markers / quotes ("- unerr-save:", "> unerr-save:").
  const prefixCtx = line.slice(0, idx).trim();
  if (prefixCtx.length > 0 && !/^[-*>\s]+$/.test(prefixCtx)) return null;
  const body = line.slice(idx + SENTINEL_PREFIX.length).trim();
  if (body.length === 0) return null;
  return parseSentinelBody(body);
}

/**
 * Parse the text AFTER `unerr-save:` (legacy body) into one save, or null when
 * malformed. Exported for focused tests. The leading token selects the op.
 */
export function parseSentinelBody(body: string): SentinelSave | null {
  const spaceIdx = body.indexOf(" ");
  const head = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();
  if (!MARKER_OPS.has(head)) return null;
  return finalizeMarker(head as MarkerSave["op"], rest);
}

/**
 * Build a marker save from a resolved (op, text). Empty text drops to null. For
 * a resolution, an optional ` | dead_ends:<csv>` suffix refines the
 * auto-derived dead-ends list (default = ledger-span derivation).
 */
function finalizeMarker(
  op: MarkerSave["op"],
  text: string
): SentinelSave | null {
  if (text.length === 0) return null;
  if (op === "resolution") {
    const DEAD_ENDS_MARK = " | dead_ends:";
    const pipeIdx = text.indexOf(DEAD_ENDS_MARK);
    if (pipeIdx !== -1) {
      const unlockText = text.slice(0, pipeIdx).trim();
      const deadEndsStr = text.slice(pipeIdx + DEAD_ENDS_MARK.length).trim();
      const refinedDeadEnds = deadEndsStr
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return {
        kind: "marker",
        op: "resolution",
        text: unlockText.length > 0 ? unlockText : text,
        ...(refinedDeadEnds.length > 0 ? { refinedDeadEnds } : {}),
      };
    }
  }
  return { kind: "marker", op, text };
}

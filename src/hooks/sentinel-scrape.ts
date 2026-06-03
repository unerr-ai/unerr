/**
 * `unerr-save:` sentinel grammar + scraper (Phase-2 Sprint 7, T7.9).
 *
 * §7.6: agent-derived notes + markers (the Moment-4 save, decisions, blockers)
 * return nothing the model needs THIS turn, so they don't earn an MCP
 * round-trip. Instead the model emits a strict sentinel line in the closing
 * message it writes anyway; a Stop hook scrapes + persists it (no round-trip —
 * it rides the existing message, only cheap output tokens).
 *
 * The grammar is deliberately strict — a free-text scrape is LESS reliable than
 * a schema-validated tool call (§7.6's honest caveat), so we accept ONLY
 * well-formed sentinels and silently drop the rest. A malformed/omitted save is
 * surfaced on the NEXT turn's recall, never a this-turn re-prompt (which would
 * re-add the round-trip). The MCP write tools stay registered as the
 * high-fidelity escape — DEMOTE not delete.
 *
 * Grammar (one per line, anywhere in the closing message):
 *
 *   unerr-save: note kind|anchor|polarity|content
 *   unerr-save: intent <one-line>
 *   unerr-save: decision <one-line>
 *   unerr-save: blocker <one-line>
 *   unerr-save: resolution <one-line>
 *
 * `note` carries the DSL wire string verbatim (kind ∈ cnv/rul/wrn/dec/blk/fct;
 * anchor ∈ f:/e:/g:/p:; polarity ∈ +/-/~). The four marker forms carry free
 * text. Parsing is pure + total — it never throws; bad lines drop to nothing.
 */

export const SENTINEL_PREFIX = "unerr-save:";

/** Valid note kinds + marker ops, mirrored from the DSL vocabulary in CLAUDE.md. */
const NOTE_KINDS = new Set(["cnv", "rul", "wrn", "dec", "blk", "fct"]);
const MARKER_OPS = new Set(["intent", "decision", "blocker", "resolution"]);
/** Anchor must start with one of the DSL anchor sigils. */
const ANCHOR_SIGIL = /^(f:|e:|g:|p:)/;
const POLARITIES = new Set(["+", "-", "~"]);

/** A parsed note save — the DSL wire string the note-path `unerr_remember` wants. */
export interface NoteSave {
  kind: "note";
  /** The verbatim `kind|anchor|polarity|content` wire string. */
  wire: string;
}

/** A parsed marker save — routed to the matching mark_* tool. */
export interface MarkerSave {
  kind: "marker";
  op: "intent" | "decision" | "blocker" | "resolution";
  text: string;
}

export type SentinelSave = NoteSave | MarkerSave;

/**
 * Scrape every well-formed `unerr-save:` sentinel from a closing message.
 * Returns the parsed saves in document order; malformed sentinels are dropped.
 * Pure + total: never throws, never reads I/O.
 */
export function scrapeSentinels(message: string): SentinelSave[] {
  if (!message || typeof message !== "string") return [];
  const out: SentinelSave[] = [];

  for (const rawLine of message.split("\n")) {
    const line = rawLine.trim();
    const idx = line.indexOf(SENTINEL_PREFIX);
    if (idx === -1) continue;
    // Allow leading list markers / quotes ("- unerr-save:", "> unerr-save:").
    const prefixCtx = line.slice(0, idx).trim();
    if (prefixCtx.length > 0 && !/^[-*>\s]+$/.test(prefixCtx)) continue;

    const body = line.slice(idx + SENTINEL_PREFIX.length).trim();
    if (body.length === 0) continue;

    const save = parseSentinelBody(body);
    if (save) out.push(save);
  }
  return out;
}

/**
 * Parse the text AFTER `unerr-save:` into one save, or null when malformed.
 * Exported for focused tests. The leading token selects the form.
 */
export function parseSentinelBody(body: string): SentinelSave | null {
  const spaceIdx = body.indexOf(" ");
  const head = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();

  // Explicit "note <wire>" form.
  if (head === "note") return rest.length > 0 ? parseNoteWire(rest) : null;

  // Marker form: "<op> <free text>".
  if (MARKER_OPS.has(head)) {
    return rest.length > 0
      ? { kind: "marker", op: head as MarkerSave["op"], text: rest }
      : null;
  }

  // Bare note wire — the documented DSL emit shape `kind|anchor|polarity|content`
  // with no leading `note` keyword (CLAUDE.md DSL vocabulary).
  const firstBar = body.indexOf("|");
  if (firstBar !== -1) {
    const maybeKind = body.slice(0, firstBar).trim().toLowerCase();
    if (NOTE_KINDS.has(maybeKind)) return parseNoteWire(body);
  }
  return null;
}

/**
 * Validate a `kind|anchor|polarity|content` DSL wire string. Only the first
 * three `|` are separators (content may contain `|`), matching the DSL spec.
 * Returns the canonical wire string on success, null on any field violation.
 */
function parseNoteWire(wire: string): NoteSave | null {
  // Split into at most 4 fields — content keeps any further `|`.
  const firstBar = wire.indexOf("|");
  if (firstBar === -1) return null;
  const secondBar = wire.indexOf("|", firstBar + 1);
  if (secondBar === -1) return null;
  const thirdBar = wire.indexOf("|", secondBar + 1);
  if (thirdBar === -1) return null;

  const kind = wire.slice(0, firstBar).trim().toLowerCase();
  const anchor = wire.slice(firstBar + 1, secondBar).trim();
  const polarity = wire.slice(secondBar + 1, thirdBar).trim();
  const content = wire.slice(thirdBar + 1).trim();

  if (!NOTE_KINDS.has(kind)) return null;
  if (!ANCHOR_SIGIL.test(anchor)) return null;
  if (!POLARITIES.has(polarity)) return null;
  if (content.length === 0) return null;

  return { kind: "note", wire: `${kind}|${anchor}|${polarity}|${content}` };
}

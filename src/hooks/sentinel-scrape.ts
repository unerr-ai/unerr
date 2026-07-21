/**
 * `unerr-save:` sentinel grammar + scraper (Phase-2 Sprint 7, T7.9).
 *
 * §7.6: agent-derived markers (intent, decisions, blockers, resolutions)
 * return nothing the model needs THIS turn, so they don't earn an MCP
 * round-trip. Instead the model emits a strict sentinel line in the closing
 * message it writes anyway; a Stop hook scrapes + persists it (no round-trip —
 * it rides the existing message, only cheap output tokens).
 *
 * The grammar is deliberately strict — a free-text scrape is LESS reliable than
 * a schema-validated tool call (§7.6's honest caveat), so we accept ONLY
 * well-formed sentinels and silently drop the rest. A malformed/omitted save is
 * dropped, never a this-turn re-prompt (which would re-add the round-trip).
 * The MCP write tools stay registered as the high-fidelity escape — DEMOTE
 * not delete.
 *
 * Grammar (one per line, anywhere in the closing message):
 *
 *   unerr-save: intent <one-line>
 *   unerr-save: decision <one-line>
 *   unerr-save: blocker <one-line>
 *   unerr-save: resolution <one-line>
 *
 * The four marker forms carry free text. Parsing is pure + total — it never
 * throws; bad lines drop to nothing.
 */

export const SENTINEL_PREFIX = "unerr-save:";

/** Valid marker ops. */
const MARKER_OPS = new Set(["intent", "decision", "blocker", "resolution"]);

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

  // Marker form: "<op> <free text>".
  // For `resolution`, an optional ` | dead_ends:<csv>` suffix lets the agent
  // refine the auto-derived dead-ends list (default = ledger-span derivation).
  if (MARKER_OPS.has(head)) {
    if (rest.length === 0) return null;
    if (head === "resolution") {
      const DEAD_ENDS_MARK = " | dead_ends:";
      const pipeIdx = rest.indexOf(DEAD_ENDS_MARK);
      if (pipeIdx !== -1) {
        const unlockText = rest.slice(0, pipeIdx).trim();
        const deadEndsStr = rest.slice(pipeIdx + DEAD_ENDS_MARK.length).trim();
        const refinedDeadEnds = deadEndsStr
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return {
          kind: "marker",
          op: "resolution",
          text: unlockText.length > 0 ? unlockText : rest,
          ...(refinedDeadEnds.length > 0 ? { refinedDeadEnds } : {}),
        };
      }
    }
    return { kind: "marker", op: head as MarkerSave["op"], text: rest };
  }

  return null;
}

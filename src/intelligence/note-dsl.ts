/**
 * Active-cognition Layer B DSL parser/serializer.
 *
 * Wire format: kind|anchor|polarity|content
 *   kind     — cnv|rul|wrn|dec|blk|fct
 *   anchor   — f:<path> | e:<entity> | g:<glob> | p:
 *   polarity — + (do) | - (don't) | ~ (mixed)
 *   content  — single-line prose; may contain '|' characters
 *
 * Pure module — no DB, no IO. Construction is one '|'-join, deconstruction
 * is one split. See ACTIVE_COGNITION_REASON_LAYER.md §4.
 */

export type NoteKind = "cnv" | "rul" | "wrn" | "dec" | "blk" | "fct";
export type NoteAnchorType = "f" | "e" | "g" | "p";
export type NotePolarity = "+" | "-" | "~";

export interface ParsedNote {
  kind: NoteKind;
  anchor_type: NoteAnchorType;
  anchor_value: string;
  polarity: NotePolarity;
  content: string;
}

const VALID_KINDS: ReadonlySet<NoteKind> = new Set([
  "cnv",
  "rul",
  "wrn",
  "dec",
  "blk",
  "fct",
]);
const VALID_ANCHOR_TYPES: ReadonlySet<NoteAnchorType> = new Set([
  "f",
  "e",
  "g",
  "p",
]);
const VALID_POLARITIES: ReadonlySet<NotePolarity> = new Set(["+", "-", "~"]);

export class NoteDslError extends Error {
  constructor(
    message: string,
    public readonly field: string
  ) {
    super(`note-dsl: ${field}: ${message}`);
    this.name = "NoteDslError";
  }
}

/**
 * Parse a wire-format note. Content may contain '|' — only the first three
 * '|' are treated as field separators; everything after the third '|' is
 * preserved as the content body.
 */
export function parseNote(wire: string): ParsedNote {
  if (typeof wire !== "string" || wire.length === 0) {
    throw new NoteDslError("empty input", "wire");
  }
  const parts = splitAtMost(wire.trim(), "|", 4);
  if (parts.length !== 4) {
    throw new NoteDslError(`expected 4 fields, got ${parts.length}`, "wire");
  }
  const [kindRaw, anchorRaw, polarityRaw, contentRaw] = parts as [
    string,
    string,
    string,
    string,
  ];

  const kind = kindRaw.trim() as NoteKind;
  if (!VALID_KINDS.has(kind)) {
    throw new NoteDslError(`invalid kind '${kindRaw}'`, "kind");
  }
  const polarity = polarityRaw.trim() as NotePolarity;
  if (!VALID_POLARITIES.has(polarity)) {
    throw new NoteDslError(`invalid polarity '${polarityRaw}'`, "polarity");
  }
  const content = contentRaw.trim();
  if (content.length === 0) {
    throw new NoteDslError("content required", "content");
  }

  const { anchor_type, anchor_value } = parseAnchor(anchorRaw.trim());

  return { kind, anchor_type, anchor_value, polarity, content };
}

function parseAnchor(s: string): {
  anchor_type: NoteAnchorType;
  anchor_value: string;
} {
  if (s.length < 2 || s[1] !== ":") {
    throw new NoteDslError(
      `malformed anchor '${s}' — expected '<type>:<value>'`,
      "anchor"
    );
  }
  const anchor_type = s[0] as NoteAnchorType;
  if (!VALID_ANCHOR_TYPES.has(anchor_type)) {
    throw new NoteDslError(`invalid anchor_type '${s[0]}'`, "anchor");
  }
  const anchor_value = s.slice(2);
  // Project-wide anchor 'p:' has empty value; all others require one.
  if (anchor_type !== "p" && anchor_value.length === 0) {
    throw new NoteDslError(`anchor required (got '${s}')`, "anchor");
  }
  return { anchor_type, anchor_value };
}

/** Serialize a parsed note back to wire format. */
export function serializeNote(note: ParsedNote): string {
  if (!VALID_KINDS.has(note.kind)) {
    throw new NoteDslError(`invalid kind '${note.kind}'`, "kind");
  }
  if (!VALID_ANCHOR_TYPES.has(note.anchor_type)) {
    throw new NoteDslError(
      `invalid anchor_type '${note.anchor_type}'`,
      "anchor"
    );
  }
  if (!VALID_POLARITIES.has(note.polarity)) {
    throw new NoteDslError(`invalid polarity '${note.polarity}'`, "polarity");
  }
  if (note.anchor_type !== "p" && note.anchor_value.length === 0) {
    throw new NoteDslError("anchor required", "anchor");
  }
  if (note.content.trim().length === 0) {
    throw new NoteDslError("content required", "content");
  }
  const anchor = `${note.anchor_type}:${note.anchor_value}`;
  return `${note.kind}|${anchor}|${note.polarity}|${note.content}`;
}

/**
 * Compute the dedupe key for a note. Same key = same row (reinforcement).
 *
 *   key = kind + '|' + anchor + '|' + polarity + '|' + first-5-content-words
 *
 * Content normalization: lowercase, collapse internal whitespace, trim ends.
 */
export function dedupeKey(note: ParsedNote): string {
  const normalized = note.content.toLowerCase().replace(/\s+/g, " ").trim();
  const first5 = normalized.split(" ").slice(0, 5).join(" ");
  const anchor = `${note.anchor_type}:${note.anchor_value}`;
  return `${note.kind}|${anchor}|${note.polarity}|${first5}`;
}

/**
 * Split `s` at `sep` into at most `n` parts. Unlike String.split(sep, n)
 * (which drops trailing fields), this preserves everything after the
 * (n-1)th separator as the last element — so 'a|b|c|d|e' with n=4 becomes
 * ['a','b','c','d|e']. Required by the parser's "content may contain |"
 * contract.
 */
function splitAtMost(s: string, sep: string, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [s];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < n - 1; i++) {
    const idx = s.indexOf(sep, start);
    if (idx === -1) {
      out.push(s.slice(start));
      return out;
    }
    out.push(s.slice(start, idx));
    start = idx + sep.length;
  }
  out.push(s.slice(start));
  return out;
}

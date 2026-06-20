/**
 * Surface 2 — `loaded …` line renderer.
 *
 * Builds the user-facing prose line that opens each turn naming what unerr
 * actually pulled from memory for the current prompt. Used by both:
 *
 *   - `context-preface.ts` — proxy-side ambient preface
 *
 * Design goal: a first-time user reading the line should understand
 *   (a) what KIND of memory was loaded (rule / warning / decision / …)
 *   (b) WHEN they (or unerr) wrote it
 *   (c) WHY it surfaced for this turn — the anchor link makes the connection
 *   (d) what the note actually says (verbatim content)
 *
 * Cold-start handling: when the only available note is generic / system-set /
 * untested (anchor_type='p', reinforcement_count=0, content matches a
 * smoke-test signature), we emit a guided-empty-state line instead of
 * pretending the note is personalized. Empty silence is rejected — first-time
 * users need a *next action*, not a missing line.
 */

import type {
  NoteAnchorType,
  NoteKind,
  NotePolarity,
} from "../intelligence/note-dsl.js";
import { formatRelativeAge } from "./turn-footer.js";

/** Minimal field set the renderer needs. Mirrors `StoredNote` from
 *  notes-store.ts but kept narrow so non-StoredNote callers (the legacy
 *  `temporal-facts` recall path) can construct it from their own shape. */
export interface LoadedNoteFields {
  kind: NoteKind;
  anchor_type: NoteAnchorType;
  anchor_value: string;
  polarity: NotePolarity;
  content: string;
  created_at: number;
  reinforcement_count: number;
  anchor_missing: boolean;
  conflict_group_id: string;
}

export interface RenderLoadedNoteInput {
  /** The top recalled note for this turn. Null when nothing recalled. */
  note: LoadedNoteFields | null;
  /** The file unerr signals hit most this turn. Used when no note is
   *  available, or as a secondary signal when the note's anchor doesn't
   *  already name the same file. */
  topFile?: string | null;
  /** Clock for relative-age formatting. Defaults to `Date.now()`. */
  nowMs?: number;
}

/** Plain-English label for each DSL kind code. The kind word lets a
 *  first-time reader know whether this is a hard constraint (rul / wrn /
 *  blk) or a softer signal (cnv / dec / fct). */
const KIND_LABEL: Record<NoteKind, string> = {
  rul: "rule",
  cnv: "convention",
  wrn: "warning",
  dec: "decision",
  blk: "blocker",
  fct: "fact",
};

/** Cold-start signature: smoke-test artefacts, internal verification notes,
 *  and other system-set rows masquerading as user content. Used to switch
 *  the line into a guided-empty-state when the only available note matches. */
const SYSTEM_NOTE_SIGNATURE =
  /smoke[-_ ]?test|verification|^[a-z][a-z0-9-]+-[a-z]+-[a-z]+\s+—|^#\d+\b/i;

/** Long-path collapse: keep `<...>/parent/basename` so the line never blows
 *  the 80-token preface budget on deeply-nested files. */
function shortPath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length <= 2) return path; // can't shorten without losing meaning
  const tail = segments.slice(-2).join("/");
  return `…/${tail}`;
}

/** Long-content collapse: clip at the last word boundary before `maxLen`
 *  and suffix `…` so the prose stays readable. */
function clipContent(content: string, maxLen = 100): string {
  if (content.length <= maxLen) return content;
  const clipped = content.slice(0, maxLen);
  const lastSpace = clipped.lastIndexOf(" ");
  const cutAt = lastSpace > maxLen * 0.6 ? lastSpace : maxLen;
  return `${content.slice(0, cutAt).trimEnd()}…`;
}

/** Translate an anchor `{type, value}` into a `for <thing>` phrase, or the
 *  empty string for project-wide anchors where the phrase adds no signal.
 *  When the underlying file/entity has been removed (`anchor_missing`), the
 *  phrase is annotated so the user knows the note may be stale. */
function anchorPhrase(
  anchorType: NoteAnchorType,
  anchorValue: string,
  anchorMissing: boolean
): string {
  switch (anchorType) {
    case "f": {
      if (!anchorValue) return "";
      const path = shortPath(anchorValue);
      return anchorMissing
        ? `for ${path} (file no longer in repo)`
        : `for ${path}`;
    }
    case "e": {
      if (!anchorValue) return "";
      return anchorMissing
        ? `for \`${anchorValue}\` (entity not found)`
        : `for \`${anchorValue}\``;
    }
    case "g": {
      if (!anchorValue) return "";
      return `for files matching ${anchorValue}`;
    }
    case "p":
      // Project-wide anchors — the DSL discourages them and the "for"
      // phrase reads as filler ("for the project"). Omit entirely.
      return "";
    case "w":
      // Workspace-wide anchors (Sprint 7.2) span every repo in the workspace —
      // surface that so the user knows the rule is cross-repo, not repo-local.
      return "(workspace-wide)";
  }
}

/** Polarity badge — used only when negative/mixed adds clarity. `+`
 *  polarity is the default reading and adds no value to surface. */
function polaritySuffix(kind: NoteKind, polarity: NotePolarity): string {
  if (polarity === "+") return "";
  if (polarity === "-") {
    // For warnings the polarity is implicit in "warning"; skip the suffix.
    // For other kinds the negative reading matters: "rule (don't…)".
    return kind === "wrn" || kind === "blk" ? "" : " (don't)";
  }
  // polarity === "~" — mixed/ambiguous. Always worth surfacing so the user
  // knows the note has nuance, not just a one-sided assertion.
  return " (mixed)";
}

/** Reinforcement badge — only shown when the note has been re-saved enough
 *  times to read as "battle-tested" rather than "freshly captured". */
function reinforcementBadge(count: number): string {
  if (count >= 3) return ` (reinforced ${count}×)`;
  return "";
}

/** Runtime guards for the three DSL literal types — used by callers that
 *  reconstruct a `LoadedNoteFields` from untyped metadata (NamedEvent
 *  payloads, JSON-parsed wire frames, …) and need to confirm the literals
 *  before constructing the renderer input. */
export function isValidKind(v: unknown): v is NoteKind {
  return (
    v === "cnv" ||
    v === "rul" ||
    v === "wrn" ||
    v === "dec" ||
    v === "blk" ||
    v === "fct"
  );
}

export function isValidAnchorType(v: unknown): v is NoteAnchorType {
  return v === "f" || v === "e" || v === "g" || v === "p";
}

export function isValidPolarity(v: unknown): v is NotePolarity {
  return v === "+" || v === "-" || v === "~";
}

/** Cold-start detector — true when the candidate note is recognizably
 *  system-internal or smoke-test rather than user-stored personalized memory.
 *  Strict on purpose: we don't want to suppress a legitimate user-set
 *  project-wide fact, only obvious system artefacts. */
export function isColdStartNote(note: LoadedNoteFields): boolean {
  if (note.anchor_type !== "p") return false;
  if (note.reinforcement_count > 0) return false;
  if (note.kind !== "fct") return false;
  return SYSTEM_NOTE_SIGNATURE.test(note.content);
}

/**
 * Render the Surface 2 `loaded …` line. Returns the bare line (no `unerr »`
 * prefix — the caller adds it via `buildUserBlock`). Returns null when
 * there is literally nothing user-meaningful to say (no note AND no top
 * file primed).
 *
 * Forms:
 *   - Populated note:
 *       `loaded a rule you wrote 2d ago for src/proxy/bridge.ts: "no intelligence imports"`
 *   - Populated + reinforced + file-also-primed:
 *       `loaded a convention you wrote 1mo ago for src/proxy/proxy.ts (reinforced 4×): "always await db.run" · also primed src/proxy/router-gateway.ts`
 *   - Cold-start:
 *       `nothing project-specific stored yet — say "remember <rule>" to teach unerr your rules`
 *   - File-only (no note recalled):
 *       `primed src/proxy/handler.ts`
 *   - Anchor missing:
 *       `loaded a warning you wrote 5d ago for src/legacy/old.ts (file no longer in repo): "no callers expected"`
 *   - Conflict:
 *       `loaded a rule you wrote 3d ago for src/x.ts: "use the new API" · ⚠ conflicting note exists`
 */
export function renderLoadedNoteLine(
  input: RenderLoadedNoteInput
): string | null {
  const { note, topFile, nowMs } = input;
  const now = nowMs ?? Date.now();

  // ── No note path ────────────────────────────────────────────────────
  if (note === null) {
    if (typeof topFile === "string" && topFile.length > 0) {
      return `primed ${shortPath(topFile)}`;
    }
    return null;
  }

  // ── Cold-start guided empty state ──────────────────────────────────
  // The smoke-test artefact case from #35-verification ships with every
  // fresh install; surfacing it as "you set …" reads as deceptive. Replace
  // with a guided next-action that gives the user a way in.
  if (isColdStartNote(note)) {
    return 'nothing project-specific stored yet — say "remember <rule>" to teach unerr your rules';
  }

  // ── Populated note ──────────────────────────────────────────────────
  const kindLabel = KIND_LABEL[note.kind];
  const article = /^[aeiou]/i.test(kindLabel) ? "an" : "a";
  const when = formatRelativeAge(note.created_at, now);
  const forClause = anchorPhrase(
    note.anchor_type,
    note.anchor_value,
    note.anchor_missing
  );
  const polTail = polaritySuffix(note.kind, note.polarity);
  const reinforced = reinforcementBadge(note.reinforcement_count);
  const content = clipContent(note.content);

  // Lead: "loaded a rule you wrote 2d ago for src/x.ts (reinforced 4×)"
  const leadParts: string[] = [`loaded ${article} ${kindLabel}${polTail}`];
  leadParts.push(`you wrote ${when}`);
  if (forClause) leadParts.push(forClause);
  const lead = leadParts.join(" ") + reinforced;

  let line = `${lead}: "${content}"`;

  // Conflict tail — surface the existence of an opposing note so the user
  // knows to spot-check, but don't dump the conflicting content here.
  if (note.conflict_group_id && note.conflict_group_id.length > 0) {
    line += " · ⚠ conflicting note exists";
  }

  // Top-file secondary signal: only when the file primed this turn is NOT
  // already named by the note's anchor (avoids "for src/x.ts: … · also
  // primed src/x.ts" redundancy).
  if (typeof topFile === "string" && topFile.length > 0) {
    const anchorNamesFile =
      note.anchor_type === "f" && note.anchor_value === topFile;
    if (!anchorNamesFile) {
      line += ` · also primed ${shortPath(topFile)}`;
    }
  }

  return line;
}

/**
 * CLAUDE.md project-notes mirror — Sprint C item 8, §11.3.
 *
 * The agent calls `unerr_remember({type:"promote_to_claude_md", note_ids[]})`
 * at end-of-session for `p:`-anchored notes the user agreed to promote.
 * This module writes a sentinel-block into CLAUDE.md idempotently.
 *
 * Sentinel format mirrors the existing instruction-writer convention
 * (`<!-- unerr:start -->` / `<!-- unerr:end -->`) but with a different
 * tag so the two blocks coexist:
 *
 *   <!-- unerr:project-notes -->
 *   ...one bullet per note, anchored + cited by note_id...
 *   <!-- unerr:project-notes:end -->
 *
 * Idempotency:
 *   - If the block exists, it is replaced wholesale (notes are the
 *     canonical source; the block is a projection).
 *   - If absent, it is appended to the file with a leading newline.
 *   - Anything outside the sentinel block is never touched.
 *
 * The note loader is injected so this module stays decoupled from
 * NotesStore — the proxy passes a callback that resolves note_ids
 * to StoredNote rows.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StoredNote } from "./notes-store.js";

export const SENTINEL_OPEN = "<!-- unerr:project-notes -->";
export const SENTINEL_CLOSE = "<!-- unerr:project-notes:end -->";

export interface PromoteInput {
  /** Absolute or repo-relative path to CLAUDE.md. */
  claude_md_path: string;
  /** Notes to render. Caller filters by anchor_type === "p" if it wants. */
  notes: readonly StoredNote[];
}

export interface PromoteResult {
  /** How many bullets the new block contains. */
  written: number;
  /** Final path written. */
  path: string;
  /** "created" when no block existed; "replaced" when overwritten;
   *  "unchanged" when the new content matched the existing block. */
  outcome: "created" | "replaced" | "unchanged";
}

/** Render one note as a CLAUDE.md bullet. Pure. Stable formatting. */
export function renderNoteBullet(note: StoredNote): string {
  const anchorPart =
    note.anchor_type === "p" ? "project-wide" : `${note.anchor_type}:${note.anchor_value}`;
  const polarity =
    note.polarity === "+" ? "do" : note.polarity === "-" ? "don't" : "mixed";
  return `- [${note.kind}|${polarity}|${anchorPart}] ${note.content} <!-- ${note.note_id} -->`;
}

/** Render the sentinel-bounded block including a stable header line. */
export function renderBlock(notes: readonly StoredNote[]): string {
  const bullets = notes.map(renderNoteBullet).join("\n");
  const body =
    notes.length === 0
      ? "_(no promoted notes)_"
      : bullets;
  return `${SENTINEL_OPEN}\n## Project notes (synced from unerr)\n\n${body}\n${SENTINEL_CLOSE}`;
}

/**
 * Promote a set of notes into CLAUDE.md. Idempotent. Returns the outcome
 * the proxy can render in Surface 3 ("wrote 5 / replaced existing block /
 * already up to date").
 */
export function promoteNotesToClaudeMd(input: PromoteInput): PromoteResult {
  const path = resolve(input.claude_md_path);
  const block = renderBlock(input.notes);

  if (!existsSync(path)) {
    writeFileSync(path, `${block}\n`, "utf8");
    return {
      written: input.notes.length,
      path,
      outcome: "created",
    };
  }
  const current = readFileSync(path, "utf8");
  const existing = extractBlock(current);

  if (existing === null) {
    // Append the block to the end of the file with a leading newline so
    // it doesn't run into the previous content.
    const sep = current.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${current}${sep}\n${block}\n`, "utf8");
    return { written: input.notes.length, path, outcome: "created" };
  }

  if (existing === block) {
    return { written: input.notes.length, path, outcome: "unchanged" };
  }

  const updated = replaceBlock(current, block);
  writeFileSync(path, updated, "utf8");
  return { written: input.notes.length, path, outcome: "replaced" };
}

/** Return the existing block content (between sentinels, inclusive) or null. */
function extractBlock(source: string): string | null {
  const openIdx = source.indexOf(SENTINEL_OPEN);
  if (openIdx === -1) return null;
  const closeIdx = source.indexOf(SENTINEL_CLOSE, openIdx + SENTINEL_OPEN.length);
  if (closeIdx === -1) return null;
  return source.slice(openIdx, closeIdx + SENTINEL_CLOSE.length);
}

/** Replace the sentinel block in `source` with `newBlock`. Caller has verified existence. */
function replaceBlock(source: string, newBlock: string): string {
  const openIdx = source.indexOf(SENTINEL_OPEN);
  const closeIdx = source.indexOf(SENTINEL_CLOSE, openIdx + SENTINEL_OPEN.length);
  return (
    source.slice(0, openIdx) +
    newBlock +
    source.slice(closeIdx + SENTINEL_CLOSE.length)
  );
}

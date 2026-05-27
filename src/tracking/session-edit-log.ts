/**
 * Session edit log (P2.2).
 *
 * The record of file edits the incomplete-work reconciliation reads at session
 * end. The MCP shadow ledger CANNOT serve this: edits go through the agent's
 * own Edit/Write tools, not MCP, so they never reach the ledger (the root cause
 * that left incomplete-work dead). Instead the post-edit HOOK — which DOES see
 * every edit — appends here, and the session-end scan reconciles these events
 * against the blast-radius engine.
 *
 * Storage: append-only JSONL at `.unerr/state/session-edits.jsonl`. Scoped to a
 * proxy lifetime — cleared at boot ({@link clearEditLog}) so each session's scan
 * sees only its own edits. Best-effort throughout: a failed append or a corrupt
 * line never throws into the hook or the shutdown path.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

const EDIT_LOG_FILE = "session-edits.jsonl";
/** Cap retained events so a long session can't grow the file unbounded. */
const MAX_EDIT_EVENTS = 1000;
/** Cap stored content per side so a whole-file Write can't bloat the log. */
const MAX_CONTENT_CHARS = 8000;

export interface EditEvent {
  /** ISO-8601 timestamp of the edit. */
  ts: string;
  /** Repo-relative path of the edited file. */
  file_path: string;
  /** Pre-edit content (Edit `old_string`); null for a pure create. */
  old_content: string | null;
  /** Post-edit content (Edit `new_string`); null for a pure delete. */
  new_content: string | null;
}

export function editLogPath(unerrDir: string): string {
  return join(unerrDir, "state", EDIT_LOG_FILE);
}

function cap(content: string | null): string | null {
  if (content === null) return null;
  return content.length > MAX_CONTENT_CHARS
    ? content.slice(0, MAX_CONTENT_CHARS)
    : content;
}

/**
 * Append one edit event. Best-effort: creates `state/` if missing, truncates
 * oversized content, and swallows every error so the post-edit hook is never
 * disrupted. Returns true only when the line was written.
 */
export function recordEdit(unerrDir: string, event: EditEvent): boolean {
  try {
    const path = editLogPath(unerrDir);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({
      ts: event.ts,
      file_path: event.file_path,
      old_content: cap(event.old_content),
      new_content: cap(event.new_content),
    })}\n`;
    appendFileSync(path, line, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read recorded edit events, most-recent-capped to {@link MAX_EDIT_EVENTS}.
 * Tolerates a partially-written trailing line. Returns `[]` on any error or a
 * missing log.
 */
export function readEditLog(unerrDir: string): EditEvent[] {
  try {
    const path = editLogPath(unerrDir);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
    const events: EditEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as EditEvent;
        if (parsed && typeof parsed.file_path === "string") events.push(parsed);
      } catch {
        // Skip a corrupt / partially-flushed line.
      }
    }
    return events.length > MAX_EDIT_EVENTS
      ? events.slice(events.length - MAX_EDIT_EVENTS)
      : events;
  } catch {
    return [];
  }
}

/** Delete the edit log. Best-effort; called at proxy boot to scope per-session. */
export function clearEditLog(unerrDir: string): void {
  try {
    rmSync(editLogPath(unerrDir), { force: true });
  } catch {
    // Best-effort — a stale log only causes mild over-flagging next scan.
  }
}

/**
 * Session edit log (P2.2).
 *
 * The record of file edits the incomplete-work reconciliation reads at session
 * end, and the verify-awareness Stop gate ({@link readEditLogSince}) reads to
 * detect native-tool edits. The MCP shadow ledger CANNOT serve either: edits go
 * through the agent's own Edit/Write tools, not MCP, so they never reach the
 * ledger (the root cause that left incomplete-work dead and let the verify
 * gate miss native edits). Instead the post-edit HOOK — which DOES see every
 * edit — appends here, and readers reconcile against their own turn/entity
 * boundaries.
 *
 * Storage: append-only JSONL at `.unerr/state/session-edits.jsonl`. Scoped to a
 * proxy lifetime — cleared at boot ({@link clearEditLog}) so each session's scan
 * sees only its own edits. Best-effort throughout: a failed append or a corrupt
 * line never throws into the hook or the shutdown path.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

const EDIT_LOG_FILE = "session-edits.jsonl";
/** Cap retained events so a long session can't grow the file unbounded. */
const MAX_EDIT_EVENTS = 1000;
/** Cap stored content per side so a whole-file Write can't bloat the log. */
const MAX_CONTENT_CHARS = 8000;
/** Cap the tail read for {@link readEditLogSince} so a long-lived proxy
 *  session's ledger is never fully slurped into memory. */
const MAX_TAIL_BYTES = 262_144;

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

/**
 * Read only the ledger rows whose `ts` is at or after `sinceTs` (epoch ms).
 * The verify-awareness Stop gate (`turnVerifyStatus` in stop-hooks.ts) uses
 * this to see native Write/Edit edits — which never emit a `code_edit_applied`
 * named event — without re-reading a long-lived session's entire ledger: only
 * the last {@link MAX_TAIL_BYTES} of the file are read, then lines are parsed
 * from the tail backward and scanning stops the moment a row's timestamp
 * falls before `sinceTs` (the log is append-only chronological, so everything
 * earlier is too old). Skips an individual malformed line rather than
 * aborting the read. Returns `[]` for a missing/unreadable file, a
 * non-positive `sinceTs`, or any error.
 */
export function readEditLogSince(
  unerrDir: string,
  sinceTs: number
): EditEvent[] {
  if (!Number.isFinite(sinceTs) || sinceTs <= 0) return [];
  const path = editLogPath(unerrDir);
  let fd = -1;
  try {
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    if (size === 0) return [];
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const length = size - start;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    const lines = buf.toString("utf-8").split("\n");
    // A byte-offset tail read can begin mid-line; drop the partial leading
    // fragment unless the read started at byte 0.
    if (start > 0 && lines.length > 0) lines.shift();

    const matched: EditEvent[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]?.trim();
      if (!trimmed) continue;
      let parsed: EditEvent | null = null;
      try {
        const candidate = JSON.parse(trimmed) as EditEvent;
        if (candidate && typeof candidate.file_path === "string") {
          parsed = candidate;
        }
      } catch {
        continue; // Skip a corrupt line; keep scanning further back.
      }
      if (!parsed) continue;
      const t = Date.parse(parsed.ts);
      if (!Number.isFinite(t)) continue;
      if (t < sinceTs) break; // Everything earlier in the log is also stale.
      matched.push(parsed);
    }
    return matched.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
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

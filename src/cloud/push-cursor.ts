/**
 * unerr cloud — per-repo push cursor.
 *
 * The push pipeline does NOT keep a second copy of the events it sends. The
 * local stores (`metrics.db`, `shadow.jsonl`, `router/metrics.jsonl`) already
 * hold every row; this cursor is the only new state — a small watermark per
 * stream recording how far the daemon has drained. On the next tick the drain
 * loop reads each store *from the cursor forward*, pushes, and advances the
 * watermark only after a `2xx`. At-least-once delivery plus a stable per-row
 * `event_id` (server-side `ReplacingMergeTree` + dedup token) makes the whole
 * pipeline effectively exactly-once with zero loss.
 *
 * One file per repo at `.unerr/state/push-cursor.json`, written only by the
 * single `unerrd` drain loop — no cross-process contention. Saves are atomic
 * (temp file + rename) so a crash mid-write can never corrupt the watermark.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Path of the cursor file inside a repo's `.unerr` dir. */
function cursorPath(unerrDir: string): string {
  return join(unerrDir, "state", "push-cursor.json");
}

/**
 * A stream's drained position. `lastId` is the highest `metrics.db` rowid
 * drained (the `*Since(lastId)` watermark); `lastIndex` is the count of
 * append-log lines already drained (`shadow.jsonl`, router jsonl). A stream
 * uses whichever one fits its store; both may be absent before the first drain.
 */
export interface CursorPos {
  lastId?: number;
  lastIndex?: number;
}

/** A stream's cursor: its drained position plus its dead-letter tally (B7). */
export interface StreamCursor extends CursorPos {
  /** Permanently-rejected rows the loop skipped past rather than re-push. */
  deadLetters?: number;
}

/** On-disk shape. `version` guards a future format change (pre-release: just 1). */
interface CursorFile {
  version: 1;
  streams: Record<string, StreamCursor>;
}

/**
 * The drained-watermark for one repo, loaded from and saved to
 * `.unerr/state/push-cursor.json`. Mutations are in-memory; call `save()` once
 * per drain tick after advancing the streams that succeeded.
 *
 * // @sem domain=cloud role=cursor
 */
export class PushCursor {
  private readonly file: string;
  private readonly streams: Record<string, StreamCursor>;

  private constructor(file: string, streams: Record<string, StreamCursor>) {
    this.file = file;
    this.streams = streams;
  }

  /**
   * Load a repo's cursor. A missing or unreadable/corrupt file starts empty —
   * the drain loop then re-reads from the head of each store, which the
   * server's per-row dedup collapses, so a lost cursor costs bandwidth, never
   * correctness.
   *
   * // @sem domain=cloud role=cursor
   */
  static async open(unerrDir: string): Promise<PushCursor> {
    const file = cursorPath(unerrDir);
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as CursorFile;
      const streams =
        parsed && typeof parsed === "object" && parsed.streams
          ? parsed.streams
          : {};
      return new PushCursor(file, streams);
    } catch {
      return new PushCursor(file, {});
    }
  }

  /** The drained position for a stream (empty object before its first drain). */
  position(streamKey: string): CursorPos {
    const s = this.streams[streamKey];
    if (!s) return {};
    const { deadLetters: _dl, ...pos } = s;
    return pos;
  }

  /**
   * Advance a stream's watermark after a successful push. Only the keys present
   * in `pos` move, so a row-id stream and a line-index stream each touch their
   * own field; the dead-letter tally is preserved.
   *
   * // @sem domain=cloud role=cursor
   */
  advance(streamKey: string, pos: CursorPos): void {
    const prev = this.streams[streamKey] ?? {};
    this.streams[streamKey] = {
      ...prev,
      ...(pos.lastId !== undefined ? { lastId: pos.lastId } : {}),
      ...(pos.lastIndex !== undefined ? { lastIndex: pos.lastIndex } : {}),
    };
  }

  /** Drop a stream's cursor entirely. Used when its per-pid segment is reaped, so
   *  a future segment that reuses the same pid drains from the head rather than
   *  being skipped past by a stale offset. */
  forget(streamKey: string): void {
    delete this.streams[streamKey];
  }

  /** Record `n` permanently-rejected rows for a stream (B7 dead-letter count). */
  addDeadLetters(streamKey: string, n: number): void {
    if (n <= 0) return;
    const prev = this.streams[streamKey] ?? {};
    this.streams[streamKey] = {
      ...prev,
      deadLetters: (prev.deadLetters ?? 0) + n,
    };
  }

  /** Total dead letters across every stream — surfaced by `unerr status` (B7). */
  deadLetterTotal(): number {
    let total = 0;
    for (const s of Object.values(this.streams)) total += s.deadLetters ?? 0;
    return total;
  }

  /**
   * Persist the cursor atomically: write a sibling temp file, then rename over
   * the real one (rename is atomic on the same filesystem), so a crash leaves
   * either the old watermark or the new one — never a half-written file.
   *
   * // @sem domain=cloud role=cursor
   */
  async save(): Promise<void> {
    const data: CursorFile = { version: 1, streams: this.streams };
    const json = `${JSON.stringify(data, null, 2)}\n`;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.file);
  }
}

/**
 * unerr tracking — per-session transcript byte-offset cursor store.
 *
 * The daemon reads each agent transcript file incrementally: it remembers how
 * far into the file it has already materialized and, on the next tick, reads
 * only the bytes that were appended since. A 22 MB file that grew by 30 KB
 * costs ~30 KB of reads, not 22 MB. This cursor is the only new persistent
 * state for the transcript-streaming pipeline — the transcript bytes
 * themselves live on disk where the agent wrote them.
 *
 * One file per repo at `.unerr/transcripts/offsets.json`. Saves are atomic
 * (temp file + rename, atomic on the same filesystem) so a crash mid-write can
 * never leave a half-written offset file.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Path of the offsets file inside a repo's `.unerr` dir. */
function offsetsPath(unerrDir: string): string {
  return join(unerrDir, "transcripts", "offsets.json");
}

/**
 * One session's incremental-read position: how far into its transcript file the
 * daemon has materialized, plus the file identity it was reading and the running
 * conversational-turn counter.
 *
 */
export interface TranscriptOffset {
  byteOffset: number;
  inode: number | null; // fs inode of the file this offset refers to
  lastConvTurn: number; // running conversational-turn counter (increments per user message)
}

/** On-disk shape. `version` guards a future format change (pre-release: just 1). */
interface OffsetFile {
  version: 1;
  sessions: Record<string, TranscriptOffset>;
}

/**
 * The per-session transcript offsets for one repo, loaded from and saved to
 * `.unerr/transcripts/offsets.json`. Mutations are in-memory; call `save()`
 * once after advancing the sessions that were drained this tick.
 *
 */
export class TranscriptOffsetStore {
  private readonly file: string;
  private readonly sessions: Record<string, TranscriptOffset>;

  private constructor(
    file: string,
    sessions: Record<string, TranscriptOffset>
  ) {
    this.file = file;
    this.sessions = sessions;
  }

  /**
   * Load a repo's offset store. A missing or unreadable/corrupt file starts
   * empty — the daemon then re-reads each transcript from the head, which costs
   * bandwidth on the next tick but never loses or duplicates materialized turns
   * (the file identity and turn counter are re-derived on read).
   *
   */
  static async open(unerrDir: string): Promise<TranscriptOffsetStore> {
    const file = offsetsPath(unerrDir);
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as OffsetFile;
      const sessions =
        parsed && typeof parsed === "object" && parsed.sessions
          ? parsed.sessions
          : {};
      return new TranscriptOffsetStore(file, sessions);
    } catch {
      return new TranscriptOffsetStore(file, {});
    }
  }

  /** The stored offset for a session (`undefined` before its first read). */
  get(sessionId: string): TranscriptOffset | undefined {
    return this.sessions[sessionId];
  }

  /** Record a session's offset after a successful incremental read. */
  set(sessionId: string, entry: TranscriptOffset): void {
    this.sessions[sessionId] = entry;
  }

  /** Drop a session's offset entirely (e.g. its transcript file was removed). */
  forget(sessionId: string): void {
    delete this.sessions[sessionId];
  }

  /**
   * Persist the store atomically: write a sibling temp file, then rename over
   * the real one (rename is atomic on the same filesystem), so a crash leaves
   * either the old offsets or the new ones — never a half-written file.
   *
   */
  async save(): Promise<void> {
    const data: OffsetFile = { version: 1, sessions: this.sessions };
    const json = `${JSON.stringify(data, null, 2)}\n`;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.file);
  }
}

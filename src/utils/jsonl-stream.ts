/**
 * Stream complete JSON lines from a byte offset forward WITHOUT loading the whole
 * file. The general primitive for incrementally draining a large append-only
 * JSONL — agent transcripts, or any object that grows large and is read often: a
 * 22 MB file that grew by 30 KB costs ~30 KB of reads, not 22 MB. Torn-line safe
 * (a partial trailing line is never consumed, so the offset re-reads it intact
 * next pass) and cap-bounded (`maxRows` / `maxBytes`) so one pass never reads an
 * unbounded tail of a huge file.
 *
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/** Per-read caps so a single pass never builds an unbounded batch. */
export interface JsonlSliceCaps {
  /** Stop after this many parsed rows. */
  maxRows?: number;
  /** Stop once the consumed byte span from the start offset would exceed this. */
  maxBytes?: number;
}

/** A slice of a JSONL file read forward from a byte offset. */
export interface JsonlSlice {
  /** Parsed objects for each COMPLETE line consumed after the offset. */
  rows: unknown[];
  /** Byte offset past the last fully-consumed line — the new watermark. A
   *  partial trailing line is excluded, so it is re-read intact next pass. */
  nextOffset: number;
  /** True when the file was shorter than the offset (rotated/replaced) and the
   *  read restarted at 0 — the caller must reset any derived per-file state. */
  restarted: boolean;
}

/**
 * Read complete JSON lines from `byteOffset` forward, streaming only the new
 * bytes off disk. Never throws — a missing/unreadable file yields an empty slice
 * at the same offset. A line that fails to parse is skipped but still counted
 * toward the offset (it will never parse, so re-reading it is pointless). Caps
 * bound the batch but only AFTER one row is in, so an oversized lead line always
 * advances the cursor rather than sticking it.
 */
export async function streamJsonlFrom(
  filePath: string,
  byteOffset: number,
  caps: JsonlSliceCaps = {}
): Promise<JsonlSlice> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return { rows: [], nextOffset: byteOffset, restarted: false };
  }

  // The file shrank below our cursor (rotation/replace) — restart from the head.
  const restarted = byteOffset > size;
  const start = restarted ? 0 : byteOffset;
  if (start >= size) return { rows: [], nextOffset: start, restarted };

  const maxRows = caps.maxRows ?? Number.POSITIVE_INFINITY;
  const maxBytes = caps.maxBytes ?? Number.POSITIVE_INFINITY;

  return await new Promise<JsonlSlice>((resolve) => {
    const rows: unknown[] = [];
    let leftover: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let leftoverBase = start; // file offset of leftover[0]
    let consumed = start; // file offset past the last accepted complete line
    let done = false;

    const stream = createReadStream(filePath, { start });
    const settle = () => {
      if (done) return;
      done = true;
      stream.destroy();
      resolve({ rows, nextOffset: consumed, restarted });
    };

    stream.on("data", (chunk: string | Buffer<ArrayBufferLike>) => {
      if (done) return;
      const c: Buffer<ArrayBufferLike> =
        typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const buf: Buffer<ArrayBufferLike> =
        leftover.length > 0 ? Buffer.concat([leftover, c]) : c;
      const base = leftoverBase; // file offset of buf[0]
      let lineStart = 0;
      let nl = buf.indexOf(0x0a, lineStart);
      while (nl >= 0) {
        const lineEndFile = base + nl + 1;
        // Caps bound the batch — but only once at least one row is in, so the
        // cursor always advances past an oversized lead line rather than sticking.
        if (
          rows.length > 0 &&
          (rows.length >= maxRows || lineEndFile - start > maxBytes)
        ) {
          // Keep this line in leftover so it is consumed next pass.
          leftover = buf.subarray(lineStart);
          leftoverBase = base + lineStart;
          settle();
          return;
        }
        const text = buf.subarray(lineStart, nl).toString("utf8").trim();
        if (text.length > 0) {
          try {
            rows.push(JSON.parse(text));
          } catch {
            // Torn/corrupt line — skip it; the offset still advances past it.
          }
        }
        consumed = lineEndFile;
        lineStart = nl + 1;
        nl = buf.indexOf(0x0a, lineStart);
      }
      leftover = buf.subarray(lineStart);
      leftoverBase = base + lineStart;
    });

    stream.on("end", settle);
    stream.on("error", settle);
  });
}

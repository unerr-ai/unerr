/**
 * The per-repo telemetry event store — `<repo>/.unerr/events/`. A 7-day,
 * append-only, segment-per-writer JSONL buffer that every producer (proxy,
 * bridge) writes contract-shaped `IngestEvent` lines into; `unerrd` drains it to
 * the cloud from a per-segment byte offset (see the queue in `src/daemon/`).
 *
 * Zero native dependency by design: a `better-sqlite3` driver-install failure
 * silently blanks `metrics.db`, so the telemetry path moves to plain
 * `appendFileSync` (`O_APPEND`) which cannot blank on a missing binary. Imports
 * only node builtins — safe to load from the bridge (no intelligence/tracking).
 *
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { IngestEventInput } from "@unerr-ai/contracts/ingest";

/** A telemetry event before it is written: the full contract-shaped union. */
export type StoredEvent = IngestEventInput;

/** How long a line survives in the store before the rolling sweep drops it. */
export const EVENT_RETENTION_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

/**
 * Age at which the daemon force-parks a still-un-acked event (L4 spillover):
 * one day strictly BELOW {@link EVENT_RETENTION_MS}. A row that delivery kept
 * failing on is stamped `mode:"park"` and accept-and-parked server-side a full
 * day before the rolling 7-day sweep could drop it un-delivered — the never-drop
 * guarantee. Must stay `< EVENT_RETENTION_MS` so park always wins the race.
 */
export const PARK_AGE_MS = EVENT_RETENTION_MS - 24 * 60 * 60 * 1000; // 4 days

/** The per-repo events directory: `<repo>/.unerr/events`. */
export function eventsDir(repoRoot: string): string {
  return join(repoRoot, ".unerr", "events");
}

/**
 * The machine-level event root — the home directory, so its store resolves to
 * `~/.unerr/events`. Fleet events (`machine_inventory` / `machine_checkin`) have
 * no repo, so they ride this segment store and the daemon drains it once per
 * machine, exactly as it drains each repo. Reuses every per-repo primitive
 * (`appendEvent`, `listSegments`, `readSegmentFrom`) with `homedir()` as the
 * root — no separate machine code path.
 */
export function machineEventsRoot(): string {
  return homedir();
}

/**
 * Path of one writer's segment. Each writer owns exactly one file so appends
 * never interleave and need no lock: the per-repo proxy writes `proxy.jsonl`;
 * each bridge process writes `mcp-<pid>.jsonl` (its pid IS its identity).
 */
export function segmentPath(repoRoot: string, segment: string): string {
  return join(eventsDir(repoRoot), `${segment}.jsonl`);
}

/** The proxy's segment name. */
export const PROXY_SEGMENT = "proxy";

/** A bridge process's segment name, keyed by its pid. */
export function bridgeSegment(pid: number): string {
  return `mcp-${pid}`;
}

/**
 * A hook process's segment name, keyed by its pid. Hooks (turn-end transcript
 * materialize, prompt capture) run in their own short-lived process where the
 * proxy's ambient emit context is never installed, so they `enqueue` to this
 * own segment — never the proxy's, preserving the one-writer-per-segment append
 * invariant. The daemon drains it like any other `*.jsonl`.
 */
export function hookSegment(pid: number): string {
  return `hook-${pid}`;
}

/**
 * The pid embedded in a per-pid segment path (`hook-<pid>` / `mcp-<pid>`), or
 * null for the proxy / fleet segments and anything else. Lets the drain-loop
 * reaper tell whether a fully-drained segment's writer process has exited, so a
 * dead process's segment can be removed without touching a live writer's.
 */
export function segmentPidFromPath(filePath: string): number | null {
  const stem = basename(filePath).replace(/\.jsonl$/, "");
  const m = stem.match(/^(?:hook|mcp)-(\d+)$/);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The machine-level fleet segment under `~/.unerr/events/fleet.jsonl`. */
export const FLEET_SEGMENT = "fleet";

/** Path of the monotonic seq counter file (replaces the SQLite rowid). */
export function seqPath(repoRoot: string): string {
  return join(eventsDir(repoRoot), "seq.json");
}

/** Create the events directory if absent. Idempotent. */
export function ensureEventsDir(repoRoot: string): void {
  const dir = eventsDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Return the next monotonic sequence number for this repo and persist the
 * advance. Replaces SQLite's auto-increment rowid as the producer-side ordering
 * key. Best-effort durability: written with a temp-file rename so a crash
 * mid-write leaves the prior value, never a torn file. A reset to 0 (deleted
 * file) only re-uses numbers within a window the cloud already dedups by
 * `event_id`, so it is harmless.
 */
export function nextSeq(repoRoot: string): number {
  ensureEventsDir(repoRoot);
  const path = seqPath(repoRoot);
  let current = 0;
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { seq?: number };
      if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) {
        current = parsed.seq;
      }
    } catch {
      // Corrupt counter — restart from 0; event_id dedup absorbs the collision.
      current = 0;
    }
  }
  const next = current + 1;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ seq: next }), "utf8");
  renameSync(tmp, path);
  return next;
}

/**
 * Append one already-stamped, contract-shaped event to a writer's segment as a
 * single JSON line. One writer per segment file means `O_APPEND` is atomic for
 * the line (well under PIPE_BUF) — no lock, no torn interleave. Fire-and-forget:
 * a telemetry write must never throw on the agent's hot path, so an I/O failure
 * is swallowed (the event is lost only if the disk itself fails).
 */
export function appendEvent(
  repoRoot: string,
  segment: string,
  event: StoredEvent
): void {
  try {
    ensureEventsDir(repoRoot);
    appendFileSync(
      segmentPath(repoRoot, segment),
      `${JSON.stringify(event)}\n`
    );
  } catch {
    // Swallow — telemetry is best-effort and must not surface on the hot path.
  }
}

/** All segment files in this repo's store (the `*.jsonl`, not `seq.json`). */
export function listSegments(repoRoot: string): string[] {
  const dir = eventsDir(repoRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/** A slice of a segment read forward from a byte offset, plus the new offset. */
export interface SegmentSlice {
  /** Parsed events for each complete line read after the offset. */
  events: StoredEvent[];
  /** Byte offset of the end of the last COMPLETE line consumed — the new
   *  watermark. With a cap set, stops at the last line that fit the cap. */
  nextOffset: number;
}

/** Caps for one read, so the drain never builds a batch the server rejects. */
export interface ReadCaps {
  /** Stop after this many parsed events (server's per-batch row cap). */
  maxEvents?: number;
  /** Stop once the consumed byte span would exceed this (server's body cap). */
  maxBytes?: number;
}

/**
 * Read complete JSON lines from `byteOffset` forward (the forward-only offset
 * watermark the drain advances on ack). A partial trailing line — a writer
 * crashed or is mid-append — is NOT consumed: `nextOffset` stops at the end of
 * the last complete line, so the partial line is re-read intact next tick. A
 * line that fails to parse is skipped but still counted toward the offset (it
 * will never parse, so re-reading it is pointless). If the file shrank below
 * `byteOffset` (rotation/sweep), reading restarts from 0.
 *
 * With `caps` set, the read stops at the last complete line that fits the row /
 * byte cap and `nextOffset` lands exactly there — so the drain resumes from the
 * first un-pushed line next batch. At least one line is always consumed (even if
 * it alone exceeds the byte cap) so the cursor can never stick.
 */
export function readSegmentFrom(
  filePath: string,
  byteOffset: number,
  caps: ReadCaps = {}
): SegmentSlice {
  if (!existsSync(filePath)) return { events: [], nextOffset: byteOffset };

  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    return { events: [], nextOffset: byteOffset };
  }

  // The segment was rotated/swept and is now shorter than our cursor — restart.
  const start = byteOffset > buf.length ? 0 : byteOffset;

  const lastNewline = buf.lastIndexOf(0x0a); // "\n"
  if (lastNewline < start) {
    // No complete line after the offset yet.
    return { events: [], nextOffset: start };
  }

  const maxEvents = caps.maxEvents ?? Number.POSITIVE_INFINITY;
  const maxBytes = caps.maxBytes ?? Number.POSITIVE_INFINITY;
  const events: StoredEvent[] = [];
  let pos = start; // running scan cursor
  let consumed = start; // offset past the last fully-accepted line

  while (pos <= lastNewline) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0 || nl > lastNewline) break;
    const lineEnd = nl + 1; // include the newline in the consumed span
    // Caps bound the batch — but only once at least one line is in, so the
    // cursor always advances past an oversized lead line rather than sticking.
    if (consumed > start) {
      if (events.length >= maxEvents) break;
      if (lineEnd - start > maxBytes) break;
    }
    const line = buf.subarray(pos, nl).toString("utf8");
    if (line.length > 0) {
      try {
        events.push(JSON.parse(line) as StoredEvent);
      } catch {
        // Torn/corrupt line — skip it; the offset still advances past it.
      }
    }
    consumed = lineEnd;
    pos = lineEnd;
  }
  return { events, nextOffset: consumed };
}

/** Byte length of one segment — the drain's upper bound for a cursor. */
export function segmentSize(filePath: string): number {
  try {
    return existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

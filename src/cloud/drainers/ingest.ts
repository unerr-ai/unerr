/**
 * The single unified drainer (rev-3). One drainer per segment file in a repo's
 * `.unerr/events/` store: it reads contract-shaped `IngestEvent`s forward from a
 * byte-offset cursor and pushes them to `POST /api/v1/cli/ingest` via
 * `CloudClient.ingest`. It replaces the nine per-type drainers (events,
 * transcripts, ledger, router, review, sessions, facts, timeline, state) —
 * because every producer now stamps a contract-shaped event at emit (`enqueue`,
 * L1), the row→`detail` mapping that used to live in each drainer is gone, so
 * this drainer only forwards. The shared spine (`drainStream`) still validates
 * each row against `IngestEvent`, advances the cursor on ack, and dead-letters
 * poison — one machine-wide loop in `unerrd`, never the per-repo proxy.
 *
 * // @sem domain=cloud role=drainer
 */

import { truncateSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { INGEST_MAX_EVENTS_PER_BATCH } from "@unerr-ai/contracts/events";
import { IngestEvent } from "@unerr-ai/contracts/ingest";
import {
  PARK_AGE_MS,
  type StoredEvent,
  listSegments,
  readSegmentFrom,
  segmentPidFromPath,
  segmentSize,
} from "../../events/event-store.js";
import type { BatchAck, CloudResult } from "../client.js";
import type { CursorPos, PushCursor } from "../push-cursor.js";
import type {
  DrainerContext,
  DrainerSet,
  StreamBatch,
  StreamDrainer,
} from "../push-drainer.js";
import { stripCodeFromText } from "../strip-code.js";
import { sanitizeDetail } from "./envelope.js";

/**
 * Fleet events legitimately carry an absolute `path` (per-repo inventory), so
 * they are the one stream `sanitizeDetail` must NOT touch. They reach the cloud
 * via the daemon's FleetReporter, not this segment store, so this guard is a
 * belt-and-suspenders backstop in case a fleet event is ever segment-written.
 */
const FLEET_EVENT_TYPES = new Set(["machine_inventory", "machine_checkin"]);

/**
 * Run the HR-2 firewall over one row's `detail` just before push. The local
 * JSONL keeps the full detail (command / file / tee_file — the dashboard reads
 * them); this strips those path-ish keys so they never leave the machine. Fleet
 * rows pass through untouched. For a `transcript` row the open `detail.trace_text`
 * tail carries free agent prose that can quote raw code: that one value is run
 * through `stripCodeFromText` (fences / indented blocks / inline spans / long
 * minified runs → `[code removed]`) BEFORE push, so raw source never transits the
 * network — the key-denylist alone would not catch it because `trace_text` is not
 * a denylisted key. The server firewall (`stripCodeFromText` in the web-service)
 * is the backstop. Returns a fresh row — the stored line is never mutated, so the
 * cursor still advances by the original byte span.
 */
function sanitizeRowForPush(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const r = row as Record<string, unknown>;
  if (FLEET_EVENT_TYPES.has(r.type as string)) return row;
  const detail = r.detail;
  if (!detail || typeof detail !== "object") return row;
  const clean = sanitizeDetail(detail as Record<string, unknown>);
  // HR-2: code-strip the transcript's free trace_text client-side so raw code
  // never leaves the machine. sanitizeDetail key-denylists but does not scrub a
  // free-text value, and `trace_text` is intentionally not denylisted (it is the
  // legitimate prose channel), so the strip must run here on the value itself.
  if (r.type === "transcript" && typeof clean.trace_text === "string") {
    clean.trace_text = stripCodeFromText(clean.trace_text);
  }
  return { ...r, detail: clean };
}

/**
 * Per-batch byte budget — under the server's 256 KB body cap with headroom for
 * the `{events:[…]}` JSON envelope + gzip framing. A segment line's on-disk size
 * is its event's JSON length, so capping the consumed byte span here keeps the
 * pushed body under the wire limit without re-serializing to measure it.
 */
const BODY_BYTE_BUDGET = 240 * 1024;

/**
 * L4 spillover: force `mode:"park"` on an event the daemon still has not acked by
 * the time it nears the store's retention edge (age ≥ {@link PARK_AGE_MS}). The
 * server then accept-and-parks it for server-side triage rather than the rolling
 * 7-day sweep dropping it un-delivered. A fresh event (or one with no parseable
 * `ts`) is returned unchanged. Pure — never mutates the stored line, so the
 * cursor still advances by the original byte span. `now` is injected so the drain
 * seam stays deterministic in tests.
 */
export function parkIfStale(event: StoredEvent, now: number): StoredEvent {
  if ((event as { mode?: unknown }).mode === "park") return event;
  const at = Date.parse((event as { ts?: string }).ts ?? "");
  if (Number.isFinite(at) && now - at >= PARK_AGE_MS) {
    return { ...(event as object), mode: "park" } as StoredEvent;
  }
  return event;
}

/**
 * Stamp the drain-time repo/branch/commit envelope onto a row that lacks them
 * (fill-if-absent). Producers omit `repo` (the salted id needs an async git
 * call no hot path should pay) and most omit branch/commit, so the daemon — the
 * one place that holds the authoritative `ctx.repoId` and the per-tick git
 * branch/commit — fills them here, matching exactly the id the push attributes
 * under. A field a producer already set (e.g. the ledger's per-row branch) is
 * kept. Pure — never mutates the stored line, so the cursor still advances by
 * the original byte span.
 */
export function stampDrainContext(
  event: StoredEvent,
  ctx: DrainerContext
): StoredEvent {
  const e = event as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (e.repo === undefined && ctx.repoId) patch.repo = ctx.repoId;
  if (e.branch === undefined && ctx.branch) patch.branch = ctx.branch;
  if (e.commit === undefined && ctx.commit) patch.commit = ctx.commit;
  if (e.machine_fingerprint === undefined && ctx.machineFingerprint)
    patch.machine_fingerprint = ctx.machineFingerprint;
  return Object.keys(patch).length > 0
    ? ({ ...e, ...patch } as StoredEvent)
    : event;
}

/**
 * Cursor key + log label for one segment, e.g. `events:proxy` or
 * `events:mcp-4242`. Stable across ticks (keyed by the segment file stem) so the
 * forward-only byte offset persists per writer.
 */
export function segmentCursorKey(segmentFile: string): string {
  return `events:${basename(segmentFile).replace(/\.jsonl$/, "")}`;
}

/** Build the drainer for one segment file. Stateless — no handle to dispose. */
function makeSegmentDrainer(
  ctx: DrainerContext,
  segmentFile: string
): StreamDrainer {
  return {
    key: segmentCursorKey(segmentFile),
    // Validate every row against the full discriminated union before push; a row
    // that drifts from the contract drops (or throws under UNERR_CONTRACT_STRICT).
    schema: IngestEvent,
    async read(from: CursorPos): Promise<StreamBatch | null> {
      const offset = from.lastIndex ?? 0;
      const slice = readSegmentFrom(segmentFile, offset, {
        maxEvents: INGEST_MAX_EVENTS_PER_BATCH,
        maxBytes: BODY_BYTE_BUDGET,
      });
      if (slice.events.length === 0) return null;
      // Fill repo/branch/commit from the daemon's authoritative push context,
      // then L4-park any row still un-acked near the retention edge so it is
      // parked server-side before the rolling sweep could drop it. Both steps
      // are pure — the stored line is untouched, so the cursor advances by byte
      // span regardless.
      const now = Date.now();
      const rows = slice.events.map((e) =>
        parkIfStale(stampDrainContext(e, ctx), now)
      );
      return { rows, next: { lastIndex: slice.nextOffset } };
    },
    async push(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      return ctx.client.ingest(rows.map(sanitizeRowForPush));
    },
  };
}

/**
 * Assemble the unified drainers for one repo — one per segment file present in
 * `.unerr/events/` at this tick. New segments (a fresh `mcp-<pid>.jsonl`) are
 * picked up next tick; an empty / absent store yields no drainers. The daemon
 * scheduler runs each returned drainer through `drainRepo`.
 *
 * // @sem domain=cloud role=drainer
 */
export async function buildIngestDrainers(
  ctx: DrainerContext
): Promise<DrainerSet> {
  const drainers = listSegments(ctx.repoPath).map((seg) =>
    makeSegmentDrainer(ctx, seg)
  );
  // Coalesced pusher: identical to each segment drainer's own `push`, hoisted so
  // `drainRepo` can merge rows from every segment into the fewest combined POSTs.
  const pushCombined = (rows: unknown[]) =>
    ctx.client.ingest(rows.map(sanitizeRowForPush));
  return { drainers, pushCombined };
}

/**
 * Default liveness probe: `kill(pid, 0)` throws `ESRCH` when the process is gone.
 * `EPERM` means it exists but we can't signal it — still alive. Injectable so
 * tests need no real pids.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove fully-drained per-pid segments whose writer process has exited, and drop
 * their push cursors. Per-pid segments (`hook-<pid>`, `mcp-<pid>`) are created one
 * per short-lived hook / bridge process and never deleted by the 7-day sweep
 * (which only ages out lines), so they accumulate as 0-byte files the drain loop
 * re-lists every tick. A segment is safe to remove once it is fully drained
 * (cursor offset == file size) AND its pid is dead — it then holds nothing the
 * daemon still needs. Forgetting the cursor in the same pass means a future
 * segment that reuses the pid drains from the head instead of being skipped by a
 * stale offset. Call after `drainRepo`, before `cursor.save()`, so the forget is
 * persisted. Returns the number of segments reaped.
 *
 * // @sem domain=cloud role=drainer
 */
export function reapDrainedDeadSegments(
  repoPath: string,
  cursor: PushCursor,
  isAlive: (pid: number) => boolean = pidAlive
): number {
  let reaped = 0;
  for (const seg of listSegments(repoPath)) {
    const pid = segmentPidFromPath(seg);
    if (pid === null || isAlive(pid)) continue;
    const key = segmentCursorKey(seg);
    const drained = cursor.position(key).lastIndex ?? 0;
    if (drained < segmentSize(seg)) continue; // an unread tail remains
    try {
      unlinkSync(seg);
      cursor.forget(key);
      reaped += 1;
    } catch {
      // Best effort — a failed unlink just retries next tick.
    }
  }
  return reaped;
}

/**
 * Empty fully-drained long-lived segments and reset their cursor, so already-sent
 * telemetry does not linger on disk until age-out. These are the fixed-name
 * segments with NO owning pid (`proxy`, `transcript`, `fleet`); per-pid segments
 * are handled by {@link reapDrainedDeadSegments} instead (deleted on writer exit).
 *
 * A segment is truncated only when its cursor has reached the file's end — the
 * writer is caught up — so it fires in the quiet gaps between writes and never
 * races an active append. The fixed-name files have live writers (the proxy, the
 * daemon), and a forward-only `O_APPEND` writer is safe across a truncate-to-0:
 * the only theoretical loss is one best-effort telemetry line written in the
 * microsecond between the size check and the truncate, which `appendEvent`
 * already treats as loss-tolerant. Call after `drainRepo`, before `cursor.save()`
 * (same place as the reap), so the cursor reset is persisted. Returns the count.
 *
 * // @sem domain=cloud role=drainer
 */
export function truncateDrainedLongLivedSegments(
  repoPath: string,
  cursor: PushCursor
): number {
  let truncated = 0;
  for (const seg of listSegments(repoPath)) {
    if (segmentPidFromPath(seg) !== null) continue; // per-pid → reap handles it
    const key = segmentCursorKey(seg);
    const drained = cursor.position(key).lastIndex ?? 0;
    const size = segmentSize(seg);
    if (size === 0 || drained < size) continue; // empty, or an un-drained tail
    try {
      truncateSync(seg, 0);
      cursor.forget(key);
      truncated += 1;
    } catch {
      // Best effort — a failed truncate just retries next tick.
    }
  }
  return truncated;
}

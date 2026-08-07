/**
 * unerr cloud — the drain orchestration.
 *
 * The seam between the push spine (C0) and the per-stream readers (C1/C2). C0
 * owns the policy that is the same for every stream — the telemetry gate (B5),
 * advancing the cursor only after a `2xx`, and quarantining a poison batch as a
 * dead letter instead of hot-looping (B7). Each concrete `StreamDrainer` owns
 * only the two things that differ per stream: how to read its local store from
 * a cursor position, and which `CloudClient` method to push a batch through.
 *
 * Runs inside the `unerrd` daemon (one machine-wide loop), never the per-repo
 * proxy — see `src/daemon/` for the scheduler that calls `drainRepo` per repo.
 */

import { INGEST_MAX_EVENTS_PER_BATCH } from "@unerr-ai/contracts/events";
import { canPushTelemetry } from "../plan/entitlements.js";
import type { BatchAck, CloudClient, CloudResult } from "./client.js";
import { type ContractSchema, validateRows } from "./drainers/validate.js";
import type { CursorPos, PushCursor } from "./push-cursor.js";

/** A batch a drainer read from its store, plus the cursor to persist once acked. */
export interface StreamBatch {
  /** The wire rows to push (already mapped + code-stripped by the drainer). */
  rows: unknown[];
  /** Where the cursor moves after this batch is accepted. */
  next: CursorPos;
}

/**
 * One telemetry/sync stream's read+push logic. Implemented by C1 (events,
 * transcripts, ledger, router) and C2 (sessions, facts, timeline, state). The
 * drainer is responsible for capping each batch to its endpoint's row/byte
 * limit; `drainRepo` keeps calling `read` until it returns `null`.
 *
 */
export interface StreamDrainer {
  /** Cursor key + log label, unique per stream (e.g. `"events"`, `"ledger"`). */
  readonly key: string;
  /** Read the next batch after `from`, or `null` when nothing is pending. */
  read(from: CursorPos): Promise<StreamBatch | null>;
  /** Push one batch; returns the server's per-record ack. */
  push(rows: unknown[]): Promise<CloudResult<BatchAck>>;
  /**
   * The `@unerr-ai/contracts` body schema for one wire row of this stream (e.g.
   * `IngestEvent`, `TranscriptRecord`, `SessionRecord`). When set, `drainStream`
   * validates every row against it before push — the contract is the single
   * source of the wire shape, so a row that drifts from it is dropped (or, under
   * `UNERR_CONTRACT_STRICT=1`, throws) rather than shipped. Omit for a stream
   * with no contract body yet.
   */
  readonly schema?: ContractSchema;
}

/**
 * Everything a stream drainer needs to read one repo's local stores and push.
 * Built once per repo per drain tick by the daemon scheduler and handed to
 * {@link BuildDrainers}.
 *
 */
export interface DrainerContext {
  /** Absolute path of the repo being drained. */
  repoPath: string;
  /** The repo's `.unerr` directory — where state + jsonl event segments live. */
  unerrDir: string;
  /** Salted repo id for the wire envelope + the `sync/state?repo=` query param. */
  repoId: string;
  /** Authenticated client to push batches through. */
  client: CloudClient;
  /** The `source` envelope field, e.g. `"unerr-cli@0.2.11"`. */
  source: string;
  /** Repo's current git branch at drain time (OTel vcs.ref.head.name), or
   *  undefined outside a git repo. Streams whose source rows carry no per-row
   *  VCS (events/router/timeline) stamp this so every row has `where` context;
   *  the ledger uses its own per-row branch instead. */
  branch?: string;
  /** Repo's current git HEAD sha at drain time (OTel vcs.ref.head.revision), or
   *  undefined outside a git repo. Drain-time approximation for streams that do
   *  not record the commit per row. */
  commit?: string;
  /** Salted per-machine fingerprint (a one-way hash, never raw hardware), stamped
   *  onto every row that omits it so each stream is self-attributing to a machine
   *  even under a shared token — the machine-global analogue of `repo`. */
  machineFingerprint?: string;
  /** Optional structured logger (stderr) for build-time diagnostics. */
  log?: (msg: string) => void;
}

/**
 * The set of drainers for one repo plus an optional cleanup. C1/C2 open store
 * handles (JSONL event-store file descriptors) while building their
 * drainers; `dispose` releases them after the tick so nothing leaks per cycle.
 */
export interface DrainerSet {
  drainers: StreamDrainer[];
  dispose?: () => void | Promise<void>;
  /**
   * Push rows merged across this set's drainers in one request — passed to
   * {@link drainRepo} as `pushCombined` so a tick coalesces every stream into
   * the fewest POSTs. Built once per set because all rev-3 drainers push the
   * same `IngestEvent` union through one endpoint. Absent → per-stream pushes.
   */
  pushCombined?: (rows: unknown[]) => Promise<CloudResult<BatchAck>>;
}

/**
 * Assemble every stream drainer for one repo. C1 contributes the ClickHouse
 * streams (events, transcripts, ledger, router); C2 the relational ones
 * (sessions, facts, timeline, state). The daemon scheduler calls this per repo.
 */
export type BuildDrainers = (ctx: DrainerContext) => Promise<DrainerSet>;

/** Server cap: a decoded request body must stay under 256 KB (else `413`). */
export const MAX_BODY_BYTES = 256 * 1024;
/** Leave headroom under the hard cap for the JSON envelope + gzip framing. */
const BODY_BYTE_BUDGET = 240 * 1024;

/**
 * Trim `rows` to the largest prefix that fits BOTH the endpoint's row cap and
 * the 256 KB decoded-body cap, so a drainer never builds a batch the server
 * rejects with `413`. Returns at least one row even if that single row is over
 * budget (the server then rejects just that poison row, which `drainRepo`
 * dead-letters — better than a stuck cursor). Each row's size is measured as
 * its JSON byte length plus a small per-row separator allowance.
 *
 */
export function fitBatch<T>(
  rows: T[],
  maxCount: number,
  byteBudget: number = BODY_BYTE_BUDGET
): T[] {
  const fit: T[] = [];
  let bytes = 2; // the enclosing `[]`
  for (const row of rows) {
    if (fit.length >= maxCount) break;
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1; // + `,`
    if (fit.length > 0 && bytes + size > byteBudget) break;
    fit.push(row);
    bytes += size;
  }
  return fit;
}

/** Why a stream's drain ended this tick. */
export type DrainStatus =
  | "ok" // drained everything pending (or pushed at least one batch cleanly)
  | "empty" // nothing was pending
  | "skipped_gate" // not entitled to push telemetry (B5)
  | "network" // could not reach the cloud — retry next tick, cursor unmoved
  | "rate_limited" // 429/503 after the client's own retries — back off
  | "server_error" // 5xx or a read error — retry next tick, cursor unmoved
  | "dead_lettered"; // a poison batch was quarantined and the cursor advanced

/** What one stream did this tick. */
export interface DrainOutcome {
  stream: string;
  /** Rows the server accepted and stored. */
  pushed: number;
  /**
   * Rows the server could not process now but durably parked for server-side
   * replay (contract >= events 1-0-5). Delivered, not lost — the cursor advances
   * and these are never dead-lettered.
   */
  parked: number;
  /** Rows permanently rejected and skipped past (B7). */
  deadLettered: number;
  status: DrainStatus;
}

export interface DrainOptions {
  /** Clock for the gate check (tests pass a fixed value). */
  now?: number;
  /** Safety bound on batches drained per stream per tick (default 20). */
  maxBatchesPerStream?: number;
  /** Telemetry-entitlement check; defaults to {@link canPushTelemetry}. */
  isEntitled?: (now: number) => boolean;
  /** Optional structured logger (stderr). */
  log?: (msg: string) => void;
  /**
   * Coalesced push: send rows merged from MANY streams in one request. When set,
   * {@link drainRepo} bin-packs whole per-stream batches into combined
   * `≤INGEST_MAX_EVENTS / ≤256 KB` POSTs and maps the ack back to each stream by
   * `event_id` — turning N per-stream POSTs into ⌈total/100⌉ (usually one). All
   * rev-3 segment drainers push the same `IngestEvent` union through one
   * endpoint, so a single combined push is equivalent to each stream's own.
   * Omit it (tests with heterogeneous mock pushers) to keep the per-stream path.
   */
  pushCombined?: (rows: unknown[]) => Promise<CloudResult<BatchAck>>;
  /** Max events per combined POST; defaults to {@link INGEST_MAX_EVENTS_PER_BATCH}. */
  maxEventsPerBatch?: number;
}

/**
 * Drain every stream for one repo, advancing its cursor as batches are acked.
 * Best-effort: a failure on one stream never throws and never blocks the next.
 * The caller persists the cursor (`cursor.save()`) once after this returns.
 *
 * Fails CLOSED: `isEntitled` (default {@link canPushTelemetry}) must return
 * `true` before any stream is read. No verified paying-plan entitlement, an
 * expired one, the free plan, `UNERR_NO_TELEMETRY`/`DO_NOT_TRACK`, or a
 * machine-wide `telemetry: false` config key all make every stream come back
 * `skipped_gate` (the logged-out case is handled upstream by the absent
 * token). A per-repo `telemetry: false` in that repo's `.unerr/config.json`
 * is not visible here — this function has no `repoPath` — so the caller
 * (`PushReporter.drainOneRepo`) checks it before calling in.
 *
 */
export async function drainRepo(
  cursor: PushCursor,
  drainers: StreamDrainer[],
  opts: DrainOptions = {}
): Promise<DrainOutcome[]> {
  const now = opts.now ?? Date.now();
  const entitled = opts.isEntitled ?? canPushTelemetry;
  if (!entitled(now)) {
    return drainers.map((d) => ({
      stream: d.key,
      pushed: 0,
      parked: 0,
      deadLettered: 0,
      status: "skipped_gate" as const,
    }));
  }

  const maxBatches = opts.maxBatchesPerStream ?? 20;
  if (opts.pushCombined) {
    return drainRepoCoalesced(cursor, drainers, opts.pushCombined, {
      maxBatches,
      maxEvents: opts.maxEventsPerBatch ?? INGEST_MAX_EVENTS_PER_BATCH,
      log: opts.log,
    });
  }
  const outcomes: DrainOutcome[] = [];
  for (const drainer of drainers) {
    outcomes.push(await drainStream(cursor, drainer, maxBatches, opts.log));
  }
  return outcomes;
}

/** Drain a single stream until it is empty, fails, or hits the batch bound. */
async function drainStream(
  cursor: PushCursor,
  drainer: StreamDrainer,
  maxBatches: number,
  log?: (msg: string) => void
): Promise<DrainOutcome> {
  let pushed = 0;
  let parkedRows = 0;
  let deadLettered = 0;
  let status: DrainStatus = "empty";

  for (let i = 0; i < maxBatches; i++) {
    let batch: StreamBatch | null;
    try {
      batch = await drainer.read(cursor.position(drainer.key));
    } catch (err) {
      // A read failure is transient (locked db, partial write) — leave the
      // cursor and retry next tick.
      log?.(`push: ${drainer.key} read failed: ${errMessage(err)}`);
      status = "server_error";
      break;
    }

    if (!batch || batch.rows.length === 0) {
      // Nothing left. `ok` if we already pushed this tick, else `empty`.
      if (i > 0 && status !== "dead_lettered") status = "ok";
      break;
    }

    // Contract gate: validate each built row against its `@unerr-ai/contracts`
    // body before it leaves the machine (the contract is the single source of
    // the wire shape). Invalid rows are dropped + logged; under
    // `UNERR_CONTRACT_STRICT=1` the first mismatch throws (tests/CI).
    // `batch.next` is computed from the SOURCE rows, so the cursor advances
    // past dropped rows in every branch below — a dropped row is never re-read.
    const rows = drainer.schema
      ? validateRows(drainer.schema, batch.rows, drainer.key, log)
      : batch.rows;
    if (rows.length === 0) {
      // Every row in the batch failed contract validation. Treat it like a
      // server-side 4xx poison batch: dead-letter the source rows and advance
      // so the stream never hot-loops re-reading the same invalid rows.
      cursor.addDeadLetters(drainer.key, batch.rows.length);
      deadLettered += batch.rows.length;
      cursor.advance(drainer.key, batch.next);
      status = "dead_lettered";
      log?.(
        `push: ${drainer.key} all ${batch.rows.length} row(s) failed contract validation — dead-lettered`
      );
      continue;
    }

    const res = await drainer.push(rows);

    if (res.ok) {
      // Classify the ack. accept-and-park (contract >= events 1-0-5): the server
      // never permanently drops a row it merely cannot process now — it PARKS the
      // raw payload server-side for replay and reports it under `parked`. Parked
      // rows are durable (the server has them), so the cursor advances and they
      // are NOT dead-lettered. A `rejected` row is classified per result:
      //   - disposition "retryable" → transient server condition; hold the cursor
      //     and re-send the whole batch next tick (idempotent on event_id).
      //   - disposition "permanent" (or unspecified — the pre-1-0-5 default) →
      //     poison; dead-letter and advance so the loop never hot-loops on it.
      const parked = res.data?.parked ?? 0;
      const results = res.data?.results ?? [];
      let permanentRejected = 0;
      let retryableRejected = 0;
      for (const r of results) {
        if (r.status === "parked") {
          const parts = [`push: ${drainer.key} [warn] parked`];
          if (r.code) parts.push(r.code);
          if (r.field) parts.push(r.field);
          if (r.message) parts.push(r.message);
          log?.(parts.join(" · "));
        } else if (r.status === "rejected") {
          const disp = r.disposition ?? "permanent";
          const parts = [`push: ${drainer.key} [error] rejected(${disp})`];
          if (r.code) parts.push(r.code);
          if (r.field) parts.push(r.field);
          if (r.message) parts.push(r.message);
          log?.(parts.join(" · "));
          if (r.disposition === "retryable") retryableRejected += 1;
          else permanentRejected += 1;
        }
      }
      // Pre-1-0-5 server: no per-row disposition — fall back to the aggregate
      // count and treat every rejection as permanent (preserves prior behavior).
      if (results.length === 0) permanentRejected = res.data?.rejected ?? 0;

      if (retryableRejected > 0) {
        // Hold the cursor — the whole batch (accepted + parked rows included) is
        // re-sent next tick and the server dedups on event_id. A soft failure so
        // the loop backs off before retrying.
        status = "server_error";
        log?.(
          `push: ${drainer.key} server deferred ${retryableRejected}/${rows.length} row(s) (retryable) — cursor held, retrying next tick`
        );
        break;
      }

      if (permanentRejected > 0) {
        cursor.addDeadLetters(drainer.key, permanentRejected);
        deadLettered += permanentRejected;
        log?.(
          `push: ${drainer.key} server permanently rejected ${permanentRejected}/${rows.length} row(s) — dead-lettered`
        );
      }
      if (parked > 0) {
        parkedRows += parked;
        log?.(
          `push: ${drainer.key} server parked ${parked}/${rows.length} row(s) for server-side replay`
        );
      }
      // accepted + parked are delivered (not lost); `pushed` counts accepted only.
      pushed += rows.length - permanentRejected - parked;
      cursor.advance(drainer.key, batch.next);
      status = deadLettered > 0 ? "dead_lettered" : "ok";
      continue;
    }

    // Not ok. Decide whether to retry next tick (cursor unmoved) or quarantine.
    if (res.network) {
      status = "network";
      break;
    }
    if (res.status === 429 || res.status === 503) {
      // The client already retried these with Retry-After; still failing means
      // back off and try again on the next tick. Cursor stays put.
      status = "rate_limited";
      break;
    }
    if (res.status === 403) {
      // Entitlement changed server-side mid-tick. Stop without advancing; the
      // next tick's gate check will skip cleanly.
      status = "skipped_gate";
      break;
    }
    if (res.status >= 400 && res.status < 500) {
      // Terminal client error (400 malformed, 413 too large, …): the batch
      // itself is bad. Quarantine it and advance so the loop never hot-loops on
      // the same poison batch (B7).
      cursor.addDeadLetters(drainer.key, rows.length);
      deadLettered += rows.length;
      cursor.advance(drainer.key, batch.next);
      status = "dead_lettered";
      log?.(
        `push: ${drainer.key} batch rejected ${res.status} ${res.error.code} — dead-lettered ${rows.length} row(s)`
      );
      continue;
    }

    // 5xx other than 503: transient server fault. Retry next tick.
    status = "server_error";
    break;
  }

  return {
    stream: drainer.key,
    pushed,
    parked: parkedRows,
    deadLettered,
    status,
  };
}

/** One stream's running outcome + loop flags inside a coalesced drain. */
interface CoalesceState {
  pushed: number;
  parked: number;
  deadLettered: number;
  status: DrainStatus;
  /** Cursor held (retryable failure) — skip this stream for the rest of the tick. */
  held: boolean;
  /** Source exhausted (read returned null) — nothing left to read this tick. */
  exhausted: boolean;
  /** Pushed at least one batch — promotes a trailing `empty` to `ok`. */
  sawData: boolean;
}

/** A per-stream batch awaiting a combined push. */
interface PendingBatch {
  state: CoalesceState;
  key: string;
  batch: StreamBatch;
  rows: unknown[];
  eventIds: string[];
  bytes: number;
}

function rowEventId(row: unknown): string | undefined {
  return (row as { event_id?: string } | null)?.event_id;
}

/**
 * Greedy bin-pack whole per-stream batches into combined POSTs that each stay
 * under both the event-count and byte caps. A single batch is already capped by
 * the drainer's own read, so it always fits in a fresh post. Whole batches are
 * never split across posts, so each stream's `batch.next` cursor stays valid.
 */
function packBatches(
  pending: PendingBatch[],
  maxEvents: number
): PendingBatch[][] {
  const posts: PendingBatch[][] = [];
  let cur: PendingBatch[] = [];
  let rows = 0;
  let bytes = 2; // enclosing `[]`
  for (const p of pending) {
    const wouldRows = rows + p.rows.length;
    const wouldBytes = bytes + p.bytes;
    if (
      cur.length > 0 &&
      (wouldRows > maxEvents || wouldBytes > BODY_BYTE_BUDGET)
    ) {
      posts.push(cur);
      cur = [];
      rows = 0;
      bytes = 2;
    }
    cur.push(p);
    rows += p.rows.length;
    bytes += p.bytes;
  }
  if (cur.length > 0) posts.push(cur);
  return posts;
}

/**
 * Drain every stream for one repo by COALESCING per-stream batches into the
 * fewest combined `pushCombined` requests, then mapping each ack back to its
 * stream by `event_id`. Equivalent outcome to the per-stream {@link drainStream}
 * path (advance on accept/park, dead-letter poison, hold on retryable), but one
 * tick now costs ⌈total/maxEvents⌉ POSTs instead of one-per-stream. Best-effort:
 * a per-stream read/push failure never throws and never blocks another stream.
 */
async function drainRepoCoalesced(
  cursor: PushCursor,
  drainers: StreamDrainer[],
  pushCombined: (rows: unknown[]) => Promise<CloudResult<BatchAck>>,
  opts: { maxBatches: number; maxEvents: number; log?: (msg: string) => void }
): Promise<DrainOutcome[]> {
  const { maxBatches, maxEvents, log } = opts;
  const states = new Map<string, CoalesceState>(
    drainers.map((d) => [
      d.key,
      {
        pushed: 0,
        parked: 0,
        deadLettered: 0,
        status: "empty" as DrainStatus,
        held: false,
        exhausted: false,
        sawData: false,
      },
    ])
  );

  for (let round = 0; round < maxBatches; round++) {
    const pending: PendingBatch[] = [];

    for (const drainer of drainers) {
      const st = states.get(drainer.key);
      if (!st || st.held || st.exhausted) continue;

      let batch: StreamBatch | null;
      try {
        batch = await drainer.read(cursor.position(drainer.key));
      } catch (err) {
        log?.(`push: ${drainer.key} read failed: ${errMessage(err)}`);
        st.status = "server_error";
        st.held = true;
        continue;
      }

      if (!batch || batch.rows.length === 0) {
        st.exhausted = true;
        if (st.sawData && st.status !== "dead_lettered") st.status = "ok";
        continue;
      }
      st.sawData = true;

      // Contract gate — drop rows that drift from the wire shape. A fully-invalid
      // batch is poison: dead-letter and advance so the cursor never hot-loops.
      const rows = drainer.schema
        ? validateRows(drainer.schema, batch.rows, drainer.key, log)
        : batch.rows;
      if (rows.length === 0) {
        cursor.addDeadLetters(drainer.key, batch.rows.length);
        st.deadLettered += batch.rows.length;
        cursor.advance(drainer.key, batch.next);
        st.status = "dead_lettered";
        log?.(
          `push: ${drainer.key} all ${batch.rows.length} row(s) failed contract validation — dead-lettered`
        );
        continue;
      }

      pending.push({
        state: st,
        key: drainer.key,
        batch,
        rows,
        eventIds: rows.map(rowEventId).filter((id): id is string => !!id),
        bytes: Buffer.byteLength(JSON.stringify(rows), "utf8"),
      });
    }

    if (pending.length === 0) break;

    for (const post of packBatches(pending, maxEvents)) {
      const merged = post.flatMap((p) => p.rows);
      const res = await pushCombined(merged);
      applyCombinedAck(cursor, post, res, log);
    }

    if ([...states.values()].every((s) => s.held || s.exhausted)) break;
  }

  return drainers.map((d) => {
    const s = states.get(d.key);
    return {
      stream: d.key,
      pushed: s?.pushed ?? 0,
      parked: s?.parked ?? 0,
      deadLettered: s?.deadLettered ?? 0,
      status: s?.status ?? "empty",
    };
  });
}

/**
 * Apply one combined POST's result to every stream that contributed to it.
 * A 2xx maps per-row results back by `event_id`; a non-2xx is classified once
 * and applied to every member (poison → dead-letter+advance, transient → hold).
 */
function applyCombinedAck(
  cursor: PushCursor,
  post: PendingBatch[],
  res: CloudResult<BatchAck>,
  log?: (msg: string) => void
): void {
  if (!res.ok) {
    let status: DrainStatus = "server_error";
    let poison = false;
    if (res.network) status = "network";
    else if (res.status === 429 || res.status === 503) status = "rate_limited";
    else if (res.status === 403) status = "skipped_gate";
    else if (res.status >= 400 && res.status < 500) {
      status = "dead_lettered";
      poison = true;
    }
    for (const p of post) {
      if (poison) {
        // Terminal 4xx: the batch itself is bad — quarantine + advance so the
        // loop never hot-loops on the same poison rows (B7).
        cursor.addDeadLetters(p.key, p.rows.length);
        p.state.deadLettered += p.rows.length;
        cursor.advance(p.key, p.batch.next);
        p.state.status = "dead_lettered";
        log?.(
          `push: ${p.key} combined batch rejected ${res.status} ${res.error.code} — dead-lettered ${p.rows.length} row(s)`
        );
      } else {
        // Transient: hold the cursor, retry next tick (idempotent on event_id).
        p.state.status = status;
      }
      p.state.held = true;
    }
    return;
  }

  const results = res.data.results ?? [];
  const byId = new Map(results.map((r) => [r.event_id, r]));
  const aggregateRejected = res.data.rejected ?? 0;
  // Pre-1-0-5 server: no per-row results. Can't attribute a rejection to a
  // stream in a coalesced batch — hold the whole post and retry (dedup-safe).
  if (results.length === 0 && aggregateRejected > 0) {
    for (const p of post) {
      p.state.status = "server_error";
      p.state.held = true;
    }
    return;
  }

  for (const p of post) {
    let parked = 0;
    let permanentRejected = 0;
    let retryableRejected = 0;
    const rejectCodes = new Set<string>();
    for (const id of p.eventIds) {
      const r = byId.get(id);
      if (!r || r.status === "accepted") continue;
      if (r.status === "parked") {
        parked += 1;
        const parts = [`push: ${p.key} [warn] parked`];
        if (r.code) parts.push(r.code);
        if (r.field) parts.push(r.field);
        if (r.message) parts.push(r.message);
        log?.(parts.join(" · "));
      } else if (r.disposition === "retryable") {
        retryableRejected += 1;
        const parts = [`push: ${p.key} [error] rejected(retryable)`];
        if (r.code) parts.push(r.code);
        if (r.field) parts.push(r.field);
        if (r.message) parts.push(r.message);
        log?.(parts.join(" · "));
      } else {
        permanentRejected += 1;
        if (r.code) rejectCodes.add(r.code);
        const disp = r.disposition ?? "permanent";
        const parts = [`push: ${p.key} [error] rejected(${disp})`];
        if (r.code) parts.push(r.code);
        if (r.field) parts.push(r.field);
        if (r.message) parts.push(r.message);
        log?.(parts.join(" · "));
      }
    }

    if (retryableRejected > 0) {
      // Hold the cursor; the whole batch re-sends next tick (server dedups).
      p.state.status = "server_error";
      p.state.held = true;
      log?.(
        `push: ${p.key} server deferred ${retryableRejected}/${p.rows.length} row(s) (retryable) — cursor held`
      );
      continue;
    }
    if (permanentRejected > 0) {
      cursor.addDeadLetters(p.key, permanentRejected);
      p.state.deadLettered += permanentRejected;
      log?.(
        `push: ${p.key} server permanently rejected ${permanentRejected}/${p.rows.length} row(s) — dead-lettered${
          rejectCodes.size > 0 ? ` [${[...rejectCodes].join(", ")}]` : ""
        }`
      );
    }
    if (parked > 0) {
      p.state.parked += parked;
      log?.(
        `push: ${p.key} server parked ${parked}/${p.rows.length} row(s) for server-side replay`
      );
    }
    p.state.pushed += p.rows.length - permanentRejected - parked;
    cursor.advance(p.key, p.batch.next);
    p.state.status = p.state.deadLettered > 0 ? "dead_lettered" : "ok";
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

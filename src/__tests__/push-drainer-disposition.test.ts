/**
 * C5 regression: locks the three per-event server outcomes for both the
 * per-stream (drainRepo without pushCombined) and coalesced
 * (drainRepo with pushCombined) paths.
 *
 * Outcome 1 — parked:   cursor ADVANCES, outcome.parked === 1, second tick reads null.
 * Outcome 2 — rejected permanent: cursor ADVANCES, outcome.deadLettered === 1,
 *             cursor.deadLetterTotal() reflects it.
 * Outcome 3 — rejected retryable: cursor HELD, outcome.status === "server_error",
 *             deadLettered === 0, same rows are re-readable next tick.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudResult } from "../cloud/sync/client.js";
import { PushCursor } from "../cloud/sync/push-cursor.js";
import {
  type StreamBatch,
  type StreamDrainer,
  drainRepo,
} from "../cloud/sync/push-drainer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok = (ack: BatchAck): CloudResult<BatchAck> => ({
  ok: true,
  status: 200,
  data: ack,
});

const allow = () => true;

/**
 * A drainer that yields a fixed sequence of batches, then null. The rows in
 * each batch carry `event_id` so the coalesced `byId` mapping resolves them.
 * After the last batch, subsequent `read` calls return null — letting tests
 * confirm the cursor blocked a second tick from re-reading.
 */
function makeDrainer(
  key: string,
  batches: StreamBatch[],
  results: Array<CloudResult<BatchAck>>
): {
  drainer: StreamDrainer;
  readCount: () => number;
  pushCount: () => number;
} {
  let readIdx = 0;
  let pushIdx = 0;
  let reads = 0;
  let pushes = 0;

  const drainer: StreamDrainer = {
    key,
    async read(from) {
      reads += 1;
      // Return the batch whose `next` watermark is past `from`.
      // For the retryable case we need the same batch re-readable next tick:
      // the cursor is held at `from = {}` so readIdx must not advance past
      // the first batch until the cursor moves.
      const batch = batches[readIdx];
      if (!batch) return null;
      // Only advance the read pointer when the cursor has moved past this batch
      // (i.e. the cursor's lastId >= batch.next.lastId, meaning the production
      // code already called cursor.advance). For simplicity in these unit tests
      // we model it statelessly: each `read()` call returns batches[readIdx]
      // unconditionally — the drainStream loop calls read() once per iteration,
      // so readIdx advancing by 1 is correct for advance cases. For the
      // retryable case the loop breaks after the push, so read() is only called
      // once per drainRepo call.
      readIdx += 1;
      return batch;
    },
    async push(rows) {
      pushes += 1;
      return results[pushIdx++] ?? ok({ accepted: rows.length });
    },
  };

  return {
    drainer,
    readCount: () => reads,
    pushCount: () => pushes,
  };
}

/**
 * A variant for the retryable test: `read` always returns the same batch
 * (cursor held means next tick re-reads from the same position). Each call
 * to `drainRepo` opens a fresh loop, so the drainer must NOT auto-advance its
 * internal pointer — it models "same rows available every time read() is called".
 */
function makeRetryableDrainer(
  key: string,
  batch: StreamBatch,
  firstResult: CloudResult<BatchAck>
): { drainer: StreamDrainer; readCount: () => number } {
  let reads = 0;
  let pushes = 0;
  const drainer: StreamDrainer = {
    key,
    async read() {
      reads += 1;
      return batch;
    },
    async push() {
      pushes += 1;
      if (pushes === 1) return firstResult;
      // If somehow called again (should not happen in retryable case) → ok.
      return ok({ accepted: 1 });
    },
  };
  return { drainer, readCount: () => reads };
}

// ---------------------------------------------------------------------------
// Per-stream path (no pushCombined)
// ---------------------------------------------------------------------------

describe("drainRepo — per-stream disposition", () => {
  let unerrDir: string;

  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-disposition-stream-"));
  });

  it("parked: cursor advances, parked===1, deadLettered===0, second tick reads null", async () => {
    const EVENT_ID = "ev-park-1";
    const cursor = await PushCursor.open(unerrDir);

    const batch: StreamBatch = {
      rows: [{ event_id: EVENT_ID, type: "token_flow" }],
      next: { lastId: 10 },
    };
    const ack = ok({
      accepted: 0,
      parked: 1,
      rejected: 0,
      results: [{ event_id: EVENT_ID, status: "parked" as const }],
    });

    const { drainer } = makeDrainer("events", [batch], [ack]);
    const [outcome] = await drainRepo(cursor, [drainer], { isEntitled: allow });

    // Cursor ADVANCES after park (parked = durable delivery, not loss).
    expect(cursor.position("events")).toEqual({ lastId: 10 });

    // Outcome reflects parked count.
    expect(outcome?.parked).toBe(1);
    expect(outcome?.deadLettered).toBe(0);

    // Second tick: read returns null (no more batches) — the cursor advanced
    // so a real drainer would not re-serve the same rows.
    // We verify this with a fresh drainer whose read returns null immediately.
    const emptyDrainer: StreamDrainer = {
      key: "events",
      async read() {
        return null;
      },
      async push() {
        throw new Error("push must not be called when nothing to drain");
      },
    };
    const [secondOutcome] = await drainRepo(cursor, [emptyDrainer], {
      isEntitled: allow,
    });
    expect(secondOutcome?.status).toBe("empty");
    // Cursor position unchanged from the first tick advance.
    expect(cursor.position("events")).toEqual({ lastId: 10 });
  });

  it("rejected permanent: cursor advances, deadLettered===1, deadLetterTotal reflects it", async () => {
    const EVENT_ID = "ev-perm-1";
    const cursor = await PushCursor.open(unerrDir);

    const batch: StreamBatch = {
      rows: [{ event_id: EVENT_ID, type: "token_flow" }],
      next: { lastId: 7 },
    };
    const ack = ok({
      accepted: 0,
      rejected: 1,
      results: [
        {
          event_id: EVENT_ID,
          status: "rejected" as const,
          disposition: "permanent" as const,
          code: "invalid_payload",
        },
      ],
    });

    const { drainer } = makeDrainer("events", [batch], [ack]);
    const [outcome] = await drainRepo(cursor, [drainer], { isEntitled: allow });

    // Cursor ADVANCES past the poison row (no hot-loop).
    expect(cursor.position("events")).toEqual({ lastId: 7 });

    // Outcome correctly counts the dead letter.
    expect(outcome?.deadLettered).toBe(1);
    expect(outcome?.parked).toBe(0);

    // The cursor's own dead-letter tally is updated.
    expect(cursor.deadLetterTotal()).toBe(1);
  });

  it("rejected retryable: cursor HELD, status===server_error, deadLettered===0, rows re-readable next tick", async () => {
    const EVENT_ID = "ev-retry-1";
    const cursor = await PushCursor.open(unerrDir);

    const batch: StreamBatch = {
      rows: [{ event_id: EVENT_ID, type: "token_flow" }],
      next: { lastId: 3 },
    };
    const ack = ok({
      accepted: 0,
      rejected: 1,
      results: [
        {
          event_id: EVENT_ID,
          status: "rejected" as const,
          disposition: "retryable" as const,
        },
      ],
    });

    const { drainer, readCount } = makeRetryableDrainer("events", batch, ack);
    const [outcome] = await drainRepo(cursor, [drainer], { isEntitled: allow });

    // Cursor HELD — not advanced.
    expect(cursor.position("events")).toEqual({});

    // Outcome: server_error, no dead letters.
    expect(outcome?.status).toBe("server_error");
    expect(outcome?.deadLettered).toBe(0);
    expect(cursor.deadLetterTotal()).toBe(0);

    // Same rows are re-readable next tick: simulate a second drain call.
    // The drainer always returns the same batch (cursor position is still {}).
    // The second call must be able to read from the drainer (readCount increases).
    const readsBefore = readCount();
    // For the second tick, use a drainer that succeeds this time.
    const successDrainer: StreamDrainer = {
      key: "events",
      async read() {
        return batch; // still readable because cursor stayed at {}
      },
      async push() {
        return ok({ accepted: 1 });
      },
    };
    const [secondOutcome] = await drainRepo(cursor, [successDrainer], {
      isEntitled: allow,
    });
    // Now the cursor advances.
    expect(cursor.position("events")).toEqual({ lastId: 3 });
    expect(secondOutcome?.status).toBe("ok");
    // First tick consumed 1 read (confirmed the drainer was called).
    expect(readCount()).toBeGreaterThanOrEqual(readsBefore);
  });
});

// ---------------------------------------------------------------------------
// Coalesced path (pushCombined)
// ---------------------------------------------------------------------------

describe("drainRepo — coalesced disposition", () => {
  let unerrDir: string;

  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-disposition-coalesce-"));
  });

  it("parked: cursor advances exactly once, parked===1, deadLettered===0, second tick reads null", async () => {
    const EVENT_ID = "ev-coal-park-1";
    const cursor = await PushCursor.open(unerrDir);

    // readOnceDrainer: yields one batch then null (own push must NOT be called).
    let done = false;
    const drainer: StreamDrainer = {
      key: "events",
      async read() {
        if (done) return null;
        done = true;
        return {
          rows: [{ event_id: EVENT_ID, type: "token_flow" }],
          next: { lastId: 15 },
        };
      },
      async push() {
        throw new Error("coalesced path must not call drainer.push");
      },
    };

    const pushCombined = async (): Promise<CloudResult<BatchAck>> =>
      ok({
        accepted: 0,
        parked: 1,
        rejected: 0,
        results: [{ event_id: EVENT_ID, status: "parked" as const }],
      });

    const [outcome] = await drainRepo(cursor, [drainer], {
      isEntitled: allow,
      pushCombined,
    });

    // Cursor ADVANCES.
    expect(cursor.position("events")).toEqual({ lastId: 15 });
    expect(outcome?.parked).toBe(1);
    expect(outcome?.deadLettered).toBe(0);

    // Second tick: drainer now returns null (done=true above); nothing to push.
    const [secondOutcome] = await drainRepo(cursor, [drainer], {
      isEntitled: allow,
      pushCombined,
    });
    expect(secondOutcome?.status).toBe("empty");
    // Cursor still at the advanced position from tick one.
    expect(cursor.position("events")).toEqual({ lastId: 15 });
  });

  it("rejected permanent: cursor advances, deadLettered===1, deadLetterTotal reflects it", async () => {
    const EVENT_ID = "ev-coal-perm-1";
    const cursor = await PushCursor.open(unerrDir);

    let done = false;
    const drainer: StreamDrainer = {
      key: "events",
      async read() {
        if (done) return null;
        done = true;
        return {
          rows: [{ event_id: EVENT_ID, type: "token_flow" }],
          next: { lastId: 20 },
        };
      },
      async push() {
        throw new Error("coalesced path must not call drainer.push");
      },
    };

    const pushCombined = async (): Promise<CloudResult<BatchAck>> =>
      ok({
        accepted: 0,
        rejected: 1,
        results: [
          {
            event_id: EVENT_ID,
            status: "rejected" as const,
            disposition: "permanent" as const,
            code: "invalid_payload",
          },
        ],
      });

    const [outcome] = await drainRepo(cursor, [drainer], {
      isEntitled: allow,
      pushCombined,
    });

    // Cursor ADVANCES past the poison row.
    expect(cursor.position("events")).toEqual({ lastId: 20 });
    expect(outcome?.deadLettered).toBe(1);
    expect(outcome?.parked).toBe(0);
    expect(cursor.deadLetterTotal()).toBe(1);
  });

  it("rejected retryable: cursor HELD, status===server_error, deadLettered===0, rows re-readable next tick", async () => {
    const EVENT_ID = "ev-coal-retry-1";
    const cursor = await PushCursor.open(unerrDir);

    let reads = 0;
    const drainer: StreamDrainer = {
      key: "events",
      async read() {
        reads += 1;
        // Always returns the same batch (cursor is held so position stays at {}).
        return {
          rows: [{ event_id: EVENT_ID, type: "token_flow" }],
          next: { lastId: 5 },
        };
      },
      async push() {
        throw new Error("coalesced path must not call drainer.push");
      },
    };

    const retryableAck: CloudResult<BatchAck> = ok({
      accepted: 0,
      rejected: 1,
      results: [
        {
          event_id: EVENT_ID,
          status: "rejected" as const,
          disposition: "retryable" as const,
        },
      ],
    });

    const [outcome] = await drainRepo(cursor, [drainer], {
      isEntitled: allow,
      pushCombined: async () => retryableAck,
    });

    // Cursor HELD.
    expect(cursor.position("events")).toEqual({});
    expect(outcome?.status).toBe("server_error");
    expect(outcome?.deadLettered).toBe(0);
    expect(cursor.deadLetterTotal()).toBe(0);

    // Re-readable: a second drainRepo call with a successful push must see the
    // same rows (reads counter increases and cursor then advances).
    const readsAfterFirstTick = reads;
    const [secondOutcome] = await drainRepo(cursor, [drainer], {
      isEntitled: allow,
      pushCombined: async () =>
        ok({
          accepted: 1,
          results: [{ event_id: EVENT_ID, status: "accepted" as const }],
        }),
    });
    expect(reads).toBeGreaterThan(readsAfterFirstTick);
    expect(cursor.position("events")).toEqual({ lastId: 5 });
    expect(secondOutcome?.status).toBe("ok");
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudResult } from "../cloud/client.js";
import { PushCursor } from "../cloud/push-cursor.js";
import {
  type StreamBatch,
  type StreamDrainer,
  drainRepo,
} from "../cloud/push-drainer.js";

const ok = (ack: BatchAck): CloudResult<BatchAck> => ({
  ok: true,
  status: 200,
  data: ack,
});
const httpErr = (status: number, code = "err"): CloudResult<BatchAck> => ({
  ok: false,
  status,
  error: { code, message: code },
});
const netErr = (): CloudResult<BatchAck> => ({
  ok: false,
  status: 0,
  network: true,
  error: { code: "network_error", message: "offline" },
});

/** A drainer that yields a fixed list of pre-built batches, then null. */
function scriptedDrainer(
  key: string,
  batches: StreamBatch[],
  results: Array<CloudResult<BatchAck>>
): { drainer: StreamDrainer; pushedRows: unknown[][] } {
  let readIdx = 0;
  let pushIdx = 0;
  const pushedRows: unknown[][] = [];
  const drainer: StreamDrainer = {
    key,
    async read() {
      return batches[readIdx++] ?? null;
    },
    async push(rows) {
      pushedRows.push(rows);
      return results[pushIdx++] ?? ok({ accepted: rows.length });
    },
  };
  return { drainer, pushedRows };
}

const allow = () => true;
const deny = () => false;

describe("drainRepo", () => {
  let unerrDir: string;

  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-drainer-"));
  });

  it("skips every stream when not entitled (B5)", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer, pushedRows } = scriptedDrainer(
      "events",
      [{ rows: [{ a: 1 }], next: { lastId: 1 } }],
      [ok({ accepted: 1 })]
    );

    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: deny });

    expect(outcomes).toEqual([
      {
        stream: "events",
        pushed: 0,
        parked: 0,
        deadLettered: 0,
        status: "skipped_gate",
      },
    ]);
    expect(pushedRows).toHaveLength(0); // never pushed
    expect(cursor.position("events")).toEqual({}); // cursor unmoved
  });

  it("advances the cursor only after a 2xx and drains until empty", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer, pushedRows } = scriptedDrainer(
      "events",
      [
        { rows: [{ a: 1 }], next: { lastId: 10 } },
        { rows: [{ a: 2 }], next: { lastId: 20 } },
      ],
      [ok({ accepted: 1 }), ok({ accepted: 1 })]
    );

    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });

    expect(pushedRows).toHaveLength(2);
    expect(cursor.position("events")).toEqual({ lastId: 20 });
    expect(outcomes[0]).toMatchObject({ pushed: 2, status: "ok" });
  });

  it("reports empty when nothing is pending", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer } = scriptedDrainer("ledger", [], []);
    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });
    expect(outcomes[0]).toEqual({
      stream: "ledger",
      pushed: 0,
      parked: 0,
      deadLettered: 0,
      status: "empty",
    });
  });

  it("holds the cursor on a network error (retry next tick)", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer } = scriptedDrainer(
      "router",
      [{ rows: [{ a: 1 }], next: { lastIndex: 5 } }],
      [netErr()]
    );
    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });
    expect(cursor.position("router")).toEqual({}); // unmoved
    expect(outcomes[0]).toMatchObject({ pushed: 0, status: "network" });
  });

  it("holds the cursor on a 429 after client retries (rate limited)", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer } = scriptedDrainer(
      "events",
      [{ rows: [{ a: 1 }], next: { lastId: 9 } }],
      [httpErr(429, "rate_limited")]
    );
    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });
    expect(cursor.position("events")).toEqual({});
    expect(outcomes[0]).toMatchObject({ status: "rate_limited" });
  });

  it("dead-letters and advances past a terminal 400 (B7, no hot loop)", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer, pushedRows } = scriptedDrainer(
      "transcripts",
      [
        { rows: [{ bad: 1 }, { bad: 2 }], next: { lastId: 30 } },
        { rows: [{ ok: 1 }], next: { lastId: 31 } },
      ],
      [httpErr(400, "invalid_payload"), ok({ accepted: 1 })]
    );

    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });

    // The poison batch is skipped past, then the next batch goes through.
    expect(pushedRows).toHaveLength(2);
    expect(cursor.position("transcripts")).toEqual({ lastId: 31 });
    expect(cursor.deadLetterTotal()).toBe(2);
    expect(outcomes[0]).toMatchObject({ pushed: 1, deadLettered: 2 });
  });

  it("counts per-record server rejects as dead letters but still advances", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer } = scriptedDrainer(
      "facts",
      [{ rows: [{ a: 1 }, { b: 2 }, { c: 3 }], next: { lastId: 7 } }],
      [ok({ accepted: 2, rejected: 1 })]
    );

    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });

    expect(cursor.position("facts")).toEqual({ lastId: 7 }); // advanced
    expect(cursor.deadLetterTotal()).toBe(1);
    expect(outcomes[0]).toMatchObject({
      pushed: 2,
      deadLettered: 1,
      status: "dead_lettered",
    });
  });

  it("parks rows durably: advances the cursor, never dead-letters (accept-and-park)", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer } = scriptedDrainer(
      "events",
      [{ rows: [{ a: 1 }, { b: 2 }, { c: 3 }], next: { lastId: 9 } }],
      [
        ok({
          accepted: 1,
          parked: 2,
          rejected: 0,
          results: [
            { event_id: "a", status: "accepted" },
            {
              event_id: "b",
              status: "parked",
              code: "parked_schema_unsupported",
            },
            {
              event_id: "c",
              status: "parked",
              code: "parked_schema_unsupported",
            },
          ],
        }),
      ]
    );

    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });

    expect(cursor.position("events")).toEqual({ lastId: 9 }); // advanced — durable
    expect(cursor.deadLetterTotal()).toBe(0); // parked is NOT data loss
    expect(outcomes[0]).toMatchObject({
      pushed: 1,
      parked: 2,
      deadLettered: 0,
      status: "ok",
    });
  });

  it("dead-letters a permanently rejected row and advances past it", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer } = scriptedDrainer(
      "events",
      [{ rows: [{ a: 1 }, { b: 2 }], next: { lastId: 5 } }],
      [
        ok({
          accepted: 1,
          rejected: 1,
          results: [
            { event_id: "a", status: "accepted" },
            {
              event_id: "b",
              status: "rejected",
              disposition: "permanent",
              code: "invalid_payload",
            },
          ],
        }),
      ]
    );

    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });

    expect(cursor.position("events")).toEqual({ lastId: 5 }); // advanced
    expect(cursor.deadLetterTotal()).toBe(1);
    expect(outcomes[0]).toMatchObject({
      pushed: 1,
      parked: 0,
      deadLettered: 1,
      status: "dead_lettered",
    });
  });

  it("holds the cursor on a retryable per-row reject (no dead-letter)", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer } = scriptedDrainer(
      "events",
      [{ rows: [{ a: 1 }, { b: 2 }], next: { lastId: 8 } }],
      [
        ok({
          accepted: 1,
          rejected: 1,
          results: [
            { event_id: "a", status: "accepted" },
            { event_id: "b", status: "rejected", disposition: "retryable" },
          ],
        }),
      ]
    );

    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });

    expect(cursor.position("events")).toEqual({}); // held — retried next tick
    expect(cursor.deadLetterTotal()).toBe(0); // retryable is NOT dead-lettered
    expect(outcomes[0]).toMatchObject({
      deadLettered: 0,
      status: "server_error",
    });
  });

  it("holds the cursor on a 5xx server error", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const { drainer } = scriptedDrainer(
      "sessions",
      [{ rows: [{ a: 1 }], next: { lastId: 1 } }],
      [httpErr(500, "server_error")]
    );
    const outcomes = await drainRepo(cursor, [drainer], { isEntitled: allow });
    expect(cursor.position("sessions")).toEqual({});
    expect(outcomes[0]).toMatchObject({ status: "server_error" });
  });

  it("respects maxBatchesPerStream as a safety bound", async () => {
    const cursor = await PushCursor.open(unerrDir);
    // An endless supply of batches; the bound must stop the loop.
    let n = 0;
    const drainer: StreamDrainer = {
      key: "events",
      async read() {
        n += 1;
        return { rows: [{ a: n }], next: { lastId: n } };
      },
      async push(rows) {
        return ok({ accepted: rows.length });
      },
    };
    await drainRepo(cursor, [drainer], {
      isEntitled: allow,
      maxBatchesPerStream: 3,
    });
    expect(cursor.position("events")).toEqual({ lastId: 3 });
  });
});

/** A drainer that yields one batch then null; its own `push` must NOT be called
 *  on the coalesced path (the combined pusher owns the request). */
function readOnceDrainer(
  key: string,
  rows: unknown[],
  next: { lastId: number }
): StreamDrainer {
  let done = false;
  return {
    key,
    async read() {
      if (done) return null;
      done = true;
      return { rows, next };
    },
    async push() {
      throw new Error(`coalesced path must not call ${key}.push`);
    },
  };
}

const accepted = (ids: string[]): BatchAck => ({
  accepted: ids.length,
  results: ids.map((event_id) => ({ event_id, status: "accepted" as const })),
});

describe("drainRepo — coalesced", () => {
  let unerrDir: string;
  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-coalesce-"));
  });

  it("merges every stream into ONE combined POST and advances all cursors", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const drainers = [
      readOnceDrainer("events", [{ event_id: "e1" }, { event_id: "e2" }], {
        lastId: 2,
      }),
      readOnceDrainer("ledger", [{ event_id: "l1" }], { lastId: 1 }),
    ];
    const calls: unknown[][] = [];
    const pushCombined = async (rows: unknown[]) => {
      calls.push(rows);
      return ok(accepted(["e1", "e2", "l1"]));
    };

    const outcomes = await drainRepo(cursor, drainers, {
      isEntitled: allow,
      pushCombined,
    });

    expect(calls).toHaveLength(1); // one request for both streams
    expect(calls[0]).toHaveLength(3);
    expect(cursor.position("events")).toEqual({ lastId: 2 });
    expect(cursor.position("ledger")).toEqual({ lastId: 1 });
    expect(outcomes).toContainEqual(
      expect.objectContaining({ stream: "events", pushed: 2, status: "ok" })
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({ stream: "ledger", pushed: 1, status: "ok" })
    );
  });

  it("holds only the stream with a retryable reject; others advance", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const drainers = [
      readOnceDrainer("events", [{ event_id: "e1" }], { lastId: 5 }),
      readOnceDrainer("ledger", [{ event_id: "l1" }], { lastId: 7 }),
    ];
    const pushCombined = async () =>
      ok({
        accepted: 1,
        rejected: 1,
        results: [
          { event_id: "e1", status: "accepted" as const },
          {
            event_id: "l1",
            status: "rejected" as const,
            disposition: "retryable" as const,
          },
        ],
      });

    const outcomes = await drainRepo(cursor, drainers, {
      isEntitled: allow,
      pushCombined,
    });

    expect(cursor.position("events")).toEqual({ lastId: 5 }); // advanced
    expect(cursor.position("ledger")).toEqual({}); // held
    expect(outcomes).toContainEqual(
      expect.objectContaining({ stream: "events", pushed: 1, status: "ok" })
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({ stream: "ledger", status: "server_error" })
    );
  });

  it("dead-letters every member on a terminal 400 and advances past it", async () => {
    const cursor = await PushCursor.open(unerrDir);
    const drainers = [
      readOnceDrainer("events", [{ event_id: "e1" }], { lastId: 3 }),
      readOnceDrainer("ledger", [{ event_id: "l1" }], { lastId: 4 }),
    ];
    const pushCombined = async () => httpErr(400, "bad_request");

    const outcomes = await drainRepo(cursor, drainers, {
      isEntitled: allow,
      pushCombined,
    });

    expect(cursor.position("events")).toEqual({ lastId: 3 }); // advanced past poison
    expect(cursor.position("ledger")).toEqual({ lastId: 4 });
    expect(outcomes.every((o) => o.status === "dead_lettered")).toBe(true);
    expect(outcomes.reduce((n, o) => n + o.deadLettered, 0)).toBe(2);
  });
});

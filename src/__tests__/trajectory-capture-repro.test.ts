/**
 * Cap A trajectory-trace CAPTURE repro.
 *
 * Mirrors the live proxy flow exactly:
 *   mark_blocker → (ledger entries) → mark_resolution
 *   → synthesizeTrace (fire-and-forget) → trace row in timeline.db
 *
 * Checks three things independently so we can pinpoint which step breaks:
 *   1. getMarkerById returns the stored blocker (suspect a: id mismatch / Datalog bug)
 *   2. countTraces() === 1 after the resolution (full synthesizeTrace path)
 *   3. recallTracesByTokens finds the trace by symptom tokens
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenize } from "../intelligence/search-index.js";
import { CozoTimelineStore } from "../timeline/timeline-store.js";
import { handleMarkerCall } from "../tools/intelligence/timeline-markers.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

let tempDir: string;
let unerrDir: string;
let ledger: ShadowLedger;
let store: CozoTimelineStore;

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `unerr-capture-repro-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  unerrDir = join(tempDir, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
  ledger = new ShadowLedger(unerrDir);
  store = await CozoTimelineStore.create(tempDir);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("Cap A trajectory capture repro", () => {
  it("getMarkerById returns the correct row when multiple markers exist (multi-row selection bug)", async () => {
    const deps = { ledger, store, branch: "main", headSha: "abc123" };

    // Insert several markers first so the table has multiple rows.
    // This exposes any CozoDB scan+filter bug that only shows with >1 row.
    await handleMarkerCall(
      "mark_blocker",
      {
        text: "unrelated blocker A — database migration fails",
        file_path: "src/db/migrate.ts",
      },
      deps
    );
    await handleMarkerCall(
      "mark_blocker",
      {
        text: "unrelated blocker B — auth token expired",
        file_path: "src/auth/token.ts",
      },
      deps
    );

    // The target blocker — inserted third so we must select it by id, not position.
    const blockerResult = await handleMarkerCall(
      "mark_blocker",
      {
        text: "worker process memory leak heap climbs to 480MB asyncio connection pool unbounded sockets pile up",
        file_path: "src/workers/pool.py",
      },
      deps
    );
    const blockerBody = JSON.parse(blockerResult.content[0]!.text) as {
      ok: boolean;
      marker_id: string;
    };
    expect(blockerBody.ok).toBe(true);
    const blockerId = blockerBody.marker_id;

    // Suspect (a): does getMarkerById select the CORRECT row (not the first row)?
    const stored = await store.getMarkerById(blockerId);
    expect(
      stored,
      `getMarkerById("${blockerId}") returned null — marker not found in DB (3 rows present)`
    ).not.toBeNull();
    expect(stored!.marker_id).toBe(blockerId);
    expect(stored!.type).toBe("mark_blocker");
    expect(stored!.text).toContain("worker");
    expect(stored!.file_path).toBe("src/workers/pool.py");
  });

  it("mark_resolution synthesizes a trace row and token index (full capture path)", async () => {
    const deps = { ledger, store, branch: "main", headSha: "abc123" };

    // Step 1: blocker
    const blockerResult = await handleMarkerCall(
      "mark_blocker",
      {
        text: "worker process memory leak heap climbs to 480MB asyncio connection pool unbounded sockets pile up",
        file_path: "src/workers/pool.py",
      },
      deps
    );
    const { marker_id: blockerId } = JSON.parse(
      blockerResult.content[0]!.text
    ) as { ok: boolean; marker_id: string };

    // Step 2: intermediate ledger entries that become dead_ends
    ledger.record(
      "file_read",
      { file_path: "src/workers/connection.py" },
      { ok: true },
      "main",
      "abc123"
    );
    ledger.record(
      "search_code",
      { query: "asyncio pool socket close" },
      { ok: true },
      "main",
      "abc123"
    );

    // Step 3: resolution — passes blockerId as blocker_ref (suspect b: is it forwarded unchanged?)
    const resResult = await handleMarkerCall(
      "mark_resolution",
      {
        blocker_ref: blockerId,
        text: "set connection pool max_size=20 and close idle sockets",
      },
      deps
    );
    expect(JSON.parse(resResult.content[0]!.text)).toMatchObject({ ok: true });

    // Step 4: synthesizeTrace is fire-and-forget — flush the microtask queue
    await new Promise<void>((r) => setTimeout(r, 150));

    // Step 5: trace row must exist
    const count = await store.countTraces();
    expect(
      count,
      "countTraces() === 0 after resolution — synthesizeTrace did not write a trace row"
    ).toBe(1);

    // Step 6: token recall must find it
    const queryTokens = tokenize("worker memory leak connection pool");
    expect(
      queryTokens.length,
      "tokenize produced no tokens for query"
    ).toBeGreaterThan(0);
    const traces = await store.recallTracesByTokens(queryTokens);
    expect(
      traces.length,
      `recallTracesByTokens(${JSON.stringify(queryTokens)}) returned no results`
    ).toBeGreaterThan(0);
    expect(traces[0]!.situation).toContain("worker");
    expect(traces[0]!.unlock).toContain("max_size");
  });
});

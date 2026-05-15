/**
 * ST-1c: Timeline bootstrap — kill-switch + turn-close → turn rollup wiring.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeTurnRollup,
  startTimelineBootstrap,
} from "../timeline/timeline-bootstrap.js";
import { CozoTimelineStore } from "../timeline/timeline-store.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-tb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tempDir, ".unerr"), { recursive: true });
  process.env.UNERR_TIMELINE_V2 = undefined;
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.env.UNERR_TIMELINE_V2 = undefined;
});

describe("computeTurnRollup", () => {
  it("aggregates entries into a turn row with intent title", () => {
    const event = {
      turn_id: "T1",
      session_id: "S1",
      closed_at: 5_000,
      reason: "idle_gap" as const,
    };
    const entries = [
      {
        id: "1",
        ts: "2026-05-12T10:00:00.000Z",
        tool: "mark_intent",
        args_summary: { text: "refactor auth" },
        result_summary: {},
        branch: "main",
        head_sha: "x",
        session_id: "S1",
        correlation_id: null,
        turn_id: "T1",
        turn_confidence: "first_call" as const,
      },
      {
        id: "2",
        ts: "2026-05-12T10:00:02.000Z",
        tool: "file_read",
        args_summary: { file_path: "src/auth.ts" },
        result_summary: {},
        branch: "main",
        head_sha: "x",
        session_id: "S1",
        correlation_id: "1",
        turn_id: "T1",
        turn_confidence: "first_call" as const,
      },
      {
        id: "3",
        ts: "2026-05-12T10:00:04.000Z",
        tool: "Edit",
        args_summary: { file_path: "src/auth.ts" },
        result_summary: {},
        branch: "main",
        head_sha: "x",
        session_id: "S1",
        correlation_id: "1",
        turn_id: "T1",
        turn_confidence: "first_call" as const,
      },
    ];

    const rollup = computeTurnRollup(event, entries);
    expect(rollup.turn_id).toBe("T1");
    expect(rollup.session_id).toBe("S1");
    expect(rollup.tool_count).toBe(3);
    expect(rollup.file_count).toBe(1);
    expect(rollup.edit_count).toBe(1);
    expect(rollup.title).toBe("refactor auth");
    expect(rollup.opened_by).toBe("first_call");
    expect(rollup.closed_reason).toBe("idle_gap");
  });

  it("falls back to basename when no mark_intent present", () => {
    const event = {
      turn_id: "T2",
      session_id: "S1",
      closed_at: 100,
      reason: "stop_hook" as const,
    };
    const entries = [
      {
        id: "1",
        ts: "2026-05-12T10:00:00.000Z",
        tool: "file_read",
        args_summary: { file_path: "src/auth.ts" },
        result_summary: {},
        branch: "main",
        head_sha: "x",
        session_id: "S1",
        correlation_id: null,
        turn_id: "T2",
        turn_confidence: "first_call" as const,
      },
    ];
    const rollup = computeTurnRollup(event, entries);
    expect(rollup.title).toBe("auth.ts");
  });
});

describe("startTimelineBootstrap", () => {
  it("returns null and does NOT create timeline.db when UNERR_TIMELINE_V2=0", async () => {
    process.env.UNERR_TIMELINE_V2 = "0";
    const ledger = new ShadowLedger(join(tempDir, ".unerr"));
    const handle = await startTimelineBootstrap({
      projectRoot: tempDir,
      ledger,
      log: () => {},
    });
    expect(handle).toBeNull();
    expect(existsSync(join(tempDir, ".unerr", "timeline.db"))).toBe(false);
  });

  it("opens timeline.db and upserts a turn when the segmenter closes one", async () => {
    const ledger = new ShadowLedger(join(tempDir, ".unerr"));
    const handle = await startTimelineBootstrap({
      projectRoot: tempDir,
      ledger,
      log: () => {},
    });
    expect(handle).not.toBeNull();
    if (!handle) return;

    try {
      ledger.record(
        "file_read",
        { file_path: "src/a.ts" },
        {},
        "main",
        "deadbeef"
      );
      ledger.record("search_code", { query: "foo" }, {}, "main", "deadbeef");
      ledger.closeTurn("session_end");

      // Give the async upsertTurn microtask a tick to flush.
      await new Promise((r) => setTimeout(r, 30));

      const store = handle.store;
      const turns = await store.listTurns();
      expect(turns).toHaveLength(1);
      expect(turns[0]?.session_id).toBe(ledger.getSessionId());
      expect(turns[0]?.tool_count).toBe(2);
      expect(turns[0]?.file_count).toBe(1);
      expect(turns[0]?.closed_reason).toBe("session_end");
    } finally {
      handle.stop();
    }
  });

  it("stop() releases the store and detaches the listener", async () => {
    const ledger = new ShadowLedger(join(tempDir, ".unerr"));
    const handle = await startTimelineBootstrap({
      projectRoot: tempDir,
      ledger,
      log: () => {},
    });
    if (!handle) throw new Error("expected handle");

    handle.stop();
    // Subsequent close should no-op (listener already detached).
    ledger.record("file_read", { file_path: "src/b.ts" }, {}, "m", "x");
    ledger.closeTurn();
    // No error should propagate; store is closed, so we just verify
    // listTurns on a NEW store opening the same db still works (re-open path).
    const reopened = await CozoTimelineStore.create(tempDir);
    try {
      // Was nothing inserted after stop (listener detached).
      const turns = await reopened.listTurns();
      expect(turns).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});

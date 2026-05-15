/**
 * ST-1: TurnSegmenter — pure, no I/O. Tests cover boundary detection
 * (first_call, idle_gap, stop_hook) and session isolation.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type TurnCloseEvent,
  TurnSegmenter,
  type TurnTaggable,
} from "../tracking/turn-segmenter.js";

function makeEntry(sessionId: string, ts: string): TurnTaggable {
  return { session_id: sessionId, ts };
}

describe("TurnSegmenter", () => {
  it("stamps the first entry as a new turn with confidence 'first_call'", () => {
    const seg = new TurnSegmenter();
    const e = makeEntry("s1", new Date("2026-05-12T10:00:00Z").toISOString());
    seg.observe(e);

    expect(e.turn_id).toMatch(/^[a-f0-9]{12}$/);
    expect(e.turn_confidence).toBe("first_call");
  });

  it("keeps subsequent entries within idle window in the same turn", () => {
    const seg = new TurnSegmenter({ idleGapMs: 20_000 });
    const e1 = makeEntry("s1", new Date("2026-05-12T10:00:00Z").toISOString());
    const e2 = makeEntry("s1", new Date("2026-05-12T10:00:15Z").toISOString());

    seg.observe(e1);
    seg.observe(e2);

    expect(e2.turn_id).toBe(e1.turn_id);
    expect(e2.turn_confidence).toBe("first_call");
  });

  it("opens a new turn after an idle gap and emits a close event", () => {
    const seg = new TurnSegmenter({ idleGapMs: 20_000 });
    const closes: TurnCloseEvent[] = [];
    seg.onTurnClose((e) => closes.push(e));

    const e1 = makeEntry("s1", new Date("2026-05-12T10:00:00Z").toISOString());
    const e2 = makeEntry("s1", new Date("2026-05-12T10:00:25Z").toISOString());

    seg.observe(e1);
    seg.observe(e2);

    expect(e2.turn_id).not.toBe(e1.turn_id);
    expect(e2.turn_confidence).toBe("idle_gap");
    expect(closes).toHaveLength(1);
    expect(closes[0]?.turn_id).toBe(e1.turn_id);
    expect(closes[0]?.reason).toBe("idle_gap");
    expect(closes[0]?.session_id).toBe("s1");
  });

  it("isolates turn ids across sessions", () => {
    const seg = new TurnSegmenter();
    const a = makeEntry("sa", new Date("2026-05-12T10:00:00Z").toISOString());
    const b = makeEntry("sb", new Date("2026-05-12T10:00:00Z").toISOString());

    seg.observe(a);
    seg.observe(b);

    expect(a.turn_id).toBeTypeOf("string");
    expect(b.turn_id).toBeTypeOf("string");
    expect(a.turn_id).not.toBe(b.turn_id);
  });

  it("closeTurn anchors an exact boundary; next entry is 'first_call'", () => {
    const seg = new TurnSegmenter();
    const closes: TurnCloseEvent[] = [];
    seg.onTurnClose((e) => closes.push(e));

    const e1 = makeEntry("s1", new Date("2026-05-12T10:00:00Z").toISOString());
    seg.observe(e1);
    seg.closeTurn("s1", "stop_hook");

    const e2 = makeEntry("s1", new Date("2026-05-12T10:00:05Z").toISOString());
    seg.observe(e2);

    expect(e2.turn_id).not.toBe(e1.turn_id);
    expect(e2.turn_confidence).toBe("first_call");
    expect(closes).toHaveLength(1);
    expect(closes[0]?.reason).toBe("stop_hook");
  });

  it("closeTurn with no open turn is a no-op", () => {
    const seg = new TurnSegmenter();
    const closes: TurnCloseEvent[] = [];
    seg.onTurnClose((e) => closes.push(e));

    seg.closeTurn("never-seen");
    expect(closes).toHaveLength(0);
  });

  it("getCurrentTurnId returns the active turn for the session", () => {
    const seg = new TurnSegmenter();
    expect(seg.getCurrentTurnId("s1")).toBeNull();
    const e = makeEntry("s1", new Date("2026-05-12T10:00:00Z").toISOString());
    seg.observe(e);
    expect(seg.getCurrentTurnId("s1")).toBe(e.turn_id);
    seg.closeTurn("s1");
    expect(seg.getCurrentTurnId("s1")).toBeNull();
  });

  it("onTurnClose returns an unsubscribe function", () => {
    const seg = new TurnSegmenter({ idleGapMs: 10_000 });
    const listener = vi.fn();
    const unsubscribe = seg.onTurnClose(listener);

    const e1 = makeEntry("s1", new Date("2026-05-12T10:00:00Z").toISOString());
    const e2 = makeEntry("s1", new Date("2026-05-12T10:00:20Z").toISOString());
    seg.observe(e1);
    seg.observe(e2);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    const e3 = makeEntry("s1", new Date("2026-05-12T10:00:50Z").toISOString());
    seg.observe(e3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing listener without breaking other listeners", () => {
    const seg = new TurnSegmenter({ idleGapMs: 10_000 });
    const good = vi.fn();
    seg.onTurnClose(() => {
      throw new Error("boom");
    });
    seg.onTurnClose(good);

    const e1 = makeEntry("s1", new Date("2026-05-12T10:00:00Z").toISOString());
    const e2 = makeEntry("s1", new Date("2026-05-12T10:00:30Z").toISOString());
    seg.observe(e1);
    seg.observe(e2);

    expect(good).toHaveBeenCalledTimes(1);
  });

  it("reset clears all session state", () => {
    const seg = new TurnSegmenter();
    const e = makeEntry("s1", new Date("2026-05-12T10:00:00Z").toISOString());
    seg.observe(e);
    expect(seg.getCurrentTurnId("s1")).not.toBeNull();
    seg.reset();
    expect(seg.getCurrentTurnId("s1")).toBeNull();
  });
});

describe("ShadowLedger ↔ TurnSegmenter integration", () => {
  it("stamps recorded entries with turn_id and turn_confidence", async () => {
    const { mkdirSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ShadowLedger } = await import("../tracking/shadow-ledger.js");

    const tempDir = join(
      tmpdir(),
      `unerr-ts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const unerrDir = join(tempDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });

    try {
      const ledger = new ShadowLedger(unerrDir);
      const e1 = ledger.record(
        "search_code",
        { query: "foo" },
        { count: 3 },
        "main",
        "deadbeef"
      );
      const e2 = ledger.record(
        "file_read",
        { file_path: "src/a.ts" },
        { lines: 100 },
        "main",
        "deadbeef"
      );

      expect(e1.turn_id).toMatch(/^[a-f0-9]{12}$/);
      expect(e1.turn_confidence).toBe("first_call");
      expect(e2.turn_id).toBe(e1.turn_id);

      const filePath = join(unerrDir, "ledger", "shadow.jsonl");
      const lines = readFileSync(filePath, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines[0].turn_id).toBe(e1.turn_id);
      expect(lines[0].turn_confidence).toBe("first_call");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ledger.closeTurn() anchors a fresh first_call boundary on next record", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ShadowLedger } = await import("../tracking/shadow-ledger.js");

    const tempDir = join(
      tmpdir(),
      `unerr-ts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const unerrDir = join(tempDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });

    try {
      const ledger = new ShadowLedger(unerrDir);
      const a = ledger.record("search_code", {}, {}, "main", "x");
      ledger.closeTurn("stop_hook");
      const b = ledger.record("file_read", {}, {}, "main", "x");

      expect(b.turn_id).not.toBe(a.turn_id);
      expect(b.turn_confidence).toBe("first_call");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

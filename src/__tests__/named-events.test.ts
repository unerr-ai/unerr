/**
 * Phase 1 — Named Events projection layer.
 *
 * Verifies the read-only projection over `behavior_events` +
 * `token_flow_events` produces the correct NamedEvent shape, applies
 * filters, and never writes to the underlying tables.
 */

import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BehaviorEventWriter,
  readBehaviorEvents,
} from "../tracking/behavior-events.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";
import {
  type NamedEvent,
  countNamedEventsByType,
  currentTurnSlice,
  getPhrasing,
  latestPromptBoundaryTs,
  makeInCurrentTurn,
  readNamedEvents,
  totalNamedEvents,
} from "../tracking/named-events.js";
import {
  TokenFlowWriter,
  readTokenFlowEvents,
} from "../tracking/token-flow.js";

describe("named-events", () => {
  let tmpDir: string;
  let unerrDir: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-named-events-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getPhrasing", () => {
    it("returns verb+object+plural for a known behavior type", () => {
      expect(getPhrasing("stale_edit_prevented")).toEqual({
        verb: "caught",
        object: "stale code edit",
        plural: "stale code edits",
      });
    });

    it("returns verb+object+plural for a tokenflow.<mechanism> type", () => {
      expect(getPhrasing("tokenflow.graph_query")).toEqual({
        verb: "served",
        object: "code lookup",
        plural: "code lookups",
      });
    });

    it("falls back to default phrasing for an unknown type", () => {
      expect(getPhrasing("not_a_real_event_xyz")).toEqual({
        verb: "recorded",
        object: "thing",
        plural: "things",
      });
    });

    it("renders the reviewer's in-flight-finding row (turn-summary contract)", () => {
      expect(getPhrasing("review_finding_surfaced")).toEqual({
        verb: "flagged",
        object: "review finding",
        plural: "review findings",
      });
    });
  });

  describe("readNamedEvents", () => {
    it("projects a behavior event into the NamedEvent shape", () => {
      const writer = new BehaviorEventWriter(unerrDir, "sess-1");
      writer.record({
        session_id: "sess-1",
        turn: 1,
        type: "stale_edit_prevented",
        tool: "edit",
        entity_key: "src/foo.ts",
        response_bytes: null,
      });

      const named = readNamedEvents(unerrDir, { session_id: "sess-1" });
      expect(named).toHaveLength(1);
      const [n] = named;
      expect(n!.event_type).toBe("stale_edit_prevented");
      expect(n!.verb).toBe("caught");
      expect(n!.object).toBe("stale code edit");
      expect(n!.file_path).toBe("src/foo.ts");
      expect(n!.session_id).toBe("sess-1");
      expect(n!.turn).toBe(1);
    });

    it("projects a token-flow event with synthetic tokenflow.<mechanism> type", () => {
      const writer = new TokenFlowWriter(unerrDir, "sess-1");
      writer.record({
        session_id: "sess-1",
        turn: 1,
        mechanism: "graph_query",
        tool: "get_references",
        tokens_without: 5000,
        tokens_with: 800,
        tokens_saved: 4200,
      });

      const named = readNamedEvents(unerrDir, { session_id: "sess-1" });
      expect(named).toHaveLength(1);
      const [n] = named;
      expect(n!.event_type).toBe("tokenflow.graph_query");
      expect(n!.verb).toBe("served");
      expect(n!.metadata.tokens_saved).toBe(4200);
      expect(n!.metadata.mechanism).toBe("graph_query");
    });

    it("filters by session_id", () => {
      const wA = new BehaviorEventWriter(unerrDir, "sess-A");
      wA.record({
        session_id: "sess-A",
        turn: 1,
        type: "cache_hit",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      const wB = new BehaviorEventWriter(unerrDir, "sess-B");
      wB.record({
        session_id: "sess-B",
        turn: 1,
        type: "cache_hit",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });

      const a = readNamedEvents(unerrDir, { session_id: "sess-A" });
      const b = readNamedEvents(unerrDir, { session_id: "sess-B" });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]!.session_id).toBe("sess-A");
      expect(b[0]!.session_id).toBe("sess-B");
    });

    it("merges behavior + token-flow streams ordered by ts", () => {
      const bw = new BehaviorEventWriter(unerrDir, "sess-1");
      const tw = new TokenFlowWriter(unerrDir, "sess-1");
      bw.record({
        session_id: "sess-1",
        turn: 1,
        type: "fact_recalled",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      tw.record({
        session_id: "sess-1",
        turn: 1,
        mechanism: "session_dedup",
        tool: "file_read",
        tokens_without: 2000,
        tokens_with: 500,
        tokens_saved: 1500,
      });

      const named = readNamedEvents(unerrDir, { session_id: "sess-1" });
      expect(named).toHaveLength(2);
      // ts asc — both written just now, order should be stable
      for (let i = 1; i < named.length; i++) {
        expect(named[i]!.ts >= named[i - 1]!.ts).toBe(true);
      }
    });

    it("does not modify the underlying behavior_events / token_flow_events rows", () => {
      const bw = new BehaviorEventWriter(unerrDir, "sess-1");
      bw.record({
        session_id: "sess-1",
        turn: 1,
        type: "cache_hit",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      const tw = new TokenFlowWriter(unerrDir, "sess-1");
      tw.record({
        session_id: "sess-1",
        turn: 1,
        mechanism: "graph_query",
        tool: "search_code",
        tokens_without: 1000,
        tokens_with: 250,
        tokens_saved: 750,
      });

      const beforeBehavior = readBehaviorEvents(unerrDir, {
        session_id: "sess-1",
      });
      const beforeTokenFlow = readTokenFlowEvents(unerrDir, {
        session_id: "sess-1",
      });

      readNamedEvents(unerrDir, { session_id: "sess-1" });

      const afterBehavior = readBehaviorEvents(unerrDir, {
        session_id: "sess-1",
      });
      const afterTokenFlow = readTokenFlowEvents(unerrDir, {
        session_id: "sess-1",
      });

      expect(afterBehavior).toEqual(beforeBehavior);
      expect(afterTokenFlow).toEqual(beforeTokenFlow);
    });
  });

  describe("countNamedEventsByType + totalNamedEvents", () => {
    it("aggregates counts by event_type", () => {
      const bw = new BehaviorEventWriter(unerrDir, "sess-1");
      bw.record({
        session_id: "sess-1",
        turn: 1,
        type: "stale_edit_prevented",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      bw.record({
        session_id: "sess-1",
        turn: 1,
        type: "stale_edit_prevented",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      bw.record({
        session_id: "sess-1",
        turn: 1,
        type: "fact_recalled",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });

      const named = readNamedEvents(unerrDir, { session_id: "sess-1" });
      const counts = countNamedEventsByType(named);
      expect(counts.stale_edit_prevented).toBe(2);
      expect(counts.fact_recalled).toBe(1);
      expect(totalNamedEvents(named)).toBe(3);
    });

    it("returns zero for empty input", () => {
      expect(countNamedEventsByType([])).toEqual({});
      expect(totalNamedEvents([])).toBe(0);
    });
  });
});

// ── Native-session-id cross-process correlation ───────────────────────
//
// The root attribution bug: proxy writes code_edit_applied under session_id=A,
// UserPromptSubmit hook writes user_prompt_received under session_id=B, but
// both share native_session_id=N. When gatherReceiptInputs fetches by
// native_session_id=N, latestPromptBoundaryTs finds the boundary and
// currentTurnSlice includes ALL edits after it — not just one.

describe("readNamedEvents — native_session_id cross-process correlation", () => {
  let tmpDir: string;
  let unerrDir: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-native-id-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fetches rows from multiple session_ids that share native_session_id", () => {
    // Proxy-side: code_edit_applied under session_id=proxy-sess
    const proxyWriter = new BehaviorEventWriter(unerrDir, "proxy-sess");
    proxyWriter.record({
      session_id: "proxy-sess",
      native_session_id: "native-N",
      turn: 2,
      type: "code_edit_applied",
      tool: "file_edit",
      entity_key: "src/foo.ts",
      response_bytes: null,
    });

    // Hook-side: user_prompt_received under session_id=hook-sess (different!)
    const hookWriter = new BehaviorEventWriter(unerrDir, "hook-sess");
    hookWriter.record({
      session_id: "hook-sess",
      native_session_id: "native-N",
      turn: 1,
      type: "user_prompt_received",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });

    // Filter by native_session_id — must return BOTH rows despite different session_ids
    const named = readNamedEvents(unerrDir, { native_session_id: "native-N" });
    expect(named).toHaveLength(2);
    const types = named.map((e) => e.event_type).sort();
    expect(types).toEqual(["code_edit_applied", "user_prompt_received"]);
    // Both rows carry the native id in the projection
    expect(named.every((e) => e.native_session_id === "native-N")).toBe(true);
  });

  it("excludes rows whose native_session_id does not match", () => {
    const wA = new BehaviorEventWriter(unerrDir, "sess-A");
    wA.record({
      session_id: "sess-A",
      native_session_id: "native-N",
      turn: 1,
      type: "code_edit_applied",
      tool: "file_edit",
      entity_key: "src/bar.ts",
      response_bytes: null,
    });
    const wB = new BehaviorEventWriter(unerrDir, "sess-B");
    wB.record({
      session_id: "sess-B",
      native_session_id: "native-OTHER",
      turn: 1,
      type: "fact_recalled",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });

    const named = readNamedEvents(unerrDir, { native_session_id: "native-N" });
    expect(named).toHaveLength(1);
    expect(named[0]!.event_type).toBe("code_edit_applied");
  });

  it("falls back to session_id filter when native_session_id is not provided", () => {
    const w = new BehaviorEventWriter(unerrDir, "sess-X");
    w.record({
      session_id: "sess-X",
      native_session_id: "native-N",
      turn: 1,
      type: "cache_hit",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    const wY = new BehaviorEventWriter(unerrDir, "sess-Y");
    wY.record({
      session_id: "sess-Y",
      native_session_id: "native-N",
      turn: 1,
      type: "cache_hit",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });

    // Without native filter: each session_id returns only its own rows
    const x = readNamedEvents(unerrDir, { session_id: "sess-X" });
    const y = readNamedEvents(unerrDir, { session_id: "sess-Y" });
    expect(x).toHaveLength(1);
    expect(y).toHaveLength(1);
    expect(x[0]!.session_id).toBe("sess-X");
    expect(y[0]!.session_id).toBe("sess-Y");
  });

  it("cross-process: latestPromptBoundaryTs finds boundary written by hook session", () => {
    // Simulates the actual bug scenario: proxy session wrote edits, hook
    // session wrote the prompt boundary. When fetched by native_session_id,
    // latestPromptBoundaryTs should find the boundary.
    const baseMs = Date.now();

    const hookWriter = new BehaviorEventWriter(unerrDir, "hook-sess");
    hookWriter.record({
      session_id: "hook-sess",
      native_session_id: "native-N",
      turn: 1,
      type: "user_prompt_received",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });

    // Small delay to ensure proxy edits have later timestamps
    const proxyWriter = new BehaviorEventWriter(unerrDir, "proxy-sess");
    proxyWriter.record({
      session_id: "proxy-sess",
      native_session_id: "native-N",
      turn: 2,
      type: "code_edit_applied",
      tool: "file_edit",
      entity_key: "src/a.ts",
      response_bytes: null,
    });
    proxyWriter.record({
      session_id: "proxy-sess",
      native_session_id: "native-N",
      turn: 3,
      type: "code_edit_applied",
      tool: "file_edit",
      entity_key: "src/b.ts",
      response_bytes: null,
    });

    const named = readNamedEvents(unerrDir, { native_session_id: "native-N" });
    // Must have all 3 events (1 boundary + 2 edits)
    expect(named).toHaveLength(3);

    // latestPromptBoundaryTs must find the hook-written boundary
    const boundary = latestPromptBoundaryTs(named);
    expect(boundary).not.toBeNull();

    // currentTurnSlice must include BOTH edits (they are after the boundary)
    // Previously this returned at most 1 because the boundary was never found
    // when fetched by session_id=proxy-sess alone.
    const slice = currentTurnSlice(named, /*fallbackTurn*/ 3);
    const editEvents = slice.filter(
      (e) => e.event_type === "code_edit_applied"
    );
    expect(editEvents).toHaveLength(2);
    // entity_key paths are promoted to file_path by deriveFilePath; entity_key
    // becomes null when it equals the derived file_path (see deriveEntityKey).
    expect(editEvents.map((e) => e.file_path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});

// ── Conversational-turn windowing (prompt-boundary slice) ────────────

function mkNamed(
  event_type: string,
  ms: number,
  turn: number,
  extra: Partial<NamedEvent> = {}
): NamedEvent {
  return {
    event_type,
    verb: "",
    object: "",
    agent: "claude-code",
    file_path: null,
    entity_key: null,
    session_id: "s1",
    native_session_id: null,
    turn,
    ts: new Date(ms).toISOString(),
    metadata: {},
    ...extra,
  };
}

describe("latestPromptBoundaryTs", () => {
  it("returns null when no user_prompt_received event exists", () => {
    const events = [
      mkNamed("graph_query_served", 1000, 3),
      mkNamed("tokenflow.file_read", 2000, 4),
    ];
    expect(latestPromptBoundaryTs(events)).toBeNull();
  });

  it("returns the latest prompt boundary's epoch-ms", () => {
    const events = [
      mkNamed("user_prompt_received", 1000, 1),
      mkNamed("graph_query_served", 1500, 2),
      mkNamed("user_prompt_received", 5000, 5),
      mkNamed("tokenflow.file_read", 5500, 6),
    ];
    expect(latestPromptBoundaryTs(events)).toBe(5000);
  });
});

describe("currentTurnSlice", () => {
  it("slices to events at or after the latest prompt boundary", () => {
    const events = [
      mkNamed("user_prompt_received", 1000, 1),
      mkNamed("tokenflow.file_read", 1200, 1), // prev turn
      mkNamed("user_prompt_received", 5000, 9), // current turn boundary
      mkNamed("graph_query_served", 5100, 14), // segmenter fragmented turn
      mkNamed("tokenflow.shell_compression", 5300, 18),
    ];
    const slice = currentTurnSlice(events, /*fallbackTurn*/ 18);
    // The fragmented segmenter turns (9,14,18) all belong to ONE
    // conversational turn — the boundary slice keeps all three.
    expect(slice.map((e) => e.event_type)).toEqual([
      "user_prompt_received",
      "graph_query_served",
      "tokenflow.shell_compression",
    ]);
  });

  it("falls back to the segmenter turn match when no prompt boundary exists", () => {
    const events = [
      mkNamed("graph_query_served", 1000, 2),
      mkNamed("tokenflow.file_read", 2000, 3),
      mkNamed("tokenflow.shell_compression", 3000, 3),
    ];
    const slice = currentTurnSlice(events, /*fallbackTurn*/ 3);
    expect(slice).toHaveLength(2);
    expect(slice.every((e) => e.turn === 3)).toBe(true);
  });
});

describe("makeInCurrentTurn — single shared turn predicate", () => {
  // The receipt's headline token number, its concrete bullets, and its
  // attribution rows MUST agree on the turn window. They all build their
  // predicate here; these tests lock that one rule.

  it("boundary mode: keeps events at/after the latest prompt, by ts (ignoring turn)", () => {
    const events = [
      mkNamed("user_prompt_received", 1000, 1),
      mkNamed("user_prompt_received", 5000, 9),
    ];
    const inTurn = makeInCurrentTurn(events, /*fallbackTurn*/ 99);
    // After the boundary — segmenter turn is irrelevant.
    expect(inTurn(new Date(5000).toISOString(), 14)).toBe(true);
    expect(inTurn(new Date(6000).toISOString(), 2)).toBe(true);
    // Before the boundary — excluded even if turn matches fallback.
    expect(inTurn(new Date(4999).toISOString(), 99)).toBe(false);
  });

  it("fallback mode: matches the segmenter turn when no boundary was recorded", () => {
    const events = [mkNamed("graph_query_served", 1000, 3)];
    const inTurn = makeInCurrentTurn(events, /*fallbackTurn*/ 3);
    expect(inTurn(new Date(1000).toISOString(), 3)).toBe(true);
    expect(inTurn(new Date(9999).toISOString(), 2)).toBe(false);
  });

  it("currentTurnSlice is exactly events filtered by this predicate (no drift)", () => {
    // Veracity guarantee: the bullet slice (currentTurnSlice) and any other
    // consumer that filters raw rows with makeInCurrentTurn select the same
    // window — so the headline number can never describe a different turn
    // than the bullets.
    const events = [
      mkNamed("user_prompt_received", 1000, 1),
      mkNamed("tokenflow.file_read", 900, 1), // before boundary
      mkNamed("user_prompt_received", 5000, 9), // boundary
      mkNamed("tokenflow.shell_compression", 5500, 14),
    ];
    const inTurn = makeInCurrentTurn(events, 14);
    const viaPredicate = events.filter((e) => inTurn(e.ts, e.turn));
    const viaSlice = currentTurnSlice(events, 14);
    expect(viaSlice).toEqual(viaPredicate);
  });
});

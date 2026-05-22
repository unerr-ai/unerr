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
  countNamedEventsByType,
  getPhrasing,
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

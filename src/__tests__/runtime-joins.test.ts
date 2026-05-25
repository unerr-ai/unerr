/**
 * Fix L — cross-tier correlation joins (`computeRuntimeJoins` +
 * `renderRuntimeJoinSegment`).
 *
 * Pure projection tests — no IO. Covers zero events, single-axis events,
 * pairwise joins, three-way joins, multi-entity grouping, and the
 * backwards-compat invariant (zero counts → empty segment).
 */

import { describe, expect, it } from "vitest";
import type { NamedEvent } from "../tracking/named-events.js";
import {
  computeRuntimeJoins,
  renderRuntimeJoinSegment,
} from "../tracking/runtime-joins.js";

function makeEvent(
  eventType: string,
  entityKey: string,
  sessionId = "s1",
  turn = 1
): NamedEvent {
  return {
    event_type: eventType,
    verb: eventType,
    object: entityKey,
    agent: "claude-code",
    file_path: entityKey,
    entity_key: entityKey,
    session_id: sessionId,
    turn,
    ts: new Date().toISOString(),
    metadata: {},
  } as NamedEvent;
}

describe("computeRuntimeJoins (Fix L)", () => {
  it("returns all zeros when no events fire", () => {
    const j = computeRuntimeJoins([], "s1", 1);
    expect(j.memory_to_graph).toBe(0);
    expect(j.graph_to_drift).toBe(0);
    expect(j.three_way).toBe(0);
    expect(j.entities).toEqual([]);
  });

  it("ignores events from other sessions / other turns", () => {
    const events = [
      makeEvent("fact_recalled", "foo.ts", "s1", 1),
      makeEvent("graph_query_served", "foo.ts", "s1", 2), // wrong turn
      makeEvent("graph_query_served", "foo.ts", "s2", 1), // wrong session
    ];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.memory_to_graph).toBe(0);
  });

  it("memory-only events produce no joins", () => {
    const events = [makeEvent("fact_recalled", "foo.ts")];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.memory_to_graph).toBe(0);
    expect(j.entities).toEqual(["foo.ts"]);
  });

  it("graph-only events produce no joins", () => {
    const events = [makeEvent("graph_query_served", "foo.ts")];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.memory_to_graph).toBe(0);
    expect(j.graph_to_drift).toBe(0);
  });

  it("memory + graph on same entity → 1 memory-to-graph join", () => {
    const events = [
      makeEvent("fact_recalled", "foo.ts"),
      makeEvent("graph_query_served", "foo.ts"),
    ];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.memory_to_graph).toBe(1);
    expect(j.graph_to_drift).toBe(0);
    expect(j.three_way).toBe(0);
  });

  it("graph + drift on same entity → 1 graph-to-drift join", () => {
    const events = [
      makeEvent("graph_query_served", "foo.ts"),
      makeEvent("drift_consumed", "foo.ts"),
    ];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.memory_to_graph).toBe(0);
    expect(j.graph_to_drift).toBe(1);
    expect(j.three_way).toBe(0);
  });

  it("memory + graph + drift on same entity → 1 three-way join", () => {
    const events = [
      makeEvent("fact_recalled", "foo.ts"),
      makeEvent("graph_query_served", "foo.ts"),
      makeEvent("drift_consumed", "foo.ts"),
    ];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.memory_to_graph).toBe(1);
    expect(j.graph_to_drift).toBe(1);
    expect(j.three_way).toBe(1);
  });

  it("multi-entity grouping is correct", () => {
    const events = [
      makeEvent("fact_recalled", "foo.ts"),
      makeEvent("graph_query_served", "foo.ts"),
      // bar.ts gets graph + drift only
      makeEvent("graph_query_served", "bar.ts"),
      makeEvent("stale_edit_prevented", "bar.ts"),
      // baz.ts gets memory only — no join
      makeEvent("fact_recalled", "baz.ts"),
    ];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.memory_to_graph).toBe(1); // foo.ts
    expect(j.graph_to_drift).toBe(1); // bar.ts
    expect(j.three_way).toBe(0);
    expect(j.entities).toEqual(["bar.ts", "baz.ts", "foo.ts"]);
  });
});

describe("renderRuntimeJoinSegment (Fix L)", () => {
  it("returns empty string when all counts are zero", () => {
    expect(
      renderRuntimeJoinSegment({
        memory_to_graph: 0,
        graph_to_drift: 0,
        three_way: 0,
        entities: [],
      })
    ).toBe("");
  });

  it("renders memory-to-graph segment with singular form", () => {
    const out = renderRuntimeJoinSegment({
      memory_to_graph: 1,
      graph_to_drift: 0,
      three_way: 0,
      entities: ["foo.ts"],
    });
    expect(out).toMatch(/⚡ unerr runtime/);
    expect(out).toMatch(/1 memory fact joined to 1 live graph node/);
  });

  it("renders memory-to-graph segment with plural form", () => {
    const out = renderRuntimeJoinSegment({
      memory_to_graph: 3,
      graph_to_drift: 0,
      three_way: 0,
      entities: [],
    });
    expect(out).toMatch(/3 memory facts joined to 3 live graph nodes/);
  });

  it("composes all three segments with pipe separators", () => {
    const out = renderRuntimeJoinSegment({
      memory_to_graph: 2,
      graph_to_drift: 1,
      three_way: 1,
      entities: [],
    });
    expect(out).toMatch(/2 memory facts joined to 2 live graph nodes/);
    expect(out).toMatch(/1 drift conflict resolved against graph/);
    expect(out).toMatch(/1 three-way correlation confirmed/);
    // Each segment separated by pipe
    expect(out.split(" | ").length).toBe(3);
  });
});

/**
 * Fix L — cross-tier correlation joins (`computeRuntimeJoins` +
 * `renderRuntimeJoinSegment`).
 *
 * Pure projection tests — no IO. Covers zero events, single-axis events,
 * the graph-to-drift join, multi-entity grouping, and the backwards-compat
 * invariant (zero count → empty segment).
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
    expect(j.graph_to_drift).toBe(0);
    expect(j.entities).toEqual([]);
  });

  it("ignores events from other sessions / other turns", () => {
    const events = [
      makeEvent("graph_query_served", "foo.ts", "s1", 1),
      makeEvent("drift_consumed", "foo.ts", "s1", 2), // wrong turn
      makeEvent("drift_consumed", "foo.ts", "s2", 1), // wrong session
    ];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.graph_to_drift).toBe(0);
  });

  it("graph-only events produce no joins", () => {
    const events = [makeEvent("graph_query_served", "foo.ts")];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.graph_to_drift).toBe(0);
    expect(j.entities).toEqual(["foo.ts"]);
  });

  it("graph + drift on same entity → 1 graph-to-drift join", () => {
    const events = [
      makeEvent("graph_query_served", "foo.ts"),
      makeEvent("drift_consumed", "foo.ts"),
    ];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.graph_to_drift).toBe(1);
  });

  it("multi-entity grouping is correct", () => {
    const events = [
      // foo.ts gets graph + drift → 1 join
      makeEvent("graph_query_served", "foo.ts"),
      makeEvent("drift_consumed", "foo.ts"),
      // bar.ts gets graph only — no join
      makeEvent("graph_query_served", "bar.ts"),
    ];
    const j = computeRuntimeJoins(events, "s1", 1);
    expect(j.graph_to_drift).toBe(1); // foo.ts
    expect(j.entities).toEqual(["bar.ts", "foo.ts"]);
  });
});

describe("renderRuntimeJoinSegment (Fix L)", () => {
  it("returns empty string when the count is zero", () => {
    expect(
      renderRuntimeJoinSegment({
        graph_to_drift: 0,
        entities: [],
      })
    ).toBe("");
  });

  it("renders the graph-to-drift segment with singular form", () => {
    const out = renderRuntimeJoinSegment({
      graph_to_drift: 1,
      entities: ["foo.ts"],
    });
    expect(out).toMatch(/⚡ unerr runtime/);
    expect(out).toMatch(/1 drift conflict resolved against graph/);
  });

  it("renders the graph-to-drift segment with plural form", () => {
    const out = renderRuntimeJoinSegment({
      graph_to_drift: 3,
      entities: [],
    });
    expect(out).toMatch(/3 drift conflicts resolved against graph/);
  });
});

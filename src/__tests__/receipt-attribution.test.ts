import { describe, expect, it } from "vitest";
import { extractReceiptAttribution } from "../proxy/receipt-attribution.js";
import type { NamedEvent } from "../tracking/named-events.js";

function event(
  partial: Partial<NamedEvent> & Pick<NamedEvent, "event_type" | "turn">
): NamedEvent {
  return {
    event_type: partial.event_type,
    verb: partial.verb ?? "fired",
    object: partial.object ?? "event",
    agent: partial.agent ?? "test",
    file_path: partial.file_path ?? null,
    entity_key: partial.entity_key ?? null,
    session_id: partial.session_id ?? "test-session",
    native_session_id: partial.native_session_id ?? null,
    turn: partial.turn,
    ts: partial.ts ?? "2026-05-25T00:00:00.000Z",
    metadata: partial.metadata ?? {},
  };
}

describe("extractReceiptAttribution", () => {
  it("returns empty payload when no events fired this turn", () => {
    const result = extractReceiptAttribution([], 1);
    expect(result).toEqual({ recalls: [], drift: [] });
  });

  it("filters events to the requested turn only", () => {
    const events: NamedEvent[] = [
      event({ event_type: "trace_recalled", turn: 1, metadata: { count: 3 } }),
      event({ event_type: "trace_recalled", turn: 2, metadata: { count: 7 } }),
    ];
    const result = extractReceiptAttribution(events, 2);
    expect(result.recalls).toEqual([{ count: 7 }]);
  });

  it("trace_recalled carries the surfaced population from metadata.count", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "trace_recalled",
        turn: 1,
        metadata: { count: 2 },
      }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.recalls).toEqual([{ count: 2 }]);
  });

  it("convention_applied is no longer classified as a recall", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "convention_applied",
        turn: 1,
        metadata: { content: "use _ for unused args" },
      }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.recalls).toEqual([]);
  });

  it("drift_consumed deduplicates by file_path", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "drift_consumed",
        turn: 1,
        file_path: "src/proxy/bridge.ts",
      }),
      event({
        event_type: "drift_consumed",
        turn: 1,
        file_path: "src/proxy/bridge.ts",
      }),
      event({
        event_type: "drift_consumed",
        turn: 1,
        file_path: "src/proxy/proxy.ts",
      }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.drift).toEqual([
      { file_path: "src/proxy/bridge.ts" },
      { file_path: "src/proxy/proxy.ts" },
    ]);
  });

  it("skips a trace_recalled event with no positive count (defensive — writer didn't stamp one)", () => {
    const events: NamedEvent[] = [
      event({ event_type: "trace_recalled", turn: 1, metadata: {} }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.recalls).toEqual([]);
  });

  it("classifies a mixed-event turn into recall + drift", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "trace_recalled",
        turn: 5,
        metadata: { count: 4 },
      }),
      event({
        event_type: "drift_consumed",
        turn: 5,
        file_path: "src/x.ts",
      }),
      event({
        event_type: "graph_query_served",
        turn: 5,
        metadata: { content: "unrelated" },
      }),
    ];
    const result = extractReceiptAttribution(events, 5);
    expect(result.recalls).toEqual([{ count: 4 }]);
    expect(result.drift).toEqual([{ file_path: "src/x.ts" }]);
  });
});

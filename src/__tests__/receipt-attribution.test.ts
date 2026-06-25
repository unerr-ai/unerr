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
    expect(result).toEqual({ recalls: [], captures: [], drift: [] });
  });

  it("filters events to the requested turn only", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "fact_recalled",
        turn: 1,
        metadata: { content: "rule A" },
      }),
      event({
        event_type: "fact_recalled",
        turn: 2,
        metadata: { content: "rule B" },
      }),
    ];
    const result = extractReceiptAttribution(events, 2);
    expect(result.recalls).toEqual([{ content: "rule B" }]);
  });

  it("recall reads metadata.top_content when content is absent", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "fact_recalled",
        turn: 1,
        metadata: {
          top_content: "no console.log in production",
          top_anchor_value: "src/index.ts",
        },
      }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.recalls).toEqual([
      { content: "no console.log in production", scope: "src/index.ts" },
    ]);
  });

  it("recall falls back through content → top_content → fact_content priority", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "fact_recalled",
        turn: 1,
        metadata: { fact_content: "legacy alias" },
      }),
    ];
    expect(extractReceiptAttribution(events, 1).recalls).toEqual([
      { content: "legacy alias" },
    ]);
  });

  it("capture (user_fed) carries source_quote when present", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "fact_stored_user_fed",
        turn: 1,
        metadata: {
          content: "tests live next to code",
          source_quote: "remember tests live next to code",
          scope: "project",
        },
      }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.captures).toEqual([
      {
        content: "tests live next to code",
        source_quote: "remember tests live next to code",
        scope: "project",
      },
    ]);
  });

  it("capture (agent_explicit) routes through capture extraction with file_path scope fallback", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "fact_stored_auto",
        turn: 1,
        file_path: "src/proxy/proxy.ts",
        metadata: { content: "agent observed convention" },
      }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.captures).toEqual([
      { content: "agent observed convention", scope: "src/proxy/proxy.ts" },
    ]);
  });

  it("convention_applied is classified as a recall", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "convention_applied",
        turn: 1,
        metadata: { content: "use _ for unused args" },
      }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.recalls).toEqual([{ content: "use _ for unused args" }]);
    expect(result.captures).toEqual([]);
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

  it("skips events with no content (defensive — writer didn't stamp text)", () => {
    const events: NamedEvent[] = [
      event({ event_type: "fact_recalled", turn: 1, metadata: {} }),
      event({ event_type: "fact_stored_user_fed", turn: 1, metadata: {} }),
    ];
    const result = extractReceiptAttribution(events, 1);
    expect(result.recalls).toEqual([]);
    expect(result.captures).toEqual([]);
  });

  it("classifies mixed-event turn into all three buckets", () => {
    const events: NamedEvent[] = [
      event({
        event_type: "fact_recalled",
        turn: 5,
        metadata: { top_content: "rule A" },
      }),
      event({
        event_type: "fact_stored_user_fed",
        turn: 5,
        metadata: { content: "use Foo for Bar", source_quote: "always Foo" },
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
    expect(result.recalls).toEqual([{ content: "rule A" }]);
    expect(result.captures).toEqual([
      { content: "use Foo for Bar", source_quote: "always Foo" },
    ]);
    expect(result.drift).toEqual([{ file_path: "src/x.ts" }]);
  });
});

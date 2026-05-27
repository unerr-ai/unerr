/**
 * Tests for the close-out summary MCP tool (`unerr_turn_summary`).
 *
 * Covers:
 *   1. `renderHybridTurnLine` honest-zero + populated cases.
 *   2. `renderSessionEconomyLineLive` reads token_flow_events + behavior_events.
 *   3. `handleTurnSummaryProxy` returns the expected envelope shape.
 *   4. Tool is registered in TIER_ENTRIES as tier 1 with the expected schema.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TOOL_DEFINITIONS } from "../proxy/tool-definitions.js";
import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";
import {
  renderHybridTurnLine,
  renderSessionEconomyLineLive,
} from "../proxy/turn-footer.js";
import { handleTurnSummaryProxy } from "../proxy/turn-summary-handler.js";
import type { NamedEvent } from "../tracking/named-events.js";

describe("renderHybridTurnLine", () => {
  const sampleTurnEvent = (event_type: string, turn = 5): NamedEvent => ({
    event_type,
    verb: "served",
    object: "code lookup",
    agent: "test",
    file_path: null,
    entity_key: null,
    session_id: "s",
    turn,
    ts: "2026-05-24T00:00:00.000Z",
    metadata: {},
  });

  it("honest-zero when both turn and session are empty", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 0,
      turnEvents: [],
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      sessionTotalEvents: 0,
      sessionHighlightsPhrase: "",
    });
    expect(line).toBe("this turn: nothing to act on yet");
  });

  it("renders the hybrid form when turn saved tokens and session has totals", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 33_210,
      turnEvents: [
        sampleTurnEvent("tokenflow.file_read"),
        sampleTurnEvent("graph_query_served"),
        sampleTurnEvent("graph_query_served"),
      ],
      sessionTokensSaved: 100_175,
      sessionHeadroom: 3,
      sessionTotalEvents: 41,
      sessionHighlightsPhrase: "41 code lookups",
    });
    expect(line).toContain("this turn: +33,210 tokens");
    expect(line).toContain("2 code lookups");
    expect(line).toContain("1 trimmed file read");
    expect(line).toContain("session: 100k saved");
    expect(line).toContain("~3 turns of chat room earned");
  });

  it("quiet turn leads with descriptive session activity", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 0,
      turnEvents: [],
      sessionTokensSaved: 50_000,
      sessionHeadroom: 37,
      sessionTotalEvents: 84,
      sessionHighlightsPhrase:
        "41 recalled notes, 26 trimmed shell outputs, 17 code lookups",
    });
    expect(line).toBe(
      "session: 41 recalled notes, 26 trimmed shell outputs, 17 code lookups · 50k saved, ~37 turns of chat room earned"
    );
    // Never the bare per-turn collapse.
    expect(line).not.toContain("this turn:");
  });

  it("quiet turn with no nameable activity still shows the session tail", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 0,
      turnEvents: [],
      sessionTokensSaved: 100_000,
      sessionHeadroom: 2,
      sessionTotalEvents: 20,
      sessionHighlightsPhrase: "",
    });
    expect(line).toBe("session: 100k saved, ~2 turns of chat room earned");
  });

  it("quiet turn with neither activity nor session savings → no new savings", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 0,
      turnEvents: [sampleTurnEvent("graph_query_served")],
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      sessionTotalEvents: 3,
      sessionHighlightsPhrase: "",
    });
    expect(line).toBe("this turn: no new savings");
  });

  it("singular 'turn' when session headroom is 1", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 200,
      turnEvents: [sampleTurnEvent("graph_query_served")],
      sessionTokensSaved: 200,
      sessionHeadroom: 1,
      sessionTotalEvents: 1,
      sessionHighlightsPhrase: "1 code lookup",
    });
    expect(line).toContain("~1 turn of chat room earned");
  });

  it("omits the parenthetical when turn had token savings but no NamedEvents", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 500,
      turnEvents: [],
      sessionTokensSaved: 500,
      sessionHeadroom: 0,
      sessionTotalEvents: 1,
      sessionHighlightsPhrase: "",
    });
    expect(line).toBe("this turn: +500 tokens · session: 500 saved");
  });
});

describe("renderSessionEconomyLineLive", () => {
  let unerrDir: string;
  beforeEach(() => {
    unerrDir = mkdtempSync(join(tmpdir(), "unerr-turn-summary-"));
  });
  afterEach(() => {
    rmSync(unerrDir, { recursive: true, force: true });
  });

  it("returns honest-zero shape when .unerr/ is empty", () => {
    const data = renderSessionEconomyLineLive(unerrDir, "session-xyz", 1);
    expect(data.total_events).toBe(0);
    expect(data.total_tokens_saved).toBe(0);
    expect(data.headroom_compounded).toBe(0);
    expect(data.current_turn).toBe(1);
    expect(data.turn_events).toBe(0);
    expect(data.turn_tokens_saved).toBe(0);
    expect(data.line).toContain("nothing to act on yet");
  });

  it("returns the hybrid-form rendered line in the structured response", () => {
    const data = renderSessionEconomyLineLive(unerrDir, "session-xyz", 2);
    expect(data.line.startsWith("this turn:")).toBe(true);
  });
});

describe("handleTurnSummaryProxy", () => {
  let unerrDir: string;
  beforeEach(() => {
    unerrDir = mkdtempSync(join(tmpdir(), "unerr-turn-summary-handler-"));
  });
  afterEach(() => {
    rmSync(unerrDir, { recursive: true, force: true });
  });

  it("ships only {ok, line} on the wire — economy counters stay server-side", async () => {
    const result = await handleTurnSummaryProxy(unerrDir, "sess-X", 1);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.line).toBe("string");
    // The agent only ever pastes `line` (the close-out contract). The full
    // economy breakdown — events, savings, headroom, highlights — is dashboard
    // telemetry read off disk; it must NOT ride the agent-facing wire.
    expect(Object.keys(parsed).sort()).toEqual(["line", "ok"]);
    expect(parsed.total_events).toBeUndefined();
    expect(parsed.total_tokens_saved).toBeUndefined();
    expect(parsed.headroom_compounded).toBeUndefined();
    expect(parsed.turn_highlights).toBeUndefined();
  });

  it("does not mark isError on empty session", async () => {
    const result = await handleTurnSummaryProxy(unerrDir, "sess-empty", 1);
    expect(result.isError).toBeUndefined();
  });
});

describe("unerr_turn_summary tool registration", () => {
  it("is registered as tier 1 in TIER_ENTRIES", () => {
    const entry = TIER_ENTRIES.unerr_turn_summary;
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe(1);
    expect(entry?.active).toContain("end of every coding turn");
  });

  it("has a tool definition with empty input schema", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === "unerr_turn_summary");
    expect(def).toBeDefined();
    expect(def?.inputSchema.type).toBe("object");
    expect(def?.annotations?.readOnlyHint).toBe(true);
  });
});

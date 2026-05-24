/**
 * Tests for the close-out summary MCP tool (`unerr_turn_summary`).
 *
 * Covers:
 *   1. `renderSessionEconomyLine` honest-zero + populated cases.
 *   2. `renderSessionEconomyLineLive` reads token_flow_events + behavior_events.
 *   3. `handleTurnSummaryProxy` returns the expected envelope shape.
 *   4. Tool is registered in TIER_ENTRIES as tier 1 with the expected schema.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";
import { TOOL_DEFINITIONS } from "../proxy/tool-definitions.js";
import {
  renderHybridTurnLine,
  renderSessionEconomyLine,
  renderSessionEconomyLineLive,
} from "../proxy/turn-footer.js";
import { handleTurnSummaryProxy } from "../proxy/turn-summary-handler.js";
import type { NamedEvent } from "../tracking/named-events.js";

describe("renderSessionEconomyLine", () => {
  it("renders honest-zero when nothing happened", () => {
    const line = renderSessionEconomyLine({
      totalEvents: 0,
      totalTokensSaved: 0,
      headroomCompounded: 0,
    });
    expect(line).toBe("your session: nothing to act on yet");
  });

  it("renders populated session with exact integer + headroom", () => {
    const line = renderSessionEconomyLine({
      totalEvents: 7,
      totalTokensSaved: 2400,
      headroomCompounded: 3,
    });
    expect(line).toBe(
      "your session: saved 2,400 tokens · kept ~3 extra turns of chat room"
    );
  });

  it("uses singular 'turn' when headroom is 1", () => {
    const line = renderSessionEconomyLine({
      totalEvents: 1,
      totalTokensSaved: 100,
      headroomCompounded: 1,
    });
    expect(line).toContain("saved 100 tokens");
    expect(line).toContain("kept ~1 extra turn of chat room");
  });

  it("names the topFile when present", () => {
    const line = renderSessionEconomyLine({
      totalEvents: 4,
      totalTokensSaved: 1234,
      headroomCompounded: 2,
      topFile: "src/proxy/bridge.ts",
    });
    expect(line).toContain("saved 1,234 tokens");
    expect(line).toContain("your context: src/proxy/bridge.ts");
  });

  it("names a verbatim recalled note with age", () => {
    const now = 1_700_000_000_000;
    const threeDaysAgo = now - 3 * 86_400_000;
    const line = renderSessionEconomyLine({
      totalEvents: 2,
      totalTokensSaved: 500,
      headroomCompounded: 0,
      topNoteContent: "no intelligence imports in bridge.ts",
      topNoteCreatedAt: threeDaysAgo,
      nowMs: now,
    });
    expect(line).toContain(
      'remembered: "no intelligence imports in bridge.ts" (you set 3d ago)'
    );
  });
});

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
    });
    expect(line).toContain("this turn: +33,210 tokens");
    expect(line).toContain("2 code lookups");
    expect(line).toContain("1 trimmed file read");
    expect(line).toContain("session: 100k saved");
    expect(line).toContain("~3 turns of chat room kept");
  });

  it("turn-empty / session-nonempty falls back to 'no new savings'", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 0,
      turnEvents: [],
      sessionTokensSaved: 100_000,
      sessionHeadroom: 2,
      sessionTotalEvents: 20,
    });
    expect(line).toContain("this turn: no new savings");
    expect(line).toContain("session: 100k saved");
    expect(line).toContain("~2 turns of chat room kept");
  });

  it("turn had events but no token savings", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 0,
      turnEvents: [sampleTurnEvent("graph_query_served")],
      sessionTokensSaved: 5000,
      sessionHeadroom: 0,
      sessionTotalEvents: 3,
    });
    expect(line).toContain("this turn: 1 code lookup (no new token savings)");
    expect(line).toContain("session: 5.0k saved");
  });

  it("singular 'turn' when session headroom is 1", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 200,
      turnEvents: [sampleTurnEvent("graph_query_served")],
      sessionTokensSaved: 200,
      sessionHeadroom: 1,
      sessionTotalEvents: 1,
    });
    expect(line).toContain("~1 turn of chat room kept");
  });

  it("omits the parenthetical when turn had token savings but no NamedEvents", () => {
    const line = renderHybridTurnLine({
      turnTokensSaved: 500,
      turnEvents: [],
      sessionTokensSaved: 500,
      sessionHeadroom: 0,
      sessionTotalEvents: 1,
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

  it("returns MCP envelope with line + structured breakdown", async () => {
    const result = await handleTurnSummaryProxy(unerrDir, "sess-X", 1);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.line).toBe("string");
    expect(typeof parsed.total_events).toBe("number");
    expect(typeof parsed.total_tokens_saved).toBe("number");
    expect(typeof parsed.headroom_compounded).toBe("number");
    expect(typeof parsed.current_turn).toBe("number");
    expect(typeof parsed.turn_events).toBe("number");
    expect(typeof parsed.turn_tokens_saved).toBe("number");
    expect(Array.isArray(parsed.turn_highlights)).toBe(true);
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

/**
 * P8 — Agent + turn attribution contract.
 *
 * Verifies the end-to-end attribution path established by P1-P7:
 *   - Writers stamp `agent` from constructor / setAgent / per-call input.
 *   - `agent` round-trips through the SQLite layer (column added in P1).
 *   - Per-call agent override wins over the stored agent (multi-client
 *     daemon case from P7).
 *   - Turn provider supplies turn number from TurnSegmenter, not from
 *     ad-hoc counters (P4).
 *   - resolveAgentId honours the documented chain: codingAgent flag >
 *     clientInfo.name > env detect > "unknown" (P2).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentId } from "../config/agent-registry.js";
import {
  BehaviorEventWriter,
  readBehaviorEvents,
} from "../tracking/behavior-events.js";
import {
  TokenFlowWriter,
  readTokenFlowEvents,
} from "../tracking/token-flow.js";
import { TurnSegmenter } from "../tracking/turn-segmenter.js";

describe("agent + turn attribution", () => {
  let unerrDir: string;

  beforeEach(() => {
    unerrDir = mkdtempSync(join(tmpdir(), "unerr-attrib-"));
  });

  afterEach(() => {
    rmSync(unerrDir, { recursive: true, force: true });
  });

  describe("resolveAgentId (P2)", () => {
    it("prefers codingAgent flag over clientInfo and env", () => {
      const id = resolveAgentId({
        codingAgent: "claude-code",
        clientInfoName: "Cursor",
        detectFromEnv: () => "cursor",
      });
      expect(id).toBe("claude-code");
    });

    it("falls back to clientInfo when codingAgent is null", () => {
      const id = resolveAgentId({
        codingAgent: null,
        clientInfoName: "Cursor",
        detectFromEnv: () => "claude-code",
      });
      // normalizeAgentName lowercases the input
      expect(id).toBe("cursor");
    });

    it("falls back to env detect when both prior sources are empty", () => {
      const id = resolveAgentId({
        codingAgent: null,
        clientInfoName: null,
        detectFromEnv: () => "antigravity",
      });
      expect(id).toBe("antigravity");
    });

    it("returns 'unknown' when no source yields a value", () => {
      expect(
        resolveAgentId({
          codingAgent: null,
          clientInfoName: null,
          detectFromEnv: () => null,
        })
      ).toBe("unknown");
    });

    it("normalizes aliases (claude → claude-code, copilot → github-copilot-cli)", () => {
      expect(
        resolveAgentId({
          codingAgent: "claude",
          clientInfoName: null,
          detectFromEnv: () => null,
        })
      ).toBe("claude-code");
      expect(
        resolveAgentId({
          codingAgent: "copilot",
          clientInfoName: null,
          detectFromEnv: () => null,
        })
      ).toBe("github-copilot-cli");
    });

    it("trims whitespace before resolving", () => {
      expect(
        resolveAgentId({
          codingAgent: "  cursor  ",
          clientInfoName: null,
          detectFromEnv: () => null,
        })
      ).toBe("cursor");
    });
  });

  describe("BehaviorEventWriter agent stamping (P3, P7)", () => {
    it("stamps the constructor-supplied agent on every event", () => {
      const writer = new BehaviorEventWriter(unerrDir, "sess-A", {
        agent: "claude-code",
      });
      writer.record({
        session_id: "sess-A",
        type: "loop_broken",
        tool: "search_code",
        entity_key: "foo",
        response_bytes: null,
      });
      writer.record({
        session_id: "sess-A",
        type: "cascade_guard",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });

      const rows = readBehaviorEvents(unerrDir, { session_id: "sess-A" });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.agent === "claude-code")).toBe(true);
    });

    it("setAgent updates subsequent rows without touching prior ones", () => {
      const writer = new BehaviorEventWriter(unerrDir, "sess-A", {
        agent: "claude-code",
      });
      writer.record({
        session_id: "sess-A",
        type: "loop_broken",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      writer.setAgent("cursor");
      writer.record({
        session_id: "sess-A",
        type: "cascade_guard",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });

      const rows = readBehaviorEvents(unerrDir, { session_id: "sess-A" });
      expect(rows[0]?.agent).toBe("claude-code");
      expect(rows[1]?.agent).toBe("cursor");
    });

    it("per-call agent override beats the stored agent", () => {
      const writer = new BehaviorEventWriter(unerrDir, "sess-A", {
        agent: "claude-code",
      });
      writer.record({
        session_id: "sess-A",
        agent: "cursor",
        type: "loop_broken",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      const rows = readBehaviorEvents(unerrDir, { session_id: "sess-A" });
      expect(rows[0]?.agent).toBe("cursor");
      // stored agent untouched
      expect(writer.getAgent()).toBe("claude-code");
    });

    it("defaults to 'unknown' when no agent supplied anywhere", () => {
      const writer = new BehaviorEventWriter(unerrDir, "sess-A");
      writer.record({
        session_id: "sess-A",
        type: "loop_broken",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      const rows = readBehaviorEvents(unerrDir, { session_id: "sess-A" });
      expect(rows[0]?.agent).toBe("unknown");
    });
  });

  describe("TokenFlowWriter agent stamping (P3, P7)", () => {
    it("stamps constructor-supplied agent on every event", () => {
      const writer = new TokenFlowWriter(unerrDir, "sess-T", {
        agent: "cursor",
      });
      writer.record({
        session_id: "sess-T",
        mechanism: "graph_query",
        tool: "search_code",
        tokens_without: 1000,
        tokens_with: 200,
        tokens_saved: 800,
      });
      const rows = readTokenFlowEvents(unerrDir, { session_id: "sess-T" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent).toBe("cursor");
    });

    it("per-call agent override beats the stored agent", () => {
      const writer = new TokenFlowWriter(unerrDir, "sess-T", {
        agent: "claude-code",
      });
      writer.record({
        session_id: "sess-T",
        agent: "antigravity",
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 500,
        tokens_with: 100,
        tokens_saved: 400,
      });
      const rows = readTokenFlowEvents(unerrDir, { session_id: "sess-T" });
      expect(rows[0]?.agent).toBe("antigravity");
    });
  });

  describe("turn provider supplies canonical turn number (P4)", () => {
    it("BehaviorEventWriter pulls turn from the TurnSegmenter at record time", () => {
      const segmenter = new TurnSegmenter();
      const writer = new BehaviorEventWriter(unerrDir, "sess-X", {
        agent: "claude-code",
        turnProvider: () => segmenter.getCurrentTurnNumber("sess-X"),
      });

      // No turn open yet — record stamps turn 0.
      writer.record({
        session_id: "sess-X",
        type: "loop_broken",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });

      // Open turn 1 via the boundary helper.
      segmenter.noteTurnOpen("sess-X");
      writer.record({
        session_id: "sess-X",
        type: "loop_broken",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      // Same turn — same number.
      writer.record({
        session_id: "sess-X",
        type: "cascade_guard",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });

      // Stop hook closes turn 1, next noteTurnOpen opens turn 2.
      segmenter.closeTurn("sess-X", "stop_hook");
      segmenter.noteTurnOpen("sess-X");
      writer.record({
        session_id: "sess-X",
        type: "loop_broken",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });

      const rows = readBehaviorEvents(unerrDir, { session_id: "sess-X" });
      expect(rows.map((r) => r.turn)).toEqual([0, 1, 1, 2]);
    });

    it("per-call turn override wins over the provider", () => {
      const writer = new BehaviorEventWriter(unerrDir, "sess-X", {
        agent: "claude-code",
        turnProvider: () => 5,
      });
      writer.record({
        session_id: "sess-X",
        turn: 42,
        type: "loop_broken",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      const rows = readBehaviorEvents(unerrDir, { session_id: "sess-X" });
      expect(rows[0]?.turn).toBe(42);
    });
  });

  describe("multi-agent daemon scenario (P7)", () => {
    it("two coding agents writing to the same writer keep distinct rows via per-call override", () => {
      // Daemon model: single proxy + writer shared across multiple bridged
      // IDEs. clientId → agent map lives in the proxy; the writer is told
      // per-call which agent's row this is.
      const writer = new BehaviorEventWriter(unerrDir, "shared-session", {
        agent: "claude-code", // last-writer-wins fallback
      });

      writer.record({
        session_id: "shared-session",
        agent: "claude-code",
        type: "loop_broken",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      writer.record({
        session_id: "shared-session",
        agent: "cursor",
        type: "cascade_guard",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
      writer.record({
        session_id: "shared-session",
        agent: "codex",
        type: "drift_consumed",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });

      const rows = readBehaviorEvents(unerrDir, {
        session_id: "shared-session",
      });
      const agents = rows.map((r) => r.agent);
      expect(agents).toEqual(["claude-code", "cursor", "codex"]);
    });
  });
});

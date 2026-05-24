/**
 * Phase 1 wire-up — proves `buildUserBlockForResponse` actually emits
 * the Surface 2 preface + Surface 3 footer onto the response body when
 * the named-events / token-flow ledgers carry data. This is the
 * integration test the production wire was missing before — every
 * previous test exercised the renderers in isolation, none verified
 * that the emitter composes them through the same channel the proxy
 * uses on every tool call.
 */

import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAllAmbientMarkers } from "../proxy/ambient-marker.js";
import {
  USER_BLOCK_AMBIENT,
  USER_BLOCK_PREFIX,
} from "../proxy/response-envelope.js";
import { resetTurnStateForTests } from "../proxy/turn-state.js";
import { buildUserBlockForResponse } from "../proxy/user-block-emitter.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";
import { TokenFlowWriter } from "../tracking/token-flow.js";

describe("surface wiring — buildUserBlockForResponse", () => {
  let tmpDir: string;
  let unerrDir: string;
  let sessionId: string;
  let nowMs: number;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-surface-wiring-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
    sessionId = `wire-sess-${Math.random().toString(36).slice(2, 8)}`;
    nowMs = 1_700_000_000_000;
    resetTurnStateForTests();
    resetAllAmbientMarkers();
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders preface head on first call and emits empty tail (Surface 3 is now MCP-tool-driven)", async () => {
    const tokenWriter = new TokenFlowWriter(unerrDir, sessionId);
    tokenWriter.record({
      session_id: sessionId,
      turn: 0,
      mechanism: "graph_query",
      tool: "get_references",
      tokens_without: 5_000,
      tokens_with: 800,
      tokens_saved: 4_200,
    });
    const behaviorWriter = new BehaviorEventWriter(unerrDir, sessionId);
    behaviorWriter.record({
      session_id: sessionId,
      turn: 0,
      type: "stale_edit_prevented",
      tool: "edit",
      entity_key: "src/foo.ts",
      response_bytes: null,
    });

    const first = await buildUserBlockForResponse({
      unerrDir,
      sessionId,
      toolCallCount: 0,
      filePath: "src/foo.ts",
      now: nowMs,
    });

    // First call is always turn-open → preface block is non-empty.
    expect(first.head).toContain(USER_BLOCK_PREFIX);
    // Surface 3 (end-of-turn footer) no longer auto-attaches to every
    // response — the agent now fetches it once via `unerr_turn_summary`
    // at end-of-turn and includes the rendered line verbatim in its
    // closing message. Tail is always empty (unless the ambient-marker
    // fallback fires; see the test below).
    expect(first.tail).toBe("");

    // Second call well below TURN_OPEN_GAP_MS later → same turn, no preface head.
    const second = await buildUserBlockForResponse({
      unerrDir,
      sessionId,
      toolCallCount: 1,
      filePath: "src/foo.ts",
      now: nowMs + 500,
    });
    expect(second.head).toBe("");
    expect(second.tail).toBe("");
  });

  it("re-opens the turn after the quiescence gap", async () => {
    const first = await buildUserBlockForResponse({
      unerrDir,
      sessionId,
      toolCallCount: 0,
      filePath: null,
      now: nowMs,
    });
    expect(first.head).not.toBe("");

    // Gap of 16s ≥ TURN_OPEN_GAP_MS (15s) → next call opens a new turn.
    const after = await buildUserBlockForResponse({
      unerrDir,
      sessionId,
      toolCallCount: 1,
      filePath: null,
      now: nowMs + 16_000,
    });
    expect(after.head).not.toBe("");
  });

  it("collapses to ambient marker after consecutive zero-content turns", async () => {
    // No data inserted. Priming sequence:
    //   call 0 → preface "starting fresh — nothing loaded yet" counts as content → counter 0
    //   call 1 → zero-content → counter 1
    //   call 2 → zero-content → counter 2
    //   call 3 → zero-content → counter 3 (threshold)
    // call 4 → shouldUseAmbientMarker fires → tail collapses to `unerr » ⋯`.
    for (let i = 0; i < 4; i++) {
      await buildUserBlockForResponse({
        unerrDir,
        sessionId,
        toolCallCount: i,
        filePath: null,
        now: nowMs + i * 4_000,
      });
    }

    const collapsed = await buildUserBlockForResponse({
      unerrDir,
      sessionId,
      toolCallCount: 4,
      filePath: null,
      now: nowMs + 4 * 4_000,
    });
    expect(collapsed.head).toBe("");
    expect(collapsed.tail).toContain(USER_BLOCK_AMBIENT);
  });

  it("never throws when the metrics store is empty", async () => {
    // Brand-new dir, no writers ever called.
    await expect(
      buildUserBlockForResponse({
        unerrDir,
        sessionId,
        toolCallCount: 0,
        filePath: "src/nowhere.ts",
        now: nowMs,
      })
    ).resolves.toMatchObject({
      head: expect.any(String),
      tail: expect.any(String),
    });
  });
});

/**
 * End-of-turn report — the single shared path behind BOTH close-out surfaces.
 *
 * The redesign (2026-06-17) replaced the thin Stop-only `formatStopReport`
 * with one renderer (`renderReceiptBlock`) fed by `turn-report.ts`. The Stop
 * hook (`renderStopReportLive`) and the `unerr_turn_summary` MCP tool
 * (`computeTurnSummaryLine`) now produce byte-identical output, so the report
 * works for every agent — not just Claude Code.
 *
 * These tests cover the turn-cadence recap decision and the best-effort /
 * honest-zero behaviour. The prose-rendering states (prevention-first
 * headline, the three-bucket recap, the single-line fallback) are unit-tested
 * against the pure renderer in receipt-renderer.test.ts.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RECAP_EVERY_N_TURNS,
  gatherReceiptInputs,
  isRecapTurn,
  renderStopReportLive,
} from "../proxy/turn-report.js";
import { computeTurnSummaryLine } from "../proxy/turn-summary-handler.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";

describe("isRecapTurn — turn-cadence recap decision", () => {
  it("folds in the recap every Nth turn", () => {
    expect(isRecapTurn(RECAP_EVERY_N_TURNS, false)).toBe(true);
    expect(isRecapTurn(RECAP_EVERY_N_TURNS * 2, false)).toBe(true);
  });

  it("does not fold in on an off-cadence productive turn", () => {
    expect(isRecapTurn(RECAP_EVERY_N_TURNS + 1, false)).toBe(false);
    expect(isRecapTurn(1, false)).toBe(false);
  });

  it("always folds in on a quiet turn, regardless of cadence", () => {
    expect(isRecapTurn(1, true)).toBe(true);
    expect(isRecapTurn(RECAP_EVERY_N_TURNS + 1, true)).toBe(true);
  });

  it("never folds in on turn 0 (pre-first-prompt)", () => {
    expect(isRecapTurn(0, false)).toBe(false);
  });
});

describe("end-of-turn report — best-effort + cross-surface parity", () => {
  let root: string;
  let unerrDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unerr-report-"));
    unerrDir = join(root, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("renders nothing for a session with no unerr value (honest-zero)", () => {
    // Empty .unerr dir → no events, no savings. The report suppresses itself
    // so the Stop hook emits no systemMessage.
    expect(renderStopReportLive(unerrDir, "sess-1", 1)).toBe("");
  });

  it("the Stop hook and the MCP tool emit byte-identical text", () => {
    // Both go through the one shared renderer, so on the same session/turn
    // their output must match exactly — the cross-agent guarantee.
    const stop = renderStopReportLive(unerrDir, "sess-1", RECAP_EVERY_N_TURNS);
    const mcp = computeTurnSummaryLine(unerrDir, "sess-1", RECAP_EVERY_N_TURNS);
    expect(stop).toBe(mcp);
  });
});

// ── Native-session-id cross-process correlation ───────────────────────
//
// The attribution bug: proxy writes code_edit_applied under session_id=A,
// UserPromptSubmit hook writes user_prompt_received under session_id=B, but
// both share native_session_id=N. gatherReceiptInputs must gather by native id
// so latestPromptBoundaryTs finds the boundary and ALL edits after it appear
// in the receipt — not just the single max-turn one.

describe("gatherReceiptInputs — native_session_id cross-process correlation", () => {
  let root: string;
  let unerrDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unerr-native-receipt-"));
    unerrDir = join(root, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
  });
  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(root, { recursive: true, force: true });
  });

  it("turnEvents includes ALL edits after the boundary when fetched by nativeSessionId", () => {
    // Hook session writes the prompt boundary (different session_id from proxy)
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

    // Proxy session writes two code_edit_applied events (different session_id)
    const proxyWriter = new BehaviorEventWriter(unerrDir, "proxy-sess");
    proxyWriter.record({
      session_id: "proxy-sess",
      native_session_id: "native-N",
      turn: 2,
      type: "code_edit_applied",
      tool: "file_edit",
      entity_key: "src/alpha.ts",
      response_bytes: null,
    });
    proxyWriter.record({
      session_id: "proxy-sess",
      native_session_id: "native-N",
      turn: 3,
      type: "code_edit_applied",
      tool: "file_edit",
      entity_key: "src/beta.ts",
      response_bytes: null,
    });

    // When fetched by nativeSessionId: boundary is found, BOTH edits are in
    // the turn slice.
    const inputs = gatherReceiptInputs(
      unerrDir,
      "proxy-sess", // sessionId (proxy)
      3, // currentTurn
      { nativeSessionId: "native-N" }
    );

    const editEvents = inputs.turnEvents.filter(
      (e) => e.event_type === "code_edit_applied"
    );
    expect(editEvents).toHaveLength(2);
    // Path-shaped entity_key is promoted to file_path by deriveFilePath;
    // entity_key becomes null when equal to the derived file_path.
    expect(editEvents.map((e) => e.file_path).sort()).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
    ]);
  });

  it("without nativeSessionId: falls back to session_id and misses cross-process boundary (legacy behaviour)", () => {
    // Hook session writes boundary under hook-sess
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

    // Proxy session writes one edit
    const proxyWriter = new BehaviorEventWriter(unerrDir, "proxy-sess");
    proxyWriter.record({
      session_id: "proxy-sess",
      native_session_id: "native-N",
      turn: 2,
      type: "code_edit_applied",
      tool: "file_edit",
      entity_key: "src/only.ts",
      response_bytes: null,
    });

    // Without nativeSessionId: fetches only proxy-sess rows → no boundary →
    // falls back to turn === fallbackTurn match (turn 2 = currentTurn 2).
    const inputs = gatherReceiptInputs(
      unerrDir,
      "proxy-sess",
      2
      // nativeSessionId intentionally omitted
    );

    // The boundary event lives in hook-sess only — not fetched without native id.
    const boundaryEvents = inputs.turnEvents.filter(
      (e) => e.event_type === "user_prompt_received"
    );
    expect(boundaryEvents).toHaveLength(0);
  });
});

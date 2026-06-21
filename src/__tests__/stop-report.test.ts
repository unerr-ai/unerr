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
  isRecapTurn,
  renderStopReportLive,
} from "../proxy/turn-report.js";
import { computeTurnSummaryLine } from "../proxy/turn-summary-handler.js";

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

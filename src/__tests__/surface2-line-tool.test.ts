/**
 * Tests for the `unerr_surface2_line` MCP handler (Fix B —
 * hybrid hook+MCP for Surface 2). The handler reads this turn's
 * `fact_recalled` behavior event, reconstructs the LoadedNoteFields
 * shape from the event's `detail` map, and renders the same Surface 2
 * prose the prior 1200-char hook directive used to produce.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetNudgeState,
  readNudgeState,
  updateNudgeState,
} from "../proxy/nudge-state.js";
import { handleSurface2LineProxy } from "../proxy/surface2-line-handler.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";

function makeUnerrDir(): { unerrDir: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "unerr-surface2-"));
  return { unerrDir: join(cwd, ".unerr"), cwd };
}

function writeFactRecalled(
  unerrDir: string,
  sessionId: string,
  turn: number,
  overrides: Record<string, unknown> = {}
): void {
  const writer = new BehaviorEventWriter(unerrDir, sessionId);
  writer.record({
    session_id: sessionId,
    turn,
    type: "fact_recalled",
    tool: "unerr_recall_notes",
    entity_key: null,
    response_bytes: null,
    detail: {
      top_content: "no intelligence imports in bridge",
      top_created_at: Date.now() - 60_000,
      top_kind: "rul",
      top_anchor_type: "f",
      top_anchor_value: "src/proxy/bridge.ts",
      top_polarity: "-",
      top_reinforcement_count: 0,
      top_anchor_missing: false,
      top_conflict_group_id: "",
      ...overrides,
    },
  });
}

function parse(out: {
  content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
  return JSON.parse(out.content[0]!.text);
}

describe("unerr_surface2_line — handler (Fix B)", () => {
  let unerrDir: string;
  let cwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    ({ unerrDir, cwd } = makeUnerrDir());
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `s2-${Date.now()}-${Math.random()}`;
  });

  afterEach(() => {
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("returns suppressed_reason='no_recall' when no fact_recalled event exists", async () => {
    const out = await handleSurface2LineProxy(unerrDir, "sess-1", 0, cwd);
    const data = parse(out);
    expect(data.ok).toBe(true);
    expect(data.line).toBe("");
    expect(data.suppressed_reason).toBe("no_recall");
    expect(data.echo_only).toBe(true);
  });

  it("renders a rich Surface 2 line when fact_recalled has full DSL fields", async () => {
    writeFactRecalled(unerrDir, "sess-2", 0);
    const out = await handleSurface2LineProxy(unerrDir, "sess-2", 0, cwd);
    const data = parse(out);
    expect(data.ok).toBe(true);
    const line = data.line as string;
    expect(typeof line).toBe("string");
    expect(line).toContain("rule");
    expect(line).toContain("src/proxy/bridge.ts");
    expect(line).toContain("no intelligence imports");
    expect(data.echo_only).toBe(true);
  });

  it("bumps surface2_called_count + resets misses on each call", async () => {
    _resetNudgeState(cwd);
    writeFactRecalled(unerrDir, "sess-3", 0);

    await handleSurface2LineProxy(unerrDir, "sess-3", 0, cwd);
    const state1 = readNudgeState(cwd);
    expect(state1.surface2_called_count).toBe(1);
    expect(state1.consecutive_surface2_misses).toBe(0);

    await handleSurface2LineProxy(unerrDir, "sess-3", 0, cwd);
    const state2 = readNudgeState(cwd);
    expect(state2.surface2_called_count).toBe(2);
  });

  it("ignores fact_recalled events from different turns", async () => {
    writeFactRecalled(unerrDir, "sess-4", 0);
    // Query a different turn — should fall back to no_recall.
    const out = await handleSurface2LineProxy(unerrDir, "sess-4", 1, cwd);
    const data = parse(out);
    expect(data.suppressed_reason).toBe("no_recall");
  });

  // ── Fix D — counter rollover & miss accounting ───────────────────────

  it("Fix D: consecutive_surface2_misses survives across hook fires when tool never runs", () => {
    _resetNudgeState(cwd);
    // Simulate three hook fires with no tool call between them.
    for (let i = 0; i < 3; i += 1) {
      const prior = readNudgeState(cwd);
      const priorMiss =
        prior.surface2_required_count > prior.surface2_called_count;
      updateNudgeState(cwd, (s) => {
        s.surface2_required_count += 1;
        s.consecutive_surface2_misses = priorMiss
          ? s.consecutive_surface2_misses + 1
          : 0;
      });
    }
    const final = readNudgeState(cwd);
    expect(final.surface2_required_count).toBe(3);
    expect(final.surface2_called_count).toBe(0);
    // First fire: priorMiss=false (counts equal at 0) → 0
    // Second fire: priorMiss=true → 1
    // Third fire: priorMiss=true → 2
    expect(final.consecutive_surface2_misses).toBe(2);
  });

  it("Fix D: tool call resets consecutive_surface2_misses to 0", async () => {
    _resetNudgeState(cwd);
    updateNudgeState(cwd, (s) => {
      s.surface2_required_count = 5;
      s.consecutive_surface2_misses = 4;
    });
    writeFactRecalled(unerrDir, "sess-fixd", 0);

    await handleSurface2LineProxy(unerrDir, "sess-fixd", 0, cwd);
    const state = readNudgeState(cwd);
    expect(state.consecutive_surface2_misses).toBe(0);
    expect(state.surface2_called_count).toBe(1);
  });
});

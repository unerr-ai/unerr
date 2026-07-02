/**
 * Stop hook guard — the turn-end close-out line, cross-agent.
 *
 * Locks: (1) the runner wires Stop through the right adapter formatter;
 * (2) Claude Code surfaces the line as a user-facing systemMessage (Stop has
 * no additionalContext channel); (3) Cursor/Cline degrade to "{}" (they keep
 * the MCP unerr_turn_summary fallback); (4) the handler never crashes the
 * agent — empty/absent event state yields "{}".
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../hooks/adapters/claude-code.js";
import { clineAdapter } from "../hooks/adapters/cline.js";
import { cursorAdapter } from "../hooks/adapters/cursor.js";
import { enrich, passthrough, runStopHookAsync } from "../hooks/hook-runner.js";
import {
  buildTrackerCloseReminder,
  runStopHookHandlerAsync,
  runSubagentStopHookHandlerAsync,
} from "../hooks/stop-hooks.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";

describe("formatStop — adapter wire shapes", () => {
  it("Claude Code surfaces an enriched line as top-level systemMessage", () => {
    const out = claudeCodeAdapter.formatStop(
      enrich("unerr · saved 1.2k tokens")
    );
    expect(JSON.parse(out)).toEqual({
      systemMessage: "unerr · saved 1.2k tokens",
    });
  });

  it("Claude Code never emits decision:block (must not force continuation)", () => {
    const out = claudeCodeAdapter.formatStop(enrich("x"));
    expect(out).not.toContain("decision");
    expect(out).not.toContain("block");
  });

  it("Claude Code passthrough is empty", () => {
    expect(claudeCodeAdapter.formatStop(passthrough())).toBe("{}");
  });

  it("Cursor and Cline have no Stop channel — always empty", () => {
    expect(cursorAdapter.formatStop(enrich("x"))).toBe("{}");
    expect(clineAdapter.formatStop(enrich("x"))).toBe("{}");
  });
});

describe("runStopHookAsync — pipeline", () => {
  it("routes a Claude Code Stop payload to a systemMessage", async () => {
    const stdin = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
    const out = await runStopHookAsync(stdin, async () => enrich("line!"));
    expect(JSON.parse(out)).toEqual({ systemMessage: "line!" });
  });

  it("returns {} on unparseable stdin", async () => {
    const out = await runStopHookAsync("not json", async () => enrich("x"));
    expect(out).toBe("{}");
  });

  it("returns {} on a passthrough handler", async () => {
    const stdin = JSON.stringify({ hook_event_name: "Stop" });
    const out = await runStopHookAsync(stdin, async () => passthrough());
    expect(out).toBe("{}");
  });
});

describe("runStopHookHandlerAsync — graceful degradation", () => {
  let dir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-stop-"));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never crashes the agent — empty event state yields a presence line", async () => {
    const stdin = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
    const out = await runStopHookHandlerAsync(stdin);
    // No silent passthrough: even with no tracked events the Stop hook emits a
    // user-facing presence marker so the agent always knows unerr ran.
    expect(JSON.parse(out)).toEqual({
      systemMessage: "unerr » active · no tracked tool calls this turn",
    });
  });
});

describe("runSubagentStopHookHandlerAsync — graceful degradation", () => {
  let dir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-subagent-stop-"));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never crashes the agent — empty event state yields a presence line", async () => {
    const stdin = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
    const out = await runSubagentStopHookHandlerAsync(stdin);
    // SubagentStop mirrors Stop: a presence marker, never a silent passthrough.
    expect(JSON.parse(out)).toEqual({
      systemMessage: "unerr » active · no tracked tool calls this turn",
    });
  });

  it("does NOT wipe delegable_nudge_pending — the master-only leak detector is excluded", async () => {
    // Arm the master's pending flag in the temp repo dir.
    mkdirSync(join(dir, ".unerr", "state"), { recursive: true });
    updateNudgeState(dir, (s) => {
      s.delegable_nudge_pending = true;
    });

    const stdin = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
    await runSubagentStopHookHandlerAsync(stdin);

    // Flag must survive — the sub-agent handler must not have called detectSerializedByMasterLeak.
    expect(readNudgeState(dir).delegable_nudge_pending).toBe(true);
  });
});

describe("buildTrackerCloseReminder — planner-mode close-out", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-tracker-close-"));
    mkdirSync(join(dir, ".unerr", "state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the close-out line and disarms tracker_open_pending when set", () => {
    updateNudgeState(dir, (s) => {
      s.tracker_open_pending = true;
    });

    const line = buildTrackerCloseReminder(dir);
    expect(line).not.toBe("");
    expect(line).toContain("tracker");

    // Disarmed — the flag must not survive the call.
    expect(readNudgeState(dir).tracker_open_pending).toBe(false);
    expect(readNudgeState(dir).tracker_close_reminder_count).toBe(1);
  });

  it('returns "" on a second call — fires at most once per opening', () => {
    updateNudgeState(dir, (s) => {
      s.tracker_open_pending = true;
    });

    expect(buildTrackerCloseReminder(dir)).not.toBe("");
    expect(buildTrackerCloseReminder(dir)).toBe("");
  });

  it('returns "" when tracker_open_pending was never set', () => {
    expect(buildTrackerCloseReminder(dir)).toBe("");
  });
});

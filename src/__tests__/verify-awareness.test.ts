/**
 * Verification awareness (W4) — check/weak-verify classifiers, the
 * PostToolUse(Bash) recorder, and the Stop-hook verify gate (soft advisory
 * line in interactive mode; capped blocking decision in autonomous mode).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAutonomousMode } from "../config/autonomous-mode.js";
import { claudeCodeAdapter } from "../hooks/adapters/claude-code.js";
import { cursorAdapter } from "../hooks/adapters/cursor.js";
import { windsurfAdapter } from "../hooks/adapters/windsurf.js";
import {
  classifyCheckCommand,
  classifyWeakVerify,
} from "../hooks/check-tracker.js";
import { block } from "../hooks/hook-runner.js";
import { runPostBashHook } from "../hooks/shell-hooks.js";
import { runStopHookHandlerAsync } from "../hooks/stop-hooks.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";
import { recordEdit } from "../tracking/session-edit-log.js";

// ── classifyCheckCommand ────────────────────────────────────────────────

describe("classifyCheckCommand", () => {
  const trueCases = [
    "pnpm run test:run src/x.test.ts",
    "cargo test",
    "tsc --noEmit",
    "npm test",
  ];
  for (const cmd of trueCases) {
    it(`classifies "${cmd}" as a check command`, () => {
      expect(classifyCheckCommand(cmd)).toBe(true);
    });
  }

  const falseCases = [
    "ls -la",
    "echo done",
    "git status",
    "grep -q foo src/a.ts",
  ];
  for (const cmd of falseCases) {
    it(`does NOT classify "${cmd}" as a check command`, () => {
      expect(classifyCheckCommand(cmd)).toBe(false);
    });
  }
});

// ── classifyWeakVerify ───────────────────────────────────────────────────

describe("classifyWeakVerify", () => {
  it('classifies "test -f out.txt" as existence-only', () => {
    expect(classifyWeakVerify("test -f out.txt")).toBe("existence-only");
  });

  it('classifies "node build.js" as no-comparison', () => {
    expect(classifyWeakVerify("node build.js")).toBe("no-comparison");
  });

  it('returns null for "vitest run" — a real check is never weak', () => {
    expect(classifyWeakVerify("vitest run")).toBeNull();
  });

  it('classifies "cat src/foo.ts" as self-referential when src/foo.ts was just edited', () => {
    expect(
      classifyWeakVerify("cat src/foo.ts", { editedFiles: ["src/foo.ts"] })
    ).toBe("self-referential");
  });

  it("returns null for cat of a NON-edited file", () => {
    expect(
      classifyWeakVerify("cat other.txt", { editedFiles: ["src/foo.ts"] })
    ).toBeNull();
  });

  it('classifies "vitest -u" (snapshot-update flag) as tampered-check', () => {
    expect(classifyWeakVerify("vitest -u")).toBe("tampered-check");
  });

  it("classifies a check naming an edited fixture path as tampered-check", () => {
    expect(
      classifyWeakVerify(
        "pnpm run test:run src/__tests__/fixtures/golden.snap",
        { editedFiles: ["src/__tests__/fixtures/golden.snap"] }
      )
    ).toBe("tampered-check");
  });

  it("does NOT flag a plain test run after editing the test file itself", () => {
    expect(
      classifyWeakVerify("pnpm vitest run x.test.ts", {
        editedFiles: ["x.test.ts"],
      })
    ).toBeNull();
  });
});

// ── runPostBashHook — record + weak-verify nudge ────────────────────────

function bashStdin(command: string): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
}

describe("runPostBashHook", () => {
  let dir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-post-bash-"));
    mkdirSync(join(dir, ".unerr", "state"), { recursive: true });
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stamps check_cmd_last_ts + bumps check_cmd_count for a check command", () => {
    const out = runPostBashHook(bashStdin("pnpm run test:run"));
    expect(out).toBe("{}");
    const state = readNudgeState(dir);
    expect(state.check_cmd_count).toBe(1);
    expect(state.check_cmd_last_ts).toBeGreaterThan(0);
  });

  it("does not nudge a weak-verify shape in interactive mode (default)", () => {
    const out = runPostBashHook(bashStdin("test -f out.txt"));
    expect(out).toBe("{}");
    expect(readNudgeState(dir).weak_verify_nudged).toEqual([]);
  });

  it("nudges an existence-only weak verify in autonomous mode, once per reason", () => {
    writeAutonomousMode(dir, true);

    const out = JSON.parse(runPostBashHook(bashStdin("test -f out.txt")));
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "never compares a value"
    );
    expect(readNudgeState(dir).weak_verify_nudged).toEqual(["existence-only"]);

    // Same reason again — one-shot, no repeat nudge.
    const second = runPostBashHook(bashStdin("test -f other.txt"));
    expect(second).toBe("{}");
  });

  it("never throws on an empty command or unparseable stdin", () => {
    expect(() => runPostBashHook(bashStdin(""))).not.toThrow();
    expect(() => runPostBashHook("not json")).not.toThrow();
  });

  it("nudges self-referential when the turn's edit log names the read-back file (autonomous mode)", () => {
    writeAutonomousMode(dir, true);
    updateNudgeState(dir, (s) => {
      s.turn_started_ts = Date.now() - 1000;
    });
    recordEdit(join(dir, ".unerr"), {
      ts: new Date().toISOString(),
      file_path: "src/foo.ts",
      old_content: "old",
      new_content: "new",
    });

    const out = JSON.parse(runPostBashHook(bashStdin("cat src/foo.ts")));
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "Reading back the file you just wrote"
    );
    expect(readNudgeState(dir).weak_verify_nudged).toEqual([
      "self-referential",
    ]);
  });

  it("skips the new shapes entirely when turn_started_ts is unset (never guesses)", () => {
    writeAutonomousMode(dir, true);
    recordEdit(join(dir, ".unerr"), {
      ts: new Date().toISOString(),
      file_path: "src/foo.ts",
      old_content: "old",
      new_content: "new",
    });

    const out = runPostBashHook(bashStdin("cat src/foo.ts"));
    expect(out).toBe("{}");
    expect(readNudgeState(dir).weak_verify_nudged).toEqual([]);
  });
});

// ── Stop hook — verification-awareness gate ─────────────────────────────

describe("Stop hook — verification-awareness gate", () => {
  let dir: string;
  let unerrDir: string;
  const origCwd = process.cwd();
  const stopStdin = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "s1",
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-verify-gate-"));
    unerrDir = join(dir, ".unerr");
    mkdirSync(join(unerrDir, "state"), { recursive: true });
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    closeMetricsStore(unerrDir);
    rmSync(dir, { recursive: true, force: true });
  });

  function seedTurnWithEdit(): void {
    const writer = new BehaviorEventWriter(unerrDir, "s1");
    writer.record({
      session_id: "s1",
      native_session_id: null,
      turn: 1,
      type: "user_prompt_received",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    writer.record({
      session_id: "s1",
      native_session_id: null,
      turn: 1,
      type: "code_edit_applied",
      tool: "file_edit",
      entity_key: "src/foo.ts",
      response_bytes: null,
    });
  }

  /** Records only the turn's prompt boundary (no `code_edit_applied` event)
   *  and returns its approximate epoch-ms timestamp, so a test can place a
   *  session-edits.jsonl ledger row deterministically before/after it. */
  function seedPromptOnly(): number {
    const writer = new BehaviorEventWriter(unerrDir, "s1");
    const promptTs = Date.now();
    writer.record({
      session_id: "s1",
      native_session_id: null,
      turn: 1,
      type: "user_prompt_received",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    return promptTs;
  }

  /** Records a named event that is neither `user_prompt_received` nor
   *  `code_edit_applied`, so the turn resolves (non-empty event stream) but
   *  has no prompt boundary — used to test that ledger rows never count
   *  without one. */
  function seedNoPromptBoundary(): void {
    const writer = new BehaviorEventWriter(unerrDir, "s1");
    writer.record({
      session_id: "s1",
      native_session_id: null,
      turn: 1,
      type: "graph_query_served",
      tool: "search_code",
      entity_key: null,
      response_bytes: null,
    });
  }

  function seedNativeLedgerEdit(ts: number): void {
    recordEdit(unerrDir, {
      ts: new Date(ts).toISOString(),
      file_path: "src/native.ts",
      old_content: "old",
      new_content: "new",
    });
  }

  it("appends the soft advisory line when edits landed with no check (interactive mode)", async () => {
    seedTurnWithEdit();
    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.systemMessage).toContain(
      "edits landed with no check run this turn"
    );
    expect(readNudgeState(dir).verify_soft_count).toBe(1);
  });

  it("caps the soft line at 2 per session", async () => {
    seedTurnWithEdit();
    await runStopHookHandlerAsync(stopStdin);
    await runStopHookHandlerAsync(stopStdin);
    const third = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(third.systemMessage ?? "").not.toContain("verify-run");
    expect(readNudgeState(dir).verify_soft_count).toBe(2);
  });

  it("does not append the soft line when a check ran after the edit", async () => {
    seedTurnWithEdit();
    updateNudgeState(dir, (s) => {
      s.check_cmd_last_ts = Date.now() + 60_000;
    });
    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.systemMessage ?? "").not.toContain("verify-run");
  });

  it("leaves the message unchanged when there were no edits this turn", async () => {
    const writer = new BehaviorEventWriter(unerrDir, "s1");
    writer.record({
      session_id: "s1",
      native_session_id: null,
      turn: 1,
      type: "user_prompt_received",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.systemMessage ?? "").not.toContain("verify-run");
  });

  it("blocks the turn in autonomous mode, capped at 2, then degrades to the soft line", async () => {
    seedTurnWithEdit();
    writeAutonomousMode(dir, true);

    const first = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(first).toEqual({
      decision: "block",
      reason: expect.stringContaining("Run the project's check"),
    });

    const second = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(second.decision).toBe("block");

    const third = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(third.decision).toBeUndefined();
    expect(third.systemMessage).toContain("verify-run");

    const state = readNudgeState(dir);
    expect(state.verify_block_count).toBe(2);
    expect(state.verify_soft_count).toBe(1);
  });

  it("never throws when the autonomous-mode config is malformed", async () => {
    seedTurnWithEdit();
    writeFileSync(join(unerrDir, "config.json"), "{not json", "utf8");
    await expect(runStopHookHandlerAsync(stopStdin)).resolves.not.toThrow();
  });

  // ── session-edits.jsonl ledger — native Write/Edit awareness ────────────

  it("blocks in autonomous mode on a native-edit-only turn (ledger row, no named event)", async () => {
    const promptTs = seedPromptOnly();
    seedNativeLedgerEdit(promptTs + 1000);
    writeAutonomousMode(dir, true);

    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out).toEqual({
      decision: "block",
      reason: expect.stringContaining("Run the project's check"),
    });
  });

  it("does not count a ledger row recorded before the prompt boundary", async () => {
    const promptTs = seedPromptOnly();
    seedNativeLedgerEdit(promptTs - 60_000);
    writeAutonomousMode(dir, true);

    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? "").not.toContain("verify-run");
  });

  it("does not count ledger rows when there is no prompt boundary this turn", async () => {
    seedNoPromptBoundary();
    seedNativeLedgerEdit(Date.now());
    writeAutonomousMode(dir, true);

    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? "").not.toContain("verify-run");
  });

  it("clears the gate when a check command ran after a native ledger edit", async () => {
    const promptTs = seedPromptOnly();
    const editTs = promptTs + 1000;
    seedNativeLedgerEdit(editTs);
    updateNudgeState(dir, (s) => {
      s.check_cmd_last_ts = editTs + 60_000;
    });
    writeAutonomousMode(dir, true);

    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? "").not.toContain("verify-run");
  });

  // ── Exit-code-aware verify gate (Port A) ────────────────────────────────

  it("blocks with the red-specific message when a check ran and FAILED after the edit", async () => {
    seedTurnWithEdit();
    updateNudgeState(dir, (s) => {
      s.check_red_last_ts = Date.now() + 60_000;
    });
    writeAutonomousMode(dir, true);

    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out).toEqual({
      decision: "block",
      reason: expect.stringContaining("The check ran and FAILED"),
    });
  });

  it("stays silent when a check ran and PASSED after the edit (green)", async () => {
    seedTurnWithEdit();
    updateNudgeState(dir, (s) => {
      s.check_green_last_ts = Date.now() + 60_000;
    });
    writeAutonomousMode(dir, true);

    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? "").not.toContain("verify-run");
    expect(out.systemMessage ?? "").not.toContain("FAILED");
  });

  it("fails open when a check ran after the edit but its exit code is unknown (unwrapped env)", async () => {
    seedTurnWithEdit();
    updateNudgeState(dir, (s) => {
      // Only the ran-only stamp — no green/red — the shape an env that
      // bypassed `unerr exec` leaves behind.
      s.check_cmd_last_ts = Date.now() + 60_000;
    });
    writeAutonomousMode(dir, true);

    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? "").not.toContain("verify-run");
  });

  it("a later green supersedes an earlier red — stays silent", async () => {
    seedTurnWithEdit();
    const base = Date.now();
    updateNudgeState(dir, (s) => {
      s.check_red_last_ts = base + 30_000;
      s.check_green_last_ts = base + 60_000;
    });
    writeAutonomousMode(dir, true);

    const out = JSON.parse(await runStopHookHandlerAsync(stopStdin));
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? "").not.toContain("verify-run");
  });
});

// ── formatStop — action:"block" adapter wire shapes ─────────────────────

describe("formatStop — action:block adapter wire shapes", () => {
  it("Claude Code maps block to {decision:block, reason}", () => {
    const out = JSON.parse(
      claudeCodeAdapter.formatStop(block("stop and verify"))
    );
    expect(out).toEqual({ decision: "block", reason: "stop and verify" });
  });

  it("every other adapter degrades block to its existing non-blocking shape", () => {
    expect(JSON.parse(cursorAdapter.formatStop(block("x")))).toEqual({});
    const wOut = windsurfAdapter.formatStop(block("x"));
    expect(wOut).toBe("{}");
    expect(wOut).not.toContain("block");
  });
});

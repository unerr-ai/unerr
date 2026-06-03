/**
 * End-to-end Cursor hook tests — verifies the full PreToolUse pipeline
 * fires for Cursor-shaped payloads:
 *   - deny path emits `{permission:"deny", agent_message:...}`
 *   - nudge path emits `{permission:"allow", agent_message:...}`
 *   - ambient injection (topic-shift + mark_intent) rides on the first
 *     PreToolUse and the message lands in `agent_message`
 *
 * Spawning a real Cursor IDE in CI isn't practical; the contract is
 * the stdin/stdout JSON shape that Cursor's hook runner consumes. We
 * exercise that surface directly via runPreToolUseHook.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type HookHandler,
  deny,
  nudge,
  passthrough,
  runPreToolUseHook,
} from "../hooks/hook-runner.js";
import {
  consumeAnyPendingTopicShift,
  setPendingTopicShift,
} from "../intelligence/topic-shift.js";
import { _resetNudgeState } from "../proxy/nudge-state.js";

function cursorPayload(toolName: string, toolInput: Record<string, unknown>) {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    cwd: process.cwd(),
    tool_use_id: "test-id",
  });
}

describe("Cursor end-to-end PreToolUse", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "unerr-cursor-e2e-"));
    process.chdir(tmpDir);
    _resetNudgeState(tmpDir);
    // Drain any pending topic-shift signal left over from a prior test.
    while (consumeAnyPendingTopicShift()) {
      /* drain */
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits permission:allow for passthrough (no signal pending)", () => {
    // Drain the mark_intent one-shot first so it doesn't auto-inject here.
    const drain: HookHandler = () => passthrough();
    runPreToolUseHook(cursorPayload("Read", { file_path: "foo.ts" }), drain);

    const handler: HookHandler = () => passthrough();
    const out = runPreToolUseHook(
      cursorPayload("Read", { file_path: "foo.ts" }),
      handler
    );
    const parsed = JSON.parse(out);
    expect(parsed.permission).toBe("allow");
    expect(parsed.agent_message).toBeUndefined();
  });

  it("emits permission:deny + agent_message when handler denies", () => {
    const handler: HookHandler = () => deny("use search_code instead");
    const out = runPreToolUseHook(
      cursorPayload("Grep", { pattern: "fooBar" }),
      handler
    );
    const parsed = JSON.parse(out);
    expect(parsed.permission).toBe("deny");
    expect(parsed.agent_message).toContain("search_code");
  });

  it("emits permission:allow + agent_message when handler nudges", () => {
    // Drain mark_intent first.
    runPreToolUseHook(cursorPayload("Read", { file_path: "foo.ts" }), () =>
      passthrough()
    );

    const handler: HookHandler = () => nudge("prefer file_read");
    const out = runPreToolUseHook(
      cursorPayload("Read", { file_path: "bar.ts" }),
      handler
    );
    const parsed = JSON.parse(out);
    expect(parsed.permission).toBe("allow");
    expect(parsed.agent_message).toContain("prefer file_read");
  });

  it("injects topic-shift signal as agent_message on first PreToolUse", () => {
    // Drain mark_intent one-shot first.
    runPreToolUseHook(cursorPayload("Read", { file_path: "warm.ts" }), () =>
      passthrough()
    );

    setPendingTopicShift("__session_test__", { flag: true, overlap: 0.12 });

    const handler: HookHandler = () => passthrough();
    const out = runPreToolUseHook(
      cursorPayload("Read", { file_path: "x.ts" }),
      handler
    );
    const parsed = JSON.parse(out);
    expect(parsed.permission).toBe("allow");
    expect(parsed.agent_message).toContain("topic-shift detected");
    expect(parsed.agent_message).toContain("12%");
  });

  it("injects the intent reminder (unerr-save sentinel) once per session", () => {
    const handler: HookHandler = () => passthrough();
    const out1 = runPreToolUseHook(
      cursorPayload("Read", { file_path: "a.ts" }),
      handler
    );
    const parsed1 = JSON.parse(out1);
    // Demoted (Sprint 11): the reminder points at the closing-message sentinel,
    // not a mark_intent MCP call.
    expect(parsed1.agent_message).toContain("unerr-save: intent");
    expect(parsed1.agent_message).not.toContain("mark_intent(");

    const out2 = runPreToolUseHook(
      cursorPayload("Read", { file_path: "b.ts" }),
      handler
    );
    const parsed2 = JSON.parse(out2);
    // Second call should NOT re-emit the one-shot reminder.
    expect(parsed2.agent_message).toBeUndefined();
  });

  it("preserves deny when topic-shift is pending (deny outranks ambient)", () => {
    setPendingTopicShift("__session_test__", { flag: true, overlap: 0.1 });
    const handler: HookHandler = () => deny("use search_code instead");
    const out = runPreToolUseHook(
      cursorPayload("Grep", { pattern: "fooBar" }),
      handler
    );
    const parsed = JSON.parse(out);
    expect(parsed.permission).toBe("deny");
    // Deny carries its own reason — ambient prefix doesn't override it.
    expect(parsed.agent_message).toContain("search_code");
  });
});

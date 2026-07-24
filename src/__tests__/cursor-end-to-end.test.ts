/**
 * End-to-end Cursor hook tests — verifies the full PreToolUse pipeline
 * fires for Cursor-shaped payloads:
 *   - deny path emits `{permission:"deny", agent_message:...}`
 *   - nudge path emits `{permission:"allow", agent_message:...}`
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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits permission:allow for passthrough (no signal pending)", () => {
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
    const handler: HookHandler = () => nudge("prefer file_read");
    const out = runPreToolUseHook(
      cursorPayload("Read", { file_path: "bar.ts" }),
      handler
    );
    const parsed = JSON.parse(out);
    expect(parsed.permission).toBe("allow");
    expect(parsed.agent_message).toContain("prefer file_read");
  });
});

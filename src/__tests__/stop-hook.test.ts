/**
 * Stop hook guard — the turn-end close-out line, cross-agent.
 *
 * Locks: (1) the runner wires Stop through the right adapter formatter;
 * (2) Claude Code surfaces the line as a user-facing systemMessage (Stop has
 * no additionalContext channel); (3) Cursor/Cline degrade to "{}" (they keep
 * the MCP unerr_turn_summary fallback); (4) the handler never crashes the
 * agent — empty/absent event state yields "{}".
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../hooks/adapters/claude-code.js";
import { clineAdapter } from "../hooks/adapters/cline.js";
import { cursorAdapter } from "../hooks/adapters/cursor.js";
import { enrich, passthrough, runStopHookAsync } from "../hooks/hook-runner.js";
import { runStopHookHandlerAsync } from "../hooks/stop-hooks.js";

describe("formatStop — adapter wire shapes", () => {
  it("Claude Code surfaces an enriched line as top-level systemMessage", () => {
    const out = claudeCodeAdapter.formatStop(enrich("unerr · saved 1.2k tokens"));
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

  it("never crashes the agent — empty event state yields {}", async () => {
    const stdin = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
    const out = await runStopHookHandlerAsync(stdin);
    expect(out).toBe("{}");
  });
});

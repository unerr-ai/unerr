import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_CONFIGS, getConfig } from "../eval/configs.js";
import {
  classifyToolCall,
  computeMomentDetail,
  countNotesSaved,
  detectCiteInPlan,
  listToolsCalled,
  parseEventsJsonl,
  type ProxyEvent,
} from "../eval/metrics.js";
import { loadTask, runOne } from "../eval/runner.js";

const TASK_ID = "001-add-health-endpoint";

describe("eval/configs (A-eval smoke)", () => {
  it("exposes A and B configs with the expected install posture", () => {
    expect(ALL_CONFIGS.map((c) => c.id)).toEqual(["a-naive", "b-instructed"]);
    expect(getConfig("a-naive").install_unerr).toBe(false);
    expect(getConfig("b-instructed").install_unerr).toBe(true);
  });

  it("rejects unknown config ids", () => {
    expect(() => getConfig("c-imagined")).toThrow(/unknown config/);
  });
});

describe("eval/tasks loader", () => {
  it("loads the task-01 fixture", () => {
    const task = loadTask(TASK_ID);
    expect(task.id).toBe(TASK_ID);
    expect(task.repo).toBe("self");
    expect(task.exercises).toContain("save_at_task_end");
  });
});

describe("eval/metrics — pure extractors", () => {
  it("parseEventsJsonl skips blank and malformed lines", () => {
    const raw = ['{"ts":1,"kind":"tool_call","tool":"x"}', "", "not-json", "  "].join(
      "\n",
    );
    const evs = parseEventsJsonl(raw);
    expect(evs).toHaveLength(1);
    expect(evs[0]?.tool).toBe("x");
  });

  it("classifyToolCall maps action-dispatched calls to moments", () => {
    const promptQ: ProxyEvent = {
      ts: 1,
      kind: "tool_call",
      tool: "unerr_recall_notes",
      payload: { action: "for_prompt" },
    };
    const anchorQ: ProxyEvent = {
      ts: 2,
      kind: "tool_call",
      tool: "unerr_recall_notes",
      payload: { action: "for_anchors" },
    };
    const save: ProxyEvent = {
      ts: 3,
      kind: "tool_call",
      tool: "unerr_remember",
      payload: { type: "note" },
    };
    const other: ProxyEvent = {
      ts: 4,
      kind: "tool_call",
      tool: "file_read",
    };
    expect(classifyToolCall(promptQ)).toBe("prompt_receipt_query");
    expect(classifyToolCall(anchorQ)).toBe("anchor_query");
    expect(classifyToolCall(save)).toBe("save_at_task_end");
    expect(classifyToolCall(other)).toBeNull();
  });

  it("detectCiteInPlan finds rule-name + .ts(x) within range", () => {
    const plan = "Per the rul on src/proxy/bridge.ts, no intelligence imports.";
    expect(detectCiteInPlan(plan)).toBe(true);
    expect(detectCiteInPlan("nothing here")).toBe(false);
  });

  it("computeMomentDetail rolls up events + transcript", () => {
    const events: ProxyEvent[] = [
      {
        ts: 1,
        kind: "tool_call",
        tool: "unerr_recall_notes",
        payload: { action: "for_prompt" },
      },
      {
        ts: 2,
        kind: "tool_call",
        tool: "unerr_remember",
        payload: { type: "note" },
      },
    ];
    const transcript = "I'll follow the wrn at src/proxy/proxy.ts when editing.";
    const { moment_detail, moments_hit } = computeMomentDetail(
      events,
      transcript,
    );
    expect(moment_detail.prompt_receipt_query).toBe(true);
    expect(moment_detail.cite_in_plan).toBe(true);
    expect(moment_detail.save_at_task_end).toBe(true);
    expect(moment_detail.anchor_query).toBe(false);
    expect(moments_hit).toBe(3);
  });

  it("countNotesSaved counts only unerr_remember type=note", () => {
    const events: ProxyEvent[] = [
      { ts: 1, kind: "tool_call", tool: "unerr_remember", payload: { type: "note" } },
      { ts: 2, kind: "tool_call", tool: "unerr_remember", payload: { type: "cochange" } },
      { ts: 3, kind: "tool_call", tool: "unerr_remember", payload: { type: "note" } },
    ];
    expect(countNotesSaved(events)).toBe(2);
  });

  it("listToolsCalled returns a sorted dedup", () => {
    const events: ProxyEvent[] = [
      { ts: 1, kind: "tool_call", tool: "file_read" },
      { ts: 2, kind: "tool_call", tool: "unerr_remember" },
      { ts: 3, kind: "tool_call", tool: "file_read" },
    ];
    expect(listToolsCalled(events)).toEqual(["file_read", "unerr_remember"]);
  });
});

describe("eval/runner — end-to-end against no-op agent", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "eval-smoke-"));
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("config A produces a valid RunSummary with no moments hit", async () => {
    const summary = await runOne(TASK_ID, "a-naive", {
      workspaceRoot: scratch,
    });
    expect(summary.task_id).toBe(TASK_ID);
    expect(summary.config_id).toBe("a-naive");
    expect(summary.moments_hit).toBe(0);
    expect(summary.notes_saved).toBe(0);
    expect(summary.assertions_passed).toBe(true);
    expect(summary.notes).toContain("noop agent — no transcript or events captured");
  });

  it("config B writes an install marker into the workspace", async () => {
    const summary = await runOne(TASK_ID, "b-instructed", {
      workspaceRoot: scratch,
    });
    expect(summary.config_id).toBe("b-instructed");
    // Workspace path is unique per run; locate the most recent b-instructed dir.
    // The marker lives next to TASK.md in the same workspace dir.
    // We rely on the runner persisting transcript.txt as a stable artifact;
    // walk up from there if we ever need it. For now, assert via presence of
    // the marker pattern in any sibling dir.
    // (Simpler: re-call summarize via a direct path lookup is overkill —
    // a smoke check that the summary is shaped correctly is enough.)
    expect(typeof summary.duration_ms).toBe("number");
    expect(summary.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("install marker is written for config B", async () => {
    const sub = await mkdtemp(join(scratch, "marker-check-"));
    await runOne(TASK_ID, "b-instructed", { workspaceRoot: sub });
    // Find the eval-<task>-* dir under sub
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(sub).filter((n) => n.startsWith("eval-"));
    expect(entries.length).toBe(1);
    const first = entries[0];
    if (!first) throw new Error("no eval workspace produced");
    const marker = join(sub, first, ".unerr-install-marker");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toMatch(/would-install: claude-code/);
  });
});

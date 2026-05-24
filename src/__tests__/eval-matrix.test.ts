import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAllTaskIds, runMatrix, summarizeMatrix } from "../eval/matrix.js";
import type { RunSummary } from "../eval/types.js";

describe("eval/matrix listAllTaskIds (C-eval)", () => {
  it("enumerates all 10 ship-gate task fixtures", () => {
    const ids = listAllTaskIds();
    expect(ids.length).toBe(10);
    expect(ids[0]).toBe("001-add-health-endpoint");
    expect(ids[9]).toBe("010-continue-last-session");
  });

  it("returns ids in stable lexicographic order", () => {
    const ids = listAllTaskIds();
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

describe("eval/matrix summarizeMatrix (C-eval)", () => {
  function cell(over: Partial<RunSummary> = {}): RunSummary {
    return {
      task_id: "t1",
      config_id: "a-naive",
      duration_ms: 0,
      moments_hit: 0,
      moment_detail: {
        prompt_receipt_query: false,
        anchor_query: false,
        cite_in_plan: false,
        save_at_task_end: false,
      },
      notes_saved: 0,
      tools_called: [],
      tokens_used: null,
      turns: null,
      assertions_passed: true,
      notes: [],
      ...over,
    };
  }

  it("rolls per-config moment, note, and any-hit counts", () => {
    const report = summarizeMatrix([
      cell({ config_id: "a-naive", moments_hit: 0, notes_saved: 0 }),
      cell({ config_id: "a-naive", moments_hit: 1, notes_saved: 1 }),
      cell({ config_id: "b-instructed", moments_hit: 3, notes_saved: 2 }),
      cell({ config_id: "b-instructed", moments_hit: 4, notes_saved: 5 }),
    ]);
    expect(report.total_cells).toBe(4);
    expect(report.total_moments_by_config["a-naive"]).toBe(1);
    expect(report.total_moments_by_config["b-instructed"]).toBe(7);
    expect(report.total_notes_saved_by_config["a-naive"]).toBe(1);
    expect(report.total_notes_saved_by_config["b-instructed"]).toBe(7);
    expect(report.cells_with_any_moment_by_config["a-naive"]).toBe(1);
    expect(report.cells_with_any_moment_by_config["b-instructed"]).toBe(2);
  });

  it("handles empty input without divide-by-zero", () => {
    const report = summarizeMatrix([]);
    expect(report.total_cells).toBe(0);
    expect(Object.keys(report.total_moments_by_config).length).toBe(0);
  });
});

describe("eval/matrix runMatrix (C-eval)", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "eval-matrix-"));
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("runs the full 10 × 2 grid under the no-op contract", async () => {
    const report = await runMatrix({ run_options: { workspaceRoot: scratch } });
    expect(report.total_cells).toBe(20);
    // No-op agent ⇒ zero moments across the grid.
    expect(report.total_moments_by_config["a-naive"]).toBe(0);
    expect(report.total_moments_by_config["b-instructed"]).toBe(0);
  });

  it("accepts a narrowing task_ids filter", async () => {
    const report = await runMatrix({
      task_ids: ["001-add-health-endpoint", "007-add-mcp-tool"],
      run_options: { workspaceRoot: scratch },
    });
    expect(report.total_cells).toBe(4); // 2 tasks × 2 configs
    expect(new Set(report.cells.map((c) => c.task_id)).size).toBe(2);
  });

  it("accepts a narrowing config_ids filter", async () => {
    const report = await runMatrix({
      task_ids: ["001-add-health-endpoint"],
      config_ids: ["a-naive"],
      run_options: { workspaceRoot: scratch },
    });
    expect(report.total_cells).toBe(1);
    expect(report.cells[0]?.config_id).toBe("a-naive");
  });
});

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
      tools_called: [],
      tokens_used: null,
      turns: null,
      assertions_passed: true,
      notes: [],
      ...over,
    };
  }

  it("rolls cells into a flat report", () => {
    const report = summarizeMatrix([
      cell({ config_id: "a-naive" }),
      cell({ config_id: "b-instructed" }),
    ]);
    expect(report.total_cells).toBe(2);
    expect(report.cells).toHaveLength(2);
  });

  it("handles empty input", () => {
    const report = summarizeMatrix([]);
    expect(report.total_cells).toBe(0);
    expect(report.cells).toEqual([]);
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

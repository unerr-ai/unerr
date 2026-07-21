import { describe, expect, it } from "vitest";
import type { MatrixReport } from "../eval/matrix.js";
import { evaluate } from "../eval/pass-bar.js";
import type { RunSummary } from "../eval/types.js";

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

function matrix(cells: RunSummary[]): MatrixReport {
  return {
    total_cells: cells.length,
    cells,
  };
}

describe("pass-bar evaluate (D-eval)", () => {
  it("returns overall=pass when B uses fewer-or-equal turns than A on enough tasks", () => {
    const b: RunSummary[] = Array.from({ length: 10 }, (_, i) =>
      cell({ task_id: `t${i}`, config_id: "b-instructed", turns: 5 })
    );
    const a: RunSummary[] = Array.from({ length: 10 }, (_, i) =>
      cell({ task_id: `t${i}`, config_id: "a-naive", turns: 10 })
    );
    const result = evaluate({ matrix_b: matrix(b), matrix_a: matrix(a) });
    expect(result.overall).toBe("pass");
  });

  it("fails overall when B uses more turns than A on too many tasks", () => {
    const b: RunSummary[] = Array.from({ length: 10 }, (_, i) =>
      cell({ task_id: `t${i}`, config_id: "b-instructed", turns: 20 })
    );
    const a: RunSummary[] = Array.from({ length: 10 }, (_, i) =>
      cell({ task_id: `t${i}`, config_id: "a-naive", turns: 10 })
    );
    const result = evaluate({ matrix_b: matrix(b), matrix_a: matrix(a) });
    const outcome = result.criteria.find((c) => c.id === "outcome-turns");
    expect(outcome?.status).toBe("fail");
    expect(result.overall).toBe("fail");
  });

  it("skips outcome-turns when matrix_a is not provided", () => {
    const result = evaluate({ matrix_b: matrix([]) });
    const outcome = result.criteria.find((c) => c.id === "outcome-turns");
    expect(outcome?.status).toBe("skipped");
  });

  it("skips outcome-turns when neither cell reports turn counts", () => {
    const b = matrix([cell({ config_id: "b-instructed", turns: null })]);
    const a = matrix([cell({ config_id: "a-naive", turns: null })]);
    const result = evaluate({ matrix_b: b, matrix_a: a });
    const turns = result.criteria.find((c) => c.id === "outcome-turns");
    expect(turns?.status).toBe("skipped");
  });
});

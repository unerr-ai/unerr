import { describe, expect, it } from "vitest";
import { NOTES_SAVE_CAP, evaluate } from "../eval/pass-bar.js";
import type { MatrixReport } from "../eval/matrix.js";
import type { RunSummary } from "../eval/types.js";

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

function matrix(cells: RunSummary[]): MatrixReport {
  const moments: Record<string, number> = {};
  const saves: Record<string, number> = {};
  const anyMoments: Record<string, number> = {};
  for (const c of cells) {
    moments[c.config_id] = (moments[c.config_id] ?? 0) + c.moments_hit;
    saves[c.config_id] = (saves[c.config_id] ?? 0) + c.notes_saved;
    anyMoments[c.config_id] =
      (anyMoments[c.config_id] ?? 0) + (c.moments_hit > 0 ? 1 : 0);
  }
  return {
    total_cells: cells.length,
    cells,
    cells_with_any_moment_by_config: anyMoments,
    total_moments_by_config: moments,
    total_notes_saved_by_config: saves,
  };
}

describe("pass-bar evaluate (D-eval)", () => {
  it("returns overall=pass when all criteria pass with full inputs", () => {
    const b: RunSummary[] = Array.from({ length: 10 }, (_, i) =>
      cell({
        task_id: `t${i}`,
        config_id: "b-instructed",
        moments_hit: 4,
        notes_saved: 3,
        turns: 5,
      }),
    );
    const a: RunSummary[] = Array.from({ length: 10 }, (_, i) =>
      cell({
        task_id: `t${i}`,
        config_id: "a-naive",
        moments_hit: 1,
        notes_saved: 0,
        turns: 10,
      }),
    );
    const result = evaluate({
      matrix_b: matrix(b),
      matrix_a: matrix(a),
      task_count: 10,
      task_10_continuity: {
        anchor_query_returned_non_empty: true,
        plan_cited_prior_note: true,
      },
    });
    expect(result.overall).toBe("pass");
  });

  it("fails the four-moments criterion when fewer than 7 of 10 tasks hit all four", () => {
    const b: RunSummary[] = Array.from({ length: 10 }, (_, i) =>
      cell({
        task_id: `t${i}`,
        config_id: "b-instructed",
        moments_hit: i < 5 ? 4 : 2, // only 5 tasks at 4
      }),
    );
    const result = evaluate({ matrix_b: matrix(b), task_count: 10 });
    const adoption = result.criteria.find((c) => c.id === "adoption-four-moments");
    expect(adoption?.status).toBe("fail");
    expect(result.overall).toBe("fail");
  });

  it("fails the no-note-storms criterion when any B run exceeds the save cap", () => {
    const b: RunSummary[] = [
      cell({ config_id: "b-instructed", notes_saved: NOTES_SAVE_CAP + 1 }),
    ];
    const result = evaluate({ matrix_b: matrix(b) });
    const storms = result.criteria.find((c) => c.id === "no-note-storms");
    expect(storms?.status).toBe("fail");
  });

  it("skips adoption-ratio when matrix_a not provided", () => {
    const result = evaluate({ matrix_b: matrix([]) });
    const ratio = result.criteria.find((c) => c.id === "adoption-ratio");
    expect(ratio?.status).toBe("skipped");
  });

  it("computes the adoption ratio when both matrices provided", () => {
    const b = matrix([
      cell({ config_id: "b-instructed", moments_hit: 4 }),
      cell({ config_id: "b-instructed", moments_hit: 4 }),
    ]);
    const a = matrix([
      cell({ config_id: "a-naive", moments_hit: 1 }),
      cell({ config_id: "a-naive", moments_hit: 1 }),
    ]);
    const result = evaluate({ matrix_b: b, matrix_a: a });
    const ratio = result.criteria.find((c) => c.id === "adoption-ratio");
    expect(ratio?.status).toBe("pass");
    expect(ratio?.measured).toBe("4.00");
  });

  it("uses anchored-only proxy for quality when no judgments supplied", () => {
    const b = matrix([cell({ config_id: "b-instructed", notes_saved: 5 })]);
    const result = evaluate({ matrix_b: b });
    const q = result.criteria.find((c) => c.id === "quality-anchored");
    expect(q?.status).toBe("pass");
    expect(q?.measured).toMatch(/anchored-only/);
  });

  it("respects explicit judgments when supplied", () => {
    const b = matrix([cell({ config_id: "b-instructed", notes_saved: 5 })]);
    const judgments = new Map([
      ["n1", { anchored: true, non_obvious: true }],
      ["n2", { anchored: true, non_obvious: false }],
      ["n3", { anchored: true, non_obvious: false }],
    ]);
    const result = evaluate({ matrix_b: b, note_quality: judgments });
    const q = result.criteria.find((c) => c.id === "quality-anchored");
    expect(q?.status).toBe("fail"); // 33% < 80%
  });

  it("fails task-10 continuity when either flag is false", () => {
    const result = evaluate({
      matrix_b: matrix([]),
      task_10_continuity: {
        anchor_query_returned_non_empty: true,
        plan_cited_prior_note: false,
      },
    });
    const c10 = result.criteria.find((c) => c.id === "task-10-continuity");
    expect(c10?.status).toBe("fail");
  });

  it("skips outcome-turns when neither cell reports turn counts", () => {
    const b = matrix([cell({ config_id: "b-instructed", turns: null })]);
    const a = matrix([cell({ config_id: "a-naive", turns: null })]);
    const result = evaluate({ matrix_b: b, matrix_a: a });
    const turns = result.criteria.find((c) => c.id === "outcome-turns");
    expect(turns?.status).toBe("skipped");
  });
});

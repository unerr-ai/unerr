import { describe, it, expect } from "vitest";

import {
  detectWrongCalls,
  computeSelectionAccuracy,
  type ToolCallTrace,
} from "../router/reasoning/wrong-call-detector.js";
import { countRetries, ReasoningCounter } from "../router/reasoning/counter.js";

function makeTrace(overrides: Partial<ToolCallTrace> & { toolName: string; family: string }): ToolCallTrace {
  return {
    turnNumber: 0,
    timestamp: Date.now(),
    outcome: "success",
    responseTokens: 200,
    ...overrides,
  };
}

describe("Wrong-call detector — empty_then_retry heuristic", () => {
  it("detects empty response + different tool retry in same turn", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "gh_search", family: "gh", outcome: "empty", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "gh_list_repos", family: "gh", turnNumber: 0, timestamp: 2000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(1);
    expect(result.wrongCalls[0]!.heuristic).toBe("empty_then_retry");
    expect(result.wrongCalls[0]!.confidence).toBe(0.85);
    expect(result.wrongCalls[0]!.wrongCall.toolName).toBe("gh_search");
    expect(result.wrongCalls[0]!.correction.toolName).toBe("gh_list_repos");
  });

  it("detects empty response + retry in consecutive turn (quick)", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "pg_query", family: "pg", outcome: "empty", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "pg_schema", family: "pg", turnNumber: 1, timestamp: 5000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(1);
    expect(result.wrongCalls[0]!.heuristic).toBe("empty_then_retry");
  });

  it("does NOT detect retry if too slow (>10s gap)", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "gh_search", family: "gh", outcome: "empty", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "gh_list_repos", family: "gh", turnNumber: 1, timestamp: 15000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(0);
  });

  it("does NOT flag same tool called twice (not a retry)", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "gh_search", family: "gh", outcome: "empty", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "gh_search", family: "gh", turnNumber: 0, timestamp: 2000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(0);
  });
});

describe("Wrong-call detector — error_then_retry heuristic", () => {
  it("detects error response + different tool retry", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "pg_query", family: "pg", outcome: "error", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "pg_schema", family: "pg", turnNumber: 0, timestamp: 2000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(1);
    expect(result.wrongCalls[0]!.heuristic).toBe("error_then_retry");
    expect(result.wrongCalls[0]!.confidence).toBe(0.90);
  });

  it("detects cross-family error → retry", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "gh_search", family: "gh", outcome: "error", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "pg_query", family: "pg", turnNumber: 0, timestamp: 2000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(1);
  });
});

describe("Wrong-call detector — same_family_switch heuristic", () => {
  it("detects low-token success + same family different tool", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "gh_search", family: "gh", outcome: "success", responseTokens: 20, turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "gh_list_prs", family: "gh", turnNumber: 0, timestamp: 2000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(1);
    expect(result.wrongCalls[0]!.heuristic).toBe("same_family_switch");
    expect(result.wrongCalls[0]!.confidence).toBe(0.60);
  });

  it("does NOT flag high-token response (meaningful result)", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "gh_search", family: "gh", outcome: "success", responseTokens: 500, turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "gh_list_prs", family: "gh", turnNumber: 0, timestamp: 2000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(0);
  });
});

describe("Wrong-call detector — multi-call traces", () => {
  it("detects multiple wrong calls in a session", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "gh_search", family: "gh", outcome: "empty", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "gh_list_prs", family: "gh", turnNumber: 0, timestamp: 2000 }),
      makeTrace({ toolName: "pg_query", family: "pg", outcome: "error", turnNumber: 1, timestamp: 3000 }),
      makeTrace({ toolName: "pg_schema", family: "pg", turnNumber: 1, timestamp: 4000 }),
      makeTrace({ toolName: "slk_post", family: "slk", outcome: "success", responseTokens: 300, turnNumber: 2, timestamp: 5000 }),
    ];
    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(2);
    expect(result.totalCalls).toBe(5);
    expect(result.wrongCallRate).toBe(2 / 5);
  });

  it("40-turn session with mixed patterns", () => {
    const trace: ToolCallTrace[] = [];
    let ts = 1000;

    for (let turn = 0; turn < 40; turn++) {
      if (turn % 10 === 3) {
        trace.push(makeTrace({ toolName: "gh_search", family: "gh", outcome: "empty", turnNumber: turn, timestamp: ts }));
        ts += 1000;
        trace.push(makeTrace({ toolName: "gh_list_prs", family: "gh", turnNumber: turn, timestamp: ts }));
      } else {
        trace.push(makeTrace({ toolName: "file_read", family: "unerr", outcome: "success", responseTokens: 500, turnNumber: turn, timestamp: ts }));
      }
      ts += 2000;
    }

    const result = detectWrongCalls(trace);
    expect(result.wrongCalls).toHaveLength(4);
    expect(result.totalCalls).toBe(44);
  });

  it("empty trace returns zero", () => {
    const result = detectWrongCalls([]);
    expect(result.wrongCalls).toHaveLength(0);
    expect(result.totalCalls).toBe(0);
    expect(result.wrongCallRate).toBe(0);
  });

  it("single call trace returns zero wrong calls", () => {
    const result = detectWrongCalls([
      makeTrace({ toolName: "file_read", family: "unerr" }),
    ]);
    expect(result.wrongCalls).toHaveLength(0);
    expect(result.totalCalls).toBe(1);
  });
});

describe("Selection accuracy computation", () => {
  it("perfect trace returns 1.0", () => {
    const trace: ToolCallTrace[] = Array.from({ length: 20 }, (_, i) =>
      makeTrace({ toolName: "file_read", family: "unerr", turnNumber: i, timestamp: i * 2000, responseTokens: 500 }),
    );
    expect(computeSelectionAccuracy(trace)).toBe(1.0);
  });

  it("all-wrong trace returns expected rate", () => {
    const trace: ToolCallTrace[] = [];
    for (let i = 0; i < 10; i++) {
      trace.push(makeTrace({ toolName: "gh_search", family: "gh", outcome: "empty", turnNumber: i, timestamp: i * 1000 }));
      trace.push(makeTrace({ toolName: "gh_list", family: "gh", outcome: "success", turnNumber: i, timestamp: i * 1000 + 500 }));
    }
    const accuracy = computeSelectionAccuracy(trace);
    expect(accuracy).toBe(0.5);
  });
});

describe("Retry counting", () => {
  it("counts same-family different-tool retries", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "pg_query", family: "pg", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "pg_schema", family: "pg", turnNumber: 0, timestamp: 2000 }),
      makeTrace({ toolName: "pg_tables", family: "pg", turnNumber: 1, timestamp: 3000 }),
    ];
    expect(countRetries(trace)).toBe(2);
  });

  it("does not count different-family switches as retries", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "pg_query", family: "pg", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "gh_search", family: "gh", turnNumber: 1, timestamp: 3000 }),
    ];
    expect(countRetries(trace)).toBe(0);
  });

  it("does not count non-consecutive turns as retries", () => {
    const trace: ToolCallTrace[] = [
      makeTrace({ toolName: "pg_query", family: "pg", turnNumber: 0, timestamp: 1000 }),
      makeTrace({ toolName: "pg_schema", family: "pg", turnNumber: 5, timestamp: 50000 }),
    ];
    expect(countRetries(trace)).toBe(0);
  });
});

describe("ReasoningCounter — prevented wrong calls", () => {
  it("counts prevented call when agent takes alternative and succeeds", () => {
    const counter = new ReasoningCounter();
    counter.recordSoftRefuse("get_critical_nodes", "search_code", 0);
    counter.recordFollowUp("search_code", true, 0);

    const snap = counter.getSnapshot();
    expect(snap.preventedWrongCalls).toBe(1);
    expect(snap.alternativesTaken).toBe(1);
    expect(snap.alternativesSucceeded).toBe(1);
  });

  it("does not count prevented if agent ignores alternative", () => {
    const counter = new ReasoningCounter();
    counter.recordSoftRefuse("get_critical_nodes", "search_code", 0);
    counter.recordFollowUp("file_read", true, 0);

    const snap = counter.getSnapshot();
    expect(snap.preventedWrongCalls).toBe(0);
    expect(snap.alternativesTaken).toBe(0);
  });

  it("does not count prevented if alternative fails", () => {
    const counter = new ReasoningCounter();
    counter.recordSoftRefuse("get_critical_nodes", "search_code", 0);
    counter.recordFollowUp("search_code", false, 0);

    const snap = counter.getSnapshot();
    expect(snap.preventedWrongCalls).toBe(0);
    expect(snap.alternativesTaken).toBe(1);
    expect(snap.alternativesSucceeded).toBe(0);
  });

  it("tracks retries saved vs baseline", () => {
    const counter = new ReasoningCounter();
    counter.setBaselineRetries(8);
    counter.recordRetry();
    counter.recordRetry();
    counter.recordRetry();

    const snap = counter.getSnapshot();
    expect(snap.retriesSaved).toBe(5);
    expect(snap.totalRetries).toBe(3);
    expect(snap.baselineRetries).toBe(8);
  });

  it("retries saved never negative", () => {
    const counter = new ReasoningCounter();
    counter.setBaselineRetries(2);
    for (let i = 0; i < 5; i++) counter.recordRetry();

    const snap = counter.getSnapshot();
    expect(snap.retriesSaved).toBe(0);
  });
});

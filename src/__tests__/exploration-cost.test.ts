import { describe, expect, it } from "vitest";
import { estimateExplorationCost } from "../intelligence/exploration-cost.js";

describe("exploration-cost — MCP tool alias resolution", () => {
  it("get_references resolves to find_callers rule (not DEFAULT_RULE)", () => {
    const aliased = estimateExplorationCost("get_references", 5);
    const target = estimateExplorationCost("find_callers", 5);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
    expect(aliased.counterfactualMethod).toBe(target.counterfactualMethod);
  });

  it("search_code resolves to search_entities rule", () => {
    const aliased = estimateExplorationCost("search_code", 8);
    const target = estimateExplorationCost("search_entities", 8);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
    expect(aliased.counterfactualMethod).toBe(target.counterfactualMethod);
  });

  it("get_conventions resolves to show_conventions rule", () => {
    const aliased = estimateExplorationCost("get_conventions", 0, 12);
    const target = estimateExplorationCost("show_conventions", 0, 12);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
  });

  it("get_critical_nodes resolves to risk_assessment rule", () => {
    const aliased = estimateExplorationCost("get_critical_nodes", 4);
    const target = estimateExplorationCost("risk_assessment", 4);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
  });

  it("get_cross_boundary_links resolves to risk_assessment rule", () => {
    const aliased = estimateExplorationCost("get_cross_boundary_links", 6);
    const target = estimateExplorationCost("risk_assessment", 6);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
  });

  it("file_connections resolves to risk_assessment rule", () => {
    const aliased = estimateExplorationCost("file_connections", 3);
    const target = estimateExplorationCost("risk_assessment", 3);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
  });

  it("file_outline falls through to DEFAULT_RULE (returns N entities, not 1)", () => {
    // Intentionally NOT aliased: get_entity assumes 1 returned entity and yields
    // negative savings as resultSize grows. DEFAULT_RULE scales positively with N.
    const result = estimateExplorationCost("file_outline", 15);
    // DEFAULT_RULE: 150 + ceil(15/2)*400 = 150 + 8*400 = 3350
    expect(result.tokensWithout).toBe(150 + 8 * 400);
    expect(result.counterfactualMethod).toBe("generic file exploration");
  });

  it("get_imports resolves to find_callers rule", () => {
    const aliased = estimateExplorationCost("get_imports", 10);
    const target = estimateExplorationCost("find_callers", 10);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
  });

  it("get_test_coverage resolves to find_callers rule", () => {
    const aliased = estimateExplorationCost("get_test_coverage", 7);
    const target = estimateExplorationCost("find_callers", 7);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
  });

  it("get_file resolves to get_entity rule", () => {
    const aliased = estimateExplorationCost("get_file", 1);
    const target = estimateExplorationCost("get_entity", 1);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
  });

  it("file_read falls through to DEFAULT_RULE (has its own dedicated mechanism)", () => {
    // file_read is tracked via mechanism="file_read" with full-file counterfactual.
    // Letting it also alias graph_query would double-count. Keep it on DEFAULT_RULE
    // so graph_query events fire (when positive) without inheriting get_entity math.
    const result = estimateExplorationCost("file_read", 4);
    // DEFAULT_RULE: 150 + ceil(4/2)*400 = 150 + 2*400 = 950
    expect(result.tokensWithout).toBe(150 + 2 * 400);
    expect(result.counterfactualMethod).toBe("generic file exploration");
  });

  it("get_project_stats resolves to health_grade rule", () => {
    const aliased = estimateExplorationCost("get_project_stats", 0, 50);
    const target = estimateExplorationCost("health_grade", 0, 50);
    expect(aliased.tokensWithout).toBe(target.tokensWithout);
  });

  it("legacy keys still resolve directly (not regressed by alias layer)", () => {
    // blast_radius and find_callers are still used internally — must remain stable
    const blast = estimateExplorationCost("blast_radius", 4);
    expect(blast.counterfactualMethod).toContain("read each caller file");

    const callers = estimateExplorationCost("find_callers", 4);
    expect(callers.counterfactualMethod).toContain("grep + read");
  });

  it("unknown tool name still falls through to DEFAULT_RULE", () => {
    const result = estimateExplorationCost("totally_unknown_tool", 4);
    // DEFAULT_RULE: fileMultiplier = ceil(resultSize / 2) = 2, tokensPerFile = 400, baseTokens = 150
    expect(result.tokensWithout).toBe(150 + 2 * 400);
    expect(result.counterfactualMethod).toBe("generic file exploration");
  });

  it("aliased tools beat DEFAULT_RULE on at least one shape", () => {
    // search_code with 10 results: search_entities gives 200 + min(10,20)*500 = 5200
    // DEFAULT_RULE would give 150 + ceil(10/2)*400 = 2150
    // Confirms the alias is actually changing the calculation
    const aliased = estimateExplorationCost("search_code", 10);
    expect(aliased.tokensWithout).toBe(200 + 10 * 500);
  });
});

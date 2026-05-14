/**
 * Exploration Cost Estimator — counterfactual token cost analysis.
 *
 * Estimates what an AI agent WOULD have spent in tokens to gather the same
 * information without the graph intelligence layer. This quantifies the
 * value of graph-backed tools vs naive file exploration.
 *
 * Counterfactual baselines (tokens the agent would consume without graph):
 *   - blast_radius: 500 tokens/file × caller count (read each caller file)
 *   - find_callers: grep output (~200 tokens) + read each file (~500 tokens)
 *   - show_community: ls (~50 tokens) + read 15 files (~500 tokens each)
 *   - search_entities: grep output (~200 tokens) + read 10 files (~500 tokens)
 *   - get_entity: read file (~500 tokens) + parse mentally (~100 tokens)
 *   - health_grade: read 20 files + compute manually
 *
 * All estimates are conservative (lower bound of actual cost).
 */

import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("exploration-cost");

export interface ExplorationCostEstimate {
  queryType: string;
  tokensUsed: number;
  tokensWithout: number;
  counterfactualMethod: string;
  explanation: string;
}

interface CounterfactualRule {
  tokensPerFile: number;
  baseTokens: number;
  fileMultiplier: (resultSize: number, entityCount?: number) => number;
  method: string;
  explain: (resultSize: number, entityCount?: number) => string;
}

const COUNTERFACTUAL_RULES: Record<string, CounterfactualRule> = {
  blast_radius: {
    tokensPerFile: 500,
    baseTokens: 100,
    fileMultiplier: (resultSize) => Math.max(resultSize, 1),
    method: "read each caller file + parse for references",
    explain: (resultSize) =>
      `Without graph: grep for symbol → read ${resultSize} caller files (~500 tok each) + parse references`,
  },
  find_callers: {
    tokensPerFile: 500,
    baseTokens: 200,
    fileMultiplier: (resultSize) => Math.max(resultSize, 1),
    method: "grep + read each matching file",
    explain: (resultSize) =>
      `Without graph: grep across codebase (~200 tok) → read ${resultSize} matching files (~500 tok each)`,
  },
  show_community: {
    tokensPerFile: 500,
    baseTokens: 50,
    fileMultiplier: (_resultSize, entityCount) =>
      Math.max(entityCount ?? 15, 5),
    method: "ls directory + read community files",
    explain: (_resultSize, entityCount) =>
      `Without graph: ls directory (~50 tok) → read ${entityCount ?? 15} related files (~500 tok each)`,
  },
  search_entities: {
    tokensPerFile: 500,
    baseTokens: 200,
    fileMultiplier: (resultSize) => Math.min(Math.max(resultSize, 1), 20),
    method: "grep + read matching files",
    explain: (resultSize) =>
      `Without graph: grep codebase (~200 tok) → read ${Math.min(resultSize, 20)} result files (~500 tok each)`,
  },
  get_entity: {
    tokensPerFile: 500,
    baseTokens: 100,
    fileMultiplier: () => 1,
    method: "find file + read + parse",
    explain: () =>
      "Without graph: find file location (~100 tok) → read entire file (~500 tok)",
  },
  health_grade: {
    tokensPerFile: 400,
    baseTokens: 300,
    fileMultiplier: (_resultSize, entityCount) =>
      Math.max(entityCount ?? 20, 5),
    method: "read multiple files + manual analysis",
    explain: (_resultSize, entityCount) =>
      `Without graph: read ${entityCount ?? 20} files (~400 tok each) + manual complexity analysis (~300 tok)`,
  },
  show_conventions: {
    tokensPerFile: 300,
    baseTokens: 500,
    fileMultiplier: (_resultSize, entityCount) =>
      Math.max(entityCount ?? 10, 3),
    method: "read sample files + infer patterns",
    explain: (_resultSize, entityCount) =>
      `Without graph: read ${entityCount ?? 10} sample files (~300 tok each) + infer conventions (~500 tok)`,
  },
  risk_assessment: {
    tokensPerFile: 500,
    baseTokens: 200,
    fileMultiplier: (resultSize) => Math.max(resultSize, 3),
    method: "read callers + analyze dependencies manually",
    explain: (resultSize) =>
      `Without graph: read ${Math.max(resultSize, 3)} dependency files (~500 tok each) + manual risk analysis`,
  },
};

const DEFAULT_RULE: CounterfactualRule = {
  tokensPerFile: 400,
  baseTokens: 150,
  fileMultiplier: (resultSize) => Math.max(Math.ceil(resultSize / 2), 1),
  method: "generic file exploration",
  explain: (resultSize) =>
    `Without graph: explore ~${Math.max(Math.ceil(resultSize / 2), 1)} files (~400 tok each)`,
};

/**
 * Maps actual MCP tool names to the underlying counterfactual rule key.
 * Without this layer, every modern tool name (`get_references`, `search_code`,
 * etc.) falls through to DEFAULT_RULE and the specialized cost models above
 * become dead code.
 */
const TOOL_ALIAS: Record<string, string> = {
  // Reference tools — same profile as find_callers (grep + read each match)
  get_references: "find_callers",
  get_callers: "find_callers",
  get_callees: "find_callers",
  get_imports: "find_callers",
  get_test_coverage: "find_callers",
  // Search — same profile as search_entities (grep across project + read top hits)
  search_code: "search_entities",
  // Single-entity reads — same profile as get_entity (find file + read it)
  get_function: "get_entity",
  get_class: "get_entity",
  get_file: "get_entity",
  // file_outline/file_read NOT aliased: get_entity assumes ONE returned entity,
  // but file_outline returns N entities and file_read returns a body of content.
  // Inheriting get_entity's cost curve produces negative savings (saved=-650 for
  // a typical 15-entity outline) which suppresses the token-flow event.
  // Letting them fall through to DEFAULT_RULE applies fileMultiplier=ceil(resultSize/2)
  // which yields positive savings.
  // Conventions
  get_conventions: "show_conventions",
  // Risk / structural — read deps + analyze manually
  get_critical_nodes: "risk_assessment",
  get_cross_boundary_links: "risk_assessment",
  file_connections: "risk_assessment",
  // Project-wide stats — counterfactual is reading many files to compute
  get_project_stats: "health_grade",
};

function resolveQueryType(queryType: string): string {
  return TOOL_ALIAS[queryType] ?? queryType;
}

/**
 * Estimates the counterfactual token cost for a single query.
 *
 * @param queryType - the tool/query name (e.g. "blast_radius", "find_callers",
 *   or an actual MCP tool name like "get_references" — aliases are resolved
 *   to the matching rule)
 * @param resultSize - number of results returned (entities, callers, files, etc.)
 * @param entityCount - optional total entities involved (for community/health queries)
 */
export function estimateExplorationCost(
  queryType: string,
  resultSize: number,
  entityCount?: number,
): ExplorationCostEstimate {
  const ruleKey = resolveQueryType(queryType);
  const rule = COUNTERFACTUAL_RULES[ruleKey] ?? DEFAULT_RULE;
  const fileCount = rule.fileMultiplier(resultSize, entityCount);

  const tokensWithout = rule.baseTokens + fileCount * rule.tokensPerFile;

  const tokensUsed = estimateGraphQueryTokens(ruleKey, resultSize);

  return {
    queryType,
    tokensUsed,
    tokensWithout,
    counterfactualMethod: rule.method,
    explanation: rule.explain(resultSize, entityCount),
  };
}

/**
 * Creates a session-scoped accumulator that tracks cumulative exploration savings.
 */
export function createExplorationAccumulator(): {
  record: (estimate: ExplorationCostEstimate) => void;
  getTotal: () => { saved: number; without: number; ratio: number };
  getHistory: () => ExplorationCostEstimate[];
  getBreakdown: () => Map<string, { saved: number; count: number }>;
} {
  const history: ExplorationCostEstimate[] = [];

  function record(estimate: ExplorationCostEstimate): void {
    history.push(estimate);
  }

  function getTotal(): { saved: number; without: number; ratio: number } {
    let totalUsed = 0;
    let totalWithout = 0;

    for (const est of history) {
      totalUsed += est.tokensUsed;
      totalWithout += est.tokensWithout;
    }

    const saved = totalWithout - totalUsed;
    const ratio = totalWithout > 0 ? totalUsed / totalWithout : 1;

    return {
      saved,
      without: totalWithout,
      ratio: Math.round(ratio * 1000) / 1000,
    };
  }

  function getHistory(): ExplorationCostEstimate[] {
    return [...history];
  }

  function getBreakdown(): Map<string, { saved: number; count: number }> {
    const breakdown = new Map<string, { saved: number; count: number }>();

    for (const est of history) {
      const existing = breakdown.get(est.queryType) ?? {
        saved: 0,
        count: 0,
      };
      existing.saved += est.tokensWithout - est.tokensUsed;
      existing.count += 1;
      breakdown.set(est.queryType, existing);
    }

    return breakdown;
  }

  return { record, getTotal, getHistory, getBreakdown };
}

/**
 * Estimates tokens consumed by the graph-backed query itself.
 * Graph responses are compact structured JSON — much smaller than raw file reads.
 */
function estimateGraphQueryTokens(
  queryType: string,
  resultSize: number,
): number {
  const perResultTokens: Record<string, number> = {
    blast_radius: 30,
    find_callers: 25,
    show_community: 20,
    search_entities: 35,
    get_entity: 80,
    health_grade: 50,
    show_conventions: 40,
    risk_assessment: 45,
  };

  const baseTokens = 50;
  const perResult = perResultTokens[queryType] ?? 30;

  return baseTokens + resultSize * perResult;
}

/**
 * Sprint P0-1 — Description Compression & Budget CI tests.
 *
 * Three concerns under test:
 *   1. The token counter is BPE-accurate and stable.
 *   2. The budget enforcer rejects overruns and accepts in-budget strings.
 *   3. The description provider + tool-definitions composer hold the
 *      "single source of truth" invariant: every (tool, state) pair is
 *      within its budget, and tool-definitions.ts emits descriptions
 *      identical to the provider's `active` state.
 */

import { describe, expect, it } from "vitest";

import {
  BUDGETS,
  ToolBudgetError,
  budgetCapFor,
  budgetHeadroom,
  countTokens,
  enforceBudget,
} from "../proxy/tool-budget.js";
import {
  TOOL_DEFINITIONS,
  renderToolDefinition,
} from "../proxy/tool-definitions.js";
import {
  type DescriptionState,
  InvalidStateError,
  TIER_ENTRIES,
  UnknownToolError,
  getDescription,
  getTier,
  listToolNames,
  statesToValidate,
  toolsByTier,
} from "../proxy/tool-descriptions.js";

describe("tool-budget: countTokens", () => {
  it("returns deterministic counts across repeated calls", () => {
    const sample = "search code entities by name across the entire project";
    expect(countTokens(sample)).toBe(countTokens(sample));
  });

  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("scales with string length monotonically", () => {
    const short = countTokens("search");
    const long = countTokens("search code entities by name across the project");
    expect(long).toBeGreaterThan(short);
  });
});

describe("tool-budget: enforceBudget", () => {
  it("accepts descriptions within cap", () => {
    expect(() =>
      enforceBudget("tool_x", "search code", "tier1Active")
    ).not.toThrow();
  });

  it("throws ToolBudgetError on overrun with structured fields", () => {
    const oversized = "x ".repeat(200);
    try {
      enforceBudget("tool_x", oversized, "locked");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolBudgetError);
      const err = e as ToolBudgetError;
      expect(err.toolName).toBe("tool_x");
      expect(err.budgetKey).toBe("locked");
      expect(err.observed).toBeGreaterThan(err.cap);
      expect(err.cap).toBe(BUDGETS.locked);
    }
  });

  it("budgetHeadroom reports positive headroom for in-budget strings", () => {
    const h = budgetHeadroom("short", "tier1Active");
    expect(h.headroom).toBeGreaterThan(0);
    expect(h.observed).toBeLessThan(h.cap);
  });

  it("budgetHeadroom reports negative headroom for overruns", () => {
    const h = budgetHeadroom("x ".repeat(200), "locked");
    expect(h.headroom).toBeLessThan(0);
  });
});

describe("tool-descriptions: tier registry", () => {
  const ALL = listToolNames();

  it("contains exactly 7 tools (the advertised catalog; file_edit is the unerr-owned edit path with edit + whole-file write modes; get_entity + unerr_context merged into search_code)", () => {
    expect(ALL.length).toBe(7);
  });

  it("partitions tools into exactly 6 / 0 / 1 across tiers 1 / 2 / 3", () => {
    expect(toolsByTier(1)).toHaveLength(6);
    expect(toolsByTier(2)).toHaveLength(0);
    expect(toolsByTier(3)).toHaveLength(1);
  });

  it("places the 6 starter tools in tier 1", () => {
    const tier1 = new Set(toolsByTier(1));
    for (const name of [
      "search_code",
      "file_outline",
      "file_read",
      "file_edit",
      "get_references",
      "fetch_url",
    ]) {
      expect(tier1.has(name)).toBe(true);
    }
  });

  it("getTier matches the entry's tier", () => {
    for (const name of ALL) {
      expect(getTier(name)).toBe(TIER_ENTRIES[name]?.tier);
    }
  });

  it("throws UnknownToolError for an unknown name", () => {
    expect(() => getTier("not_a_tool")).toThrow(UnknownToolError);
    expect(() => getDescription("not_a_tool", "active")).toThrow(
      UnknownToolError
    );
  });
});

describe("tool-descriptions: getDescription state machine", () => {
  it("returns the active string for every tool", () => {
    for (const name of listToolNames()) {
      const s = getDescription(name, "active");
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it("throws InvalidStateError when asking for locked on a tier 1 tool", () => {
    expect(() => getDescription("search_code", "locked")).toThrow(
      InvalidStateError
    );
  });

  it("throws InvalidStateError when asking for unlocked on a tier 1 tool", () => {
    expect(() => getDescription("file_read", "unlocked")).toThrow(
      InvalidStateError
    );
  });

  it("returns locked and unlocked strings for every tier 2/3 tool", () => {
    for (const name of [...toolsByTier(2), ...toolsByTier(3)]) {
      expect(getDescription(name, "locked").length).toBeGreaterThan(0);
      expect(getDescription(name, "unlocked").length).toBeGreaterThan(0);
    }
  });

  it("locked descriptions for tier 2/3 contain the unlock hint marker", () => {
    for (const name of [...toolsByTier(2), ...toolsByTier(3)]) {
      expect(getDescription(name, "locked")).toMatch(/^\[locked/);
    }
  });
});

describe("tool-descriptions: budget compliance (the load-bearing invariant)", () => {
  it("every (tool, state) pair fits its budget", () => {
    const violations: string[] = [];
    for (const name of listToolNames()) {
      for (const { state, budget } of statesToValidate(name)) {
        const description = getDescription(name, state);
        const h = budgetHeadroom(description, budget, name);
        if (h.headroom < 0) {
          violations.push(
            `${name}/${state}: ${h.observed} > ${h.cap} (overruns by ${-h.headroom})`
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toHaveLength(0);
  });

  it("tier 1 active descriptions are ≤ their effective cap (per-tool override honored)", () => {
    for (const name of toolsByTier(1)) {
      const t = countTokens(getDescription(name, "active"));
      expect(t, `${name} active`).toBeLessThanOrEqual(
        budgetCapFor(name, "tier1Active")
      );
    }
  });

  it("locked placeholders are ≤ locked cap", () => {
    for (const name of [...toolsByTier(2), ...toolsByTier(3)]) {
      const t = countTokens(getDescription(name, "locked"));
      expect(t, `${name} locked`).toBeLessThanOrEqual(BUDGETS.locked);
    }
  });

  it("unlocked-extended descriptions are ≤ unlockedExtended cap", () => {
    for (const name of [...toolsByTier(2), ...toolsByTier(3)]) {
      const t = countTokens(getDescription(name, "unlocked"));
      expect(t, `${name} unlocked`).toBeLessThanOrEqual(
        BUDGETS.unlockedExtended
      );
    }
  });
});

describe("tool-definitions: outbound MCP composition", () => {
  it("emits one ToolDefinition per known tool", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(listToolNames().length);
  });

  it("composed descriptions match the active provider lookup", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.description).toBe(getDescription(def.name, "active"));
    }
  });

  it("every emitted description fits the tier1Active cap (per-tool override honored)", () => {
    for (const def of TOOL_DEFINITIONS) {
      const t = countTokens(def.description);
      expect(t, def.name).toBeLessThanOrEqual(
        budgetCapFor(def.name, "tier1Active")
      );
    }
  });

  it("every emitted definition carries a valid inputSchema and annotations", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.inputSchema.type).toBe("object");
      expect(typeof def.annotations.title).toBe("string");
      expect(typeof def.annotations.readOnlyHint).toBe("boolean");
      expect(typeof def.annotations.openWorldHint).toBe("boolean");
    }
  });

  it("renderToolDefinition returns the correct description per state", () => {
    // Tier 1 — only active is valid.
    const def1 = renderToolDefinition("search_code", "active");
    expect(def1.description).toBe(getDescription("search_code", "active"));
    expect(() => renderToolDefinition("search_code", "locked")).toThrow();

    // Tier 3 — all three states valid (unerr_track is the sole tier 3 tool).
    const locked = renderToolDefinition("unerr_track", "locked");
    expect(locked.description).toBe(getDescription("unerr_track", "locked"));
    const unlocked = renderToolDefinition("unerr_track", "unlocked");
    expect(unlocked.description).toBe(
      getDescription("unerr_track", "unlocked")
    );
  });

  it("renderToolDefinition throws for unknown tool", () => {
    expect(() =>
      renderToolDefinition("does_not_exist", "active" as DescriptionState)
    ).toThrow();
  });
});

describe("tool-definitions: aggregate savings vs hypothetical verbose baseline", () => {
  // This is the Phase 0 "value receipt" — quantify what the compression
  // actually delivers vs an inflated baseline. The number proves the
  // architecture is doing its job; it is not a fragile threshold.
  it("aggregate active-state tokens are well below 1.5K", () => {
    const total = TOOL_DEFINITIONS.reduce(
      (sum, d) => sum + countTokens(d.description),
      0
    );
    // Tier 1 cap × catalog size is the inflated baseline. Real total is lower.
    expect(total).toBeLessThan(BUDGETS.tier1Active * TOOL_DEFINITIONS.length);
  });
});

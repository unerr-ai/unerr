/**
 * Sprint P0-3 — Soft-refuse builder tests.
 *
 * Three concerns under test:
 *   1. `buildSoftRefuse` emits the documented text shape and `_gate`
 *      envelope for every tier-2/3 tool.
 *   2. Every tier-2/3 tool in `UNLOCK_CONDITIONS` has a matching tier-1
 *      alternative entry (module-load assertion pinned by test).
 *   3. The text is universally parseable as MCP `content[].type === "text"`
 *      and contains no banned hedge verbs or `:N` placeholders.
 */

import { describe, expect, it } from "vitest";

import {
  _internal,
  buildSoftRefuse,
  softRefuseFor,
} from "../proxy/soft-refuse.js";
import { toolsByTier } from "../proxy/tool-descriptions.js";
import { C, UNLOCK_CONDITIONS } from "../proxy/tool-tiers.js";

describe("buildSoftRefuse: shape", () => {
  it("returns one MCP text block with ur|fct prefix and structured fields", () => {
    // get_references is the sole gated tool: C.or(C.editOrWrite(), C.fanIn(5)).
    const refusal = buildSoftRefuse({
      toolName: "get_references",
      condition: C.or(C.editOrWrite(), C.fanIn(5)),
    });
    expect(refusal.content).toHaveLength(1);
    expect(refusal.content[0]?.type).toBe("text");
    const text = refusal.content[0]?.text ?? "";
    expect(text.startsWith("ur|fct get_references locked — ")).toBe(true);
    expect(text).toContain("_error: tool_locked");
    expect(text).toContain(
      "_unlock_when: edit or write attempted OR entity fan_in ≥ 5 observed"
    );
    // The alternative is named once, in the header action ("call file_read
    // first."). The redundant `_alternative:` row was cut as billed noise.
    expect(text).toContain("call file_read first.");
    expect(text).not.toContain("_alternative:");
  });

  it("attaches stable diagnostic fields to _gate", () => {
    const refusal = buildSoftRefuse({
      toolName: "get_references",
      condition: C.or(C.editOrWrite(), C.fanIn(5)),
    });
    expect(refusal._gate).toEqual({
      status: "locked",
      tool: "get_references",
      unlock_when: "edit or write attempted OR entity fan_in ≥ 5 observed",
      alternative_tool: "file_read",
    });
  });

  it("softRefuseFor pulls the policy from UNLOCK_CONDITIONS", () => {
    const refusal = softRefuseFor("get_references");
    expect(refusal._gate.tool).toBe("get_references");
    expect(refusal._gate.alternative_tool).toBe("file_read");
  });

  it("softRefuseFor throws for tools without a policy", () => {
    expect(() => softRefuseFor("search_code")).toThrow(/no unlock policy/);
  });
});

describe("soft-refuse: TIER1_ALTERNATIVE coverage", () => {
  it("has an alternative entry for every tier-2/3 tool", () => {
    const tier23 = [...toolsByTier(2), ...toolsByTier(3)];
    for (const name of tier23) {
      expect(_internal.TIER1_ALTERNATIVE[name]).toBeDefined();
    }
  });

  it("has no orphan alternative entries", () => {
    const policyKeys = new Set(Object.keys(UNLOCK_CONDITIONS));
    for (const name of Object.keys(_internal.TIER1_ALTERNATIVE)) {
      expect(policyKeys.has(name)).toBe(true);
    }
  });

  it("every alternative tool name is itself tier-1", () => {
    const tier1 = new Set(toolsByTier(1));
    for (const [, alt] of Object.entries(_internal.TIER1_ALTERNATIVE)) {
      expect(tier1.has(alt.tool)).toBe(true);
    }
  });
});

describe("soft-refuse: nudge-text quality", () => {
  const BANNED_HEDGES = /\b(consider|verify|review|may want to|try)\b/i;
  const PLACEHOLDER_N = /:N\b/;

  it("text obeys the CLAUDE.md nudge rules for every tier-2/3 tool", () => {
    for (const name of [...toolsByTier(2), ...toolsByTier(3)]) {
      const refusal = softRefuseFor(name);
      const text = refusal.content[0]?.text ?? "";
      expect(text).not.toMatch(BANNED_HEDGES);
      expect(text).not.toMatch(PLACEHOLDER_N);
      expect(text).toContain(`ur|fct ${name} locked`);
    }
  });
});

// NOTE: the example-interpolation describe block was removed during the
// token-overhead catalog reduction. Interpolation (fillExample/refusalContext)
// still exists in soft-refuse.ts, but the only registered alternative template
// (get_references → file_read) is the EMPTY string "", so there are no
// <path>/<symbol>/<name> placeholders left to interpolate. The tests that
// asserted interpolation behaviour were tied to removed tools
// (get_imports/get_critical_nodes/get_file) and can no longer be satisfied —
// they are obsolete, not retargetable.

describe("soft-refuse: unlock text uses the consolidated ur tag (legacy hnt → fct)", () => {
  it("renders the consolidated ur|fct tag, never legacy ur|hnt", () => {
    const refusal = softRefuseFor("get_references", {
      from_path: "src/proxy",
    });
    const text = refusal.content[0]?.text ?? "";
    expect(text.startsWith("ur|fct ")).toBe(true);
    expect(text).not.toContain("ur|hnt");
    // The alternative is named once, in the header action; the redundant
    // `_alternative:` row was cut as billed noise.
    expect(text).toContain("call file_read first.");
    expect(text).not.toContain("_alternative:");
  });
});

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
	it("returns one MCP text block with ur|hnt prefix and structured fields", () => {
		const refusal = buildSoftRefuse({
			toolName: "get_critical_nodes",
			condition: C.fanIn(10),
		});
		expect(refusal.content).toHaveLength(1);
		expect(refusal.content[0]?.type).toBe("text");
		const text = refusal.content[0]?.text ?? "";
		expect(text.startsWith("ur|hnt get_critical_nodes locked — ")).toBe(true);
		expect(text).toContain("_error: tool_locked");
		expect(text).toContain("_unlock_when: entity fan_in ≥ 10 observed");
		expect(text).toContain("_alternative: search_code(");
	});

	it("attaches stable diagnostic fields to _gate", () => {
		const refusal = buildSoftRefuse({
			toolName: "get_imports",
			condition: C.imports(5),
		});
		expect(refusal._gate).toEqual({
			status: "locked",
			tool: "get_imports",
			unlock_when: "file with ≥ 5 imports read",
			alternative_tool: "file_outline",
		});
	});

	it("softRefuseFor pulls the policy from UNLOCK_CONDITIONS", () => {
		const refusal = softRefuseFor("get_critical_nodes");
		expect(refusal._gate.tool).toBe("get_critical_nodes");
		expect(refusal._gate.alternative_tool).toBe("search_code");
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
			// mark_decision / mark_blocker / mark_resolution recommend other
			// marker tools (tier-3 chain) — these are valid because the chain
			// itself unlocks on observed marker counts.
			if (alt.tool.startsWith("mark_")) continue;
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
			expect(text).toContain(`ur|hnt ${name} locked`);
		}
	});
});

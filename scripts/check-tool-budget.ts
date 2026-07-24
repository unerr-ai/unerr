#!/usr/bin/env tsx
/**
 * CI gate: validate every MCP tool description against its tier-aware token
 * budget. Run via `pnpm run check:tool-budget`. Exits 0 on pass, 1 on overrun.
 *
 * This is the same validation `validateAllToolDescriptions()` runs at proxy
 * startup (`src/proxy/tool-descriptions.ts`). The gate exists so failures
 * surface as a compact tabular report in CI rather than as an exception
 * buried in another test's setup.
 */

import {
	BUDGETS,
	type BudgetKey,
	ToolBudgetError,
	budgetHeadroom,
	warmTokenizer,
} from "../src/proxy/tool-budget.js";
import {
	type DescriptionState,
	TIER_ENTRIES,
	getDescription,
	listToolNames,
	statesToValidate,
} from "../src/proxy/tool-descriptions.js";

interface Row {
	tool: string;
	tier: 1 | 2 | 3;
	state: DescriptionState;
	budgetKey: BudgetKey;
	observed: number;
	cap: number;
	headroom: number;
	ok: boolean;
}

await warmTokenizer();

const rows: Row[] = [];

for (const name of listToolNames()) {
	const entry = TIER_ENTRIES[name];
	if (!entry) continue;
	for (const { state, budget } of statesToValidate(name)) {
		const description = getDescription(name, state);
		const h = budgetHeadroom(description, budget, name);
		rows.push({
			tool: name,
			tier: entry.tier,
			state,
			budgetKey: budget,
			observed: h.observed,
			cap: h.cap,
			headroom: h.headroom,
			ok: h.headroom >= 0,
		});
	}
}

const failures = rows.filter((r) => !r.ok);
const COL = {
	tool: Math.max(4, ...rows.map((r) => r.tool.length)),
	state: Math.max(5, ...rows.map((r) => r.state.length)),
	budget: Math.max(6, ...rows.map((r) => r.budgetKey.length)),
};

function pad(s: string | number, width: number, align: "l" | "r" = "l"): string {
	const str = String(s);
	if (str.length >= width) return str;
	const padding = " ".repeat(width - str.length);
	return align === "l" ? str + padding : padding + str;
}

const header = [
	pad("tool", COL.tool),
	"tier",
	pad("state", COL.state),
	pad("budget", COL.budget),
	pad("obs", 4, "r"),
	pad("cap", 4, "r"),
	pad("head", 5, "r"),
	"ok",
].join("  ");

process.stderr.write(`${header}\n`);
process.stderr.write(`${"-".repeat(header.length)}\n`);

for (const r of rows) {
	const line = [
		pad(r.tool, COL.tool),
		`  ${r.tier} `,
		pad(r.state, COL.state),
		pad(r.budgetKey, COL.budget),
		pad(r.observed, 4, "r"),
		pad(r.cap, 4, "r"),
		pad(r.headroom, 5, "r"),
		r.ok ? "✓" : "✗",
	].join("  ");
	process.stderr.write(`${line}\n`);
}

process.stderr.write(`\n${rows.length} description states checked across ${listToolNames().length} tools.\n`);
process.stderr.write(
	`Budgets: tier1Active=${BUDGETS.tier1Active}  locked=${BUDGETS.locked}  unlockedExtended=${BUDGETS.unlockedExtended} (BPE tokens).\n`,
);

if (failures.length > 0) {
	process.stderr.write(`\n${failures.length} overrun(s):\n`);
	for (const f of failures) {
		const err = new ToolBudgetError(f.tool, f.budgetKey, f.observed, f.cap);
		process.stderr.write(`  - ${err.message}\n`);
	}
	process.exit(1);
}

process.stderr.write("\n✓ All descriptions within budget.\n");

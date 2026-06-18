/**
 * W1 — cache-prefix stability (all agents).
 *
 * The cached prefix that every agent carries every turn is `tools/list` +
 * the standing instruction block. If either changes byte-for-byte between
 * turns, prompt-caching busts the whole suffix (exact-prefix KV reuse) and the
 * cache-hit rate `H` collapses — the −46% lever in
 * `.internal/roadmap/AGENT_TOOLING_OVERHEAD_ANALYSIS.md` §4. These guards fail
 * loud if a future change injects a per-session value (timestamp, random,
 * Set/Map-iteration order, a salted hash) into the prefix for ANY agent.
 *
 * Plan: `.internal/roadmap/OVERHEAD_REDUCTION_IMPLEMENTATION_PLAN.md` W1.
 */
import { describe, expect, it } from "vitest";

import { getConfigurableAgents } from "../config/agent-registry.js";
import { generateCustomInstructions } from "../config/instruction-writer.js";
import { ADVERTISED_TOOL_DEFINITIONS } from "../proxy/tool-definitions.js";

// A full ISO timestamp (date + T + clock) is the canonical cache-bust value —
// a plain "2026-06" in prose is fine, an injected `new Date().toISOString()` is
// not. Keep this strict so legitimate year-month strings don't false-positive.
const VOLATILE_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe("W1 cache-prefix stability — tools/list (all agents)", () => {
  it("advertised tools are emitted in a deterministic (name-sorted) order", () => {
    const names = ADVERTISED_TOOL_DEFINITIONS.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });

  it("serializes byte-identically across calls and carries no volatile value", () => {
    const a = JSON.stringify(ADVERTISED_TOOL_DEFINITIONS);
    const b = JSON.stringify(ADVERTISED_TOOL_DEFINITIONS);
    expect(a).toBe(b);
    expect(VOLATILE_ISO.test(a)).toBe(false);
  });
});

describe("W1 cache-prefix stability — instruction block (every instruction-file agent)", () => {
  const instructionAgents = getConfigurableAgents().filter(
    (a) => a.instructionFilePath
  );

  it("the instruction-file agent set is non-empty (guards a silent list collapse)", () => {
    // 9 agents carry an instruction file today (claude-code, cursor, codex,
    // gemini-cli, vscode, github-copilot-cli, cline, windsurf, antigravity);
    // floor at 8 so adding/removing one doesn't break the guard, an emptied
    // list does.
    expect(instructionAgents.length).toBeGreaterThanOrEqual(8);
  });

  for (const agent of instructionAgents) {
    it(`${agent.id}: instruction block is deterministic + non-volatile`, () => {
      const first = generateCustomInstructions(agent.id);
      const second = generateCustomInstructions(agent.id);
      expect(first).toBe(second); // pure function of the agent id
      expect(first.length).toBeGreaterThan(0);
      expect(VOLATILE_ISO.test(first)).toBe(false);
    });
  }
});

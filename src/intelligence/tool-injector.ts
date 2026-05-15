/**
 * Sprint 9.7: Dynamic Tool Injection — inject block-level rules into tool descriptions.
 *
 * At MCP initialize, reads top block-level rules from CozoDB and appends them
 * to `sync_local_diff` and `check_rules` tool descriptions. On Butter-Sync
 * rule changes, emits `tools/list_changed` to refresh IDE descriptions.
 *
 * Budget: 500 tokens (~2000 chars) for injected rule context.
 *
 * Design authority: Phase 6 IS-06, SKILL doc §2.5, Module 6A §6.6.
 */

import type { CompactRule, CozoGraphStore } from "./local-graph.js";

/** stderr logger */
const _log = {
  info: (msg: string) => process.stderr.write(`[unerr:tool-injector] ${msg}\n`),
};

/** MCP tool schema shape (subset) */
export interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Tools that receive rule injection */
const INJECTABLE_TOOLS = new Set(["sync_local_diff", "check_rules"]);

/** Max characters for injected rule context (~500 tokens) */
const MAX_INJECTION_CHARS = 2000;

/** Max number of block rules to inject */
const MAX_BLOCK_RULES = 10;

/**
 * Get block-level rules from CozoDB for injection.
 */
export async function getBlockRules(
  localGraph: CozoGraphStore
): Promise<CompactRule[]> {
  const allRules = await localGraph.getRules();
  return allRules
    .filter((r) => r.severity === "block" && r.enabled)
    .slice(0, MAX_BLOCK_RULES);
}

/**
 * Format block rules into a compact injection string.
 * Stays within 500-token budget.
 */
export function formatRuleInjection(blockRules: CompactRule[]): string {
  if (blockRules.length === 0) return "";

  const lines: string[] = [
    "\n\n---\n**Active Block Rules (violations will be flagged):**",
  ];

  let totalChars = lines[0]?.length ?? 0;

  for (const rule of blockRules) {
    const line = `\n- [${rule.key}] ${rule.name}: ${rule.message || "No description"}`;
    if (totalChars + line.length > MAX_INJECTION_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }

  return lines.join("");
}

/**
 * Inject block-level rule context into tool descriptions.
 * Returns new tool schemas with updated descriptions. Does not mutate input.
 */
export async function injectRuleContext(
  tools: MCPToolSchema[],
  localGraph: CozoGraphStore
): Promise<MCPToolSchema[]> {
  const blockRules = await getBlockRules(localGraph);
  if (blockRules.length === 0) return tools;

  const injection = formatRuleInjection(blockRules);
  if (!injection) return tools;

  _log.info(
    `Injecting ${blockRules.length} block rules into tool descriptions`
  );

  return tools.map((tool) => {
    if (INJECTABLE_TOOLS.has(tool.name)) {
      return {
        ...tool,
        description: (tool.description ?? "") + injection,
      };
    }
    return tool;
  });
}

/**
 * Check if tool descriptions need refreshing after a rule change.
 * Compares current block rules against a cached version.
 */
export async function needsRefresh(
  localGraph: CozoGraphStore,
  cachedRuleKeys: Set<string>
): Promise<boolean> {
  const currentBlockRules = await getBlockRules(localGraph);
  const currentKeys = new Set(currentBlockRules.map((r: CompactRule) => r.key));

  if (currentKeys.size !== cachedRuleKeys.size) return true;

  for (const key of currentKeys) {
    if (!cachedRuleKeys.has(key)) return true;
  }

  return false;
}

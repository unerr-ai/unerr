/**
 * Guard: retired tool names must not appear in agent-facing hint strings.
 *
 * The 9-tool catalog deletion removed these names from the MCP surface, but
 * hint/nudge strings kept recommending them — an agent that pastes
 * `get_test_coverage({key:...})` gets "unknown tool" and burns a retry loop
 * (CLAUDE.md hint rule 1: every hint must be pasteable verbatim).
 *
 * This test strips comments from the known agent-facing emitter files and
 * asserts no retired name survives in executable source (string literals).
 * Internal dispatch sites (query-router cases, unerr-track op mapping,
 * wire-cap cap keys) are NOT scanned — those names are still valid internal
 * ops; only what reaches agent context is constrained.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Tools removed from the advertised MCP catalog. Word-boundary matched. */
const RETIRED_TOOL_NAMES = [
  "recall_facts",
  "record_fact",
  "get_test_coverage",
  "get_critical_nodes",
  "get_project_stats",
  "get_conventions",
  "get_cross_boundary_links",
  "file_connections",
  "get_imports",
  "review_changes",
] as const;

/**
 * Files whose string literals reach agent context: exec nudge footers,
 * PreToolUse/PostToolUse hook nudges, review-finding actions, auto-created
 * fact content, and the advertised tool schema descriptions.
 */
const AGENT_FACING_EMITTERS = [
  "src/commands/exec.ts",
  "src/hooks/navigation-hooks.ts",
  "src/review/checkers/untested-export.ts",
  "src/proxy/tool-definitions.ts",
] as const;

/** Remove block and line comments so doc references don't false-positive. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/[^"'`\n]*$/gm, "");
}

describe("retired tool names never reach agent-facing hints", () => {
  for (const file of AGENT_FACING_EMITTERS) {
    it(`${file} names only advertised tools`, () => {
      const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
      const leaks: string[] = [];
      for (const name of RETIRED_TOOL_NAMES) {
        const re = new RegExp(`\\b${name}\\b`);
        const m = re.exec(source);
        if (m) {
          const line = source.slice(0, m.index).split("\n").length;
          leaks.push(`${name} (≈line ${line} after comment-strip)`);
        }
      }
      expect(leaks, `retired tool name(s) leaked in ${file}`).toEqual([]);
    });
  }
});

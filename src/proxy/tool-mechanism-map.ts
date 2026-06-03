/**
 * Mechanism map — the Phase-2 contract for *where each capability lives*.
 *
 * Phase 1 collapsed the recon read-chain into one call. Phase 2 reclassifies
 * the whole tool surface by MECHANISM, applying one test:
 *
 *   "Does the model need a payload back THIS turn to decide its next action?"
 *     yes  → MCP   (interactive reads the model actively drives)
 *     no   → HOOK  (writes + anchored-context reads — effect is for a future
 *                   turn, or it rides a lifecycle event the model didn't choose)
 *     bulk → CLI   (occasional / large-output / sweep work, off the catalog)
 *
 * This table is the machine-readable form of `.internal/research/
 * tool-call-token-overhead.md` §7.2. It is the single source of truth that
 * Sprints 7–10 implement against:
 *   - Sprint 7 reads `mechanism === "hook"` to know what to lift into hooks.
 *   - Sprint 9 reads `mechanism === "merged"` to know what folds into a survivor.
 *   - Sprint 10 reads `mechanism === "cli"` to know what to demote.
 *   - The router audit (tool-budget.test.ts) asserts the surviving MCP catalog.
 *
 * IMPORTANT: this file describes the *target* state. The runtime still ships
 * every tool as MCP until each sprint lands; the map tells the sprints what to
 * change and lets tests assert the end state without re-deriving it.
 *
 * A module-load assertion keeps this in sync with TIER_ENTRIES (every shipped
 * tool must have a mechanism verdict — no silent drift).
 */

import { TIER_ENTRIES } from "./tool-descriptions.js";

/** Where a capability lives after Phase 2. */
export type ToolMechanism =
  | "mcp" // survives as an interactive MCP read
  | "hook" // lifted onto a lifecycle hook (MCP fallback kept for hook-less agents)
  | "cli" // demoted to an `unerr …` subcommand, off the always-loaded catalog
  | "merged"; // folded into another tool; the name disappears

/** Lifecycle hook events a capability can ride (Claude Code naming). */
export type HookEvent =
  | "UserPromptSubmit"
  | "PostToolUse"
  | "Stop"
  | "SessionStart";

export interface MechanismEntry {
  readonly mechanism: ToolMechanism;
  /** For mechanism === "hook": which event(s) carry it. */
  readonly hookEvents?: readonly HookEvent[];
  /** For mechanism === "cli": the subcommand that replaces it. */
  readonly cliCommand?: string;
  /** For mechanism === "merged": the surviving tool it folds into. */
  readonly mergedInto?: string;
  /**
   * For mechanism === "hook": whether the MCP tool stays registered as a
   * fallback for hook-less agents (and, for writes, as an explicit
   * high-fidelity escape — §7.6). Almost always true; the fire-and-forget
   * telemetry lines (surface2/turn_summary) are the cleanest retirements.
   */
  readonly mcpFallback?: boolean;
  /** One line: why this mechanism, in plain terms. */
  readonly rationale: string;
}

/**
 * The verdict for every tool currently in TIER_ENTRIES (27, incl. the
 * unerr_track op-union added in Sprint 8).
 *
 * Survivors (mechanism "mcp", 6) are the interactive reads the model drives:
 *   unerr_context, search_code, file_read, file_outline, get_entity, fetch_url.
 * unerr_track is mechanism "hook" (the consolidated write surface) — it rides
 * its constituents' hooks and stays an MCP fallback for hook-less agents.
 */
export const TOOL_MECHANISM: Readonly<Record<string, MechanismEntry>> = {
  // ── Survivors — interactive reads (need a payload this turn) ────────────
  unerr_context: {
    mechanism: "mcp",
    rationale: "Keystone recon composite; model decides when to run it.",
  },
  search_code: {
    mechanism: "mcp",
    rationale: "Model needs the hits back to pick a target this turn.",
  },
  file_read: {
    mechanism: "mcp",
    rationale:
      "Model needs file content back; conventions/facts injection half moves to PostToolUse(Read).",
  },
  file_outline: {
    mechanism: "mcp",
    rationale: "Model needs structure back; absorbs get_file.",
  },
  get_entity: {
    mechanism: "mcp",
    rationale:
      "Model needs entity + refs back; absorbs get_references and get_imports via a want[] flag.",
  },
  fetch_url: {
    mechanism: "mcp",
    rationale: "Model needs the page back; also the enforced WebFetch replacement.",
  },

  // ── Merged into a survivor (the name disappears) ────────────────────────
  get_references: {
    mechanism: "merged",
    mergedInto: "get_entity",
    rationale: "get_entity({want:['callers','callees']}); also in unerr_context.",
  },
  get_imports: {
    mechanism: "merged",
    mergedInto: "get_entity",
    rationale: "get_entity({want:['imports']}); niche on its own.",
  },
  get_file: {
    mechanism: "merged",
    mergedInto: "file_outline",
    rationale: "Duplicate of file_outline (entities in a file).",
  },
  record_fact: {
    mechanism: "merged",
    mergedInto: "unerr_remember",
    rationale: "unerr_remember already has a type discriminator; one fact-write path.",
  },

  // ── Writes → hooks (fire-and-forget; needed next turn, not this one) ─────
  unerr_remember: {
    mechanism: "hook",
    hookEvents: ["UserPromptSubmit", "Stop"],
    mcpFallback: true,
    rationale:
      "Write: user rules captured at UserPromptSubmit (verbatim), agent notes scraped from the closing message at Stop. Return drives nothing this turn.",
  },
  mark_intent: {
    mechanism: "hook",
    hookEvents: ["UserPromptSubmit"],
    mcpFallback: true,
    rationale: "Write: intent inferred from the prompt at submit time.",
  },
  mark_decision: {
    mechanism: "hook",
    hookEvents: ["Stop"],
    mcpFallback: true,
    rationale: "Write: scraped from the closing-message sentinel at Stop.",
  },
  mark_blocker: {
    mechanism: "hook",
    hookEvents: ["Stop"],
    mcpFallback: true,
    rationale:
      "Write: scraped at Stop. marker_id return drops under fire-and-forget (server-assigned, surfaced on next recall).",
  },
  mark_resolution: {
    mechanism: "hook",
    hookEvents: ["Stop"],
    mcpFallback: true,
    rationale: "Write: scraped at Stop; references the blocker by most-recent/text.",
  },
  unerr_track: {
    mechanism: "hook",
    hookEvents: ["UserPromptSubmit", "Stop", "PostToolUse"],
    mcpFallback: true,
    rationale:
      "Op-union over the marker+fact writes; each op rides its constituent's hook (intent→UserPromptSubmit; decision/blocker/resolution/fact→Stop; recall→PostToolUse). Kept as the single consolidated MCP write surface for hook-less agents.",
  },

  // ── Anchored-context reads → hooks (model needn't ask for them) ─────────
  unerr_recall_notes: {
    mechanism: "hook",
    hookEvents: ["UserPromptSubmit"],
    mcpFallback: true,
    rationale:
      "Moment-1 prompt notes auto-injected at submit. Moment-2 anchor recall stays inside unerr_context.",
  },
  get_conventions: {
    mechanism: "hook",
    hookEvents: ["PostToolUse"],
    mcpFallback: true,
    rationale: "File conventions auto-injected after a Read; also inside unerr_context.",
  },
  recall_facts: {
    mechanism: "hook",
    hookEvents: ["PostToolUse"],
    mcpFallback: true,
    rationale: "File facts auto-injected after a Read; MCP fallback via unerr_track op:recall.",
  },

  // ── Telemetry lines → hooks (user-facing; cleanest retirements) ─────────
  unerr_surface2_line: {
    mechanism: "hook",
    hookEvents: ["UserPromptSubmit"],
    mcpFallback: true,
    rationale: "Turn-start brief rides the prompt turn via additionalContext.",
  },
  unerr_turn_summary: {
    mechanism: "hook",
    hookEvents: ["Stop"],
    mcpFallback: true,
    rationale: "End-of-turn savings is user-facing only → Stop systemMessage.",
  },

  // ── Bulk / occasional → CLI (off the always-loaded catalog) ─────────────
  get_project_stats: {
    mechanism: "cli",
    cliCommand: "unerr stats",
    rationale: "Occasional orientation; already a CLI command.",
  },
  review_changes: {
    mechanism: "cli",
    cliCommand: "unerr review",
    rationale: "Large output; must not amplify the main thread (run in a subagent).",
  },
  get_critical_nodes: {
    mechanism: "cli",
    cliCommand: "unerr graph critical-nodes",
    rationale: "Rare architecture scan.",
  },
  get_cross_boundary_links: {
    mechanism: "cli",
    cliCommand: "unerr graph cross-boundary",
    rationale: "Rare architecture scan.",
  },
  file_connections: {
    mechanism: "cli",
    cliCommand: "unerr graph connections",
    rationale: "Occasional dependency-neighborhood query.",
  },
  get_test_coverage: {
    mechanism: "cli",
    cliCommand: "unerr graph test-coverage",
    rationale: "Low-frequency pre-edit check.",
  },
};

/** Mechanism verdict for a tool. Throws on unknown name (caller bug). */
export function mechanismOf(toolName: string): MechanismEntry {
  const entry = TOOL_MECHANISM[toolName];
  if (!entry) {
    throw new Error(
      `tool-mechanism-map: no mechanism verdict for "${toolName}". ` +
        `Add it to TOOL_MECHANISM in src/proxy/tool-mechanism-map.ts.`
    );
  }
  return entry;
}

/** All tool names with a given mechanism, sorted. */
export function toolsByMechanism(m: ToolMechanism): readonly string[] {
  return Object.entries(TOOL_MECHANISM)
    .filter(([, e]) => e.mechanism === m)
    .map(([name]) => name)
    .sort();
}

/**
 * The surviving MCP catalog on a *hook-capable* agent — only the interactive
 * reads. Writes/auto-reads are hooks; bulk is CLI; merged names are gone.
 */
export function finalMcpCatalog(): readonly string[] {
  return toolsByMechanism("mcp");
}

/**
 * The MCP catalog on a *hook-less* agent: the survivors PLUS every hook tool
 * that keeps an MCP fallback (writes + recalls), but NOT merged names and NOT
 * CLI demotions. This is what install registers when the agent can't fire the
 * hooks (§7.5).
 */
export function fallbackMcpCatalog(): readonly string[] {
  const survivors = toolsByMechanism("mcp");
  const hookFallbacks = Object.entries(TOOL_MECHANISM)
    .filter(([, e]) => e.mechanism === "hook" && e.mcpFallback)
    .map(([name]) => name);
  return [...survivors, ...hookFallbacks].sort();
}

// ── Module-load drift guard ────────────────────────────────────────────────
//
// Every shipped tool (TIER_ENTRIES) must have a mechanism verdict, and every
// verdict must name a real shipped tool. Keeps this map honest as the surface
// changes across sprints.
(() => {
  const shipped = Object.keys(TIER_ENTRIES);
  const verdicted = Object.keys(TOOL_MECHANISM);

  const missing = shipped.filter((t) => !TOOL_MECHANISM[t]);
  if (missing.length > 0) {
    throw new Error(
      `tool-mechanism-map: TIER_ENTRIES tools without a mechanism verdict: ${missing.join(", ")}.`
    );
  }
  const orphaned = verdicted.filter((t) => !TIER_ENTRIES[t]);
  if (orphaned.length > 0) {
    throw new Error(
      `tool-mechanism-map: verdicts for tools not in TIER_ENTRIES: ${orphaned.join(", ")}.`
    );
  }

  // Merged targets must themselves survive — you can't fold into a tool that's
  // also being removed. A survivor is an mcp read OR a hook tool that keeps an
  // MCP fallback (e.g. record_fact → unerr_remember, which lives on a hook but
  // stays addressable over MCP).
  for (const [name, entry] of Object.entries(TOOL_MECHANISM)) {
    if (entry.mechanism === "merged") {
      const target = entry.mergedInto;
      const targetEntry = target ? TOOL_MECHANISM[target] : undefined;
      const targetSurvives =
        targetEntry?.mechanism === "mcp" ||
        (targetEntry?.mechanism === "hook" && targetEntry.mcpFallback === true);
      if (!targetSurvives) {
        throw new Error(
          `tool-mechanism-map: "${name}" merges into "${target}", which must be a surviving tool (mcp read or hook with MCP fallback).`
        );
      }
    }
  }
})();

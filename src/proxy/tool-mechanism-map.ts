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
 * TOKEN_ECONOMICS_AND_SAVINGS.md` §10. It is the single source of truth that
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
 * The verdict for every tool in TIER_ENTRIES — now exactly the 9 advertised
 * survivors (the Phase-2 migration is complete; the removed names are no
 * longer catalog members, so the drift guard would reject a verdict for them).
 *
 * Survivors (mechanism "mcp", 7) are the interactive reads/edits the model
 * drives:
 *   unerr_context, search_code, file_read, file_outline,
 *   get_references, fetch_url, file_edit.
 * file_edit is interactive: the model needs the apply result (replaced count /
 * staleness reject / written bytes) back this turn to decide its next move, so
 * it is MCP, not a hook.
 * The one advertised write-via-marker (unerr_track) is mechanism "hook" — it
 * rides lifecycle hooks for hook-capable agents and stays advertised as the MCP
 * escape for hook-less ones.
 *
 * The capabilities that USED to be catalog tools (get_entity — merged into
 * search_code({detail:true}) 2026-06 — mark_*, record_fact,
 * recall_facts, get_conventions, get_imports, unerr_turn_summary)
 * are gone from the catalog. They remain reachable only by-name — via a hook's
 * UDS `tools/call`, the unerr_track op-union, the unerr_context composite, or an
 * `unerr exec`/`unerr review`/`unerr stats` CLI — so they need no verdict here.
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
    rationale: "Model needs file structure back to plan a targeted read.",
  },
  get_references: {
    mechanism: "mcp",
    rationale:
      "Flagship blast-radius read; model needs callers/callees back to decide the edit this turn.",
  },
  fetch_url: {
    mechanism: "mcp",
    rationale:
      "Model needs the page back; also the enforced WebFetch replacement.",
  },
  file_edit: {
    mechanism: "mcp",
    rationale:
      "unerr-owned change path (exact-string edit OR whole-file write); model needs the apply result back this turn (replaced count / written bytes, or a staleness/blast-radius reject) to decide its next move.",
  },

  // ── Writes → hooks (fire-and-forget; needed next turn, not this one) ─────
  // unerr_remember left the catalog (2026-06) and carries no verdict: user
  // rules are captured at UserPromptSubmit (remember-client.ts), agent notes
  // ride the `unerr-save:` Stop-hook sentinel (sentinel-persist.ts). Both
  // clients dispatch it by name over UDS, like the other by-name-only tools.
  unerr_track: {
    mechanism: "hook",
    hookEvents: ["UserPromptSubmit", "Stop", "PostToolUse"],
    mcpFallback: true,
    rationale:
      "Op-union over the marker+fact writes; each op rides its constituent's hook (intent→UserPromptSubmit; decision/blocker/resolution/fact→Stop; recall→PostToolUse). The single consolidated MCP write surface for hook-less agents.",
  },
};

/** Mechanism verdict for a tool. Throws on unknown name (caller bug). */
export function mechanismOf(toolName: string): MechanismEntry {
  const entry = TOOL_MECHANISM[toolName];
  if (!entry) {
    throw new Error(
      `tool-mechanism-map: no mechanism verdict for "${toolName}". Add it to TOOL_MECHANISM in src/proxy/tool-mechanism-map.ts.`
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
  // MCP fallback (e.g. a marker write folding into unerr_track, which lives on
  // a hook but stays addressable over MCP).
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

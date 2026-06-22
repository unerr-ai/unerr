/**
 * Sprint D item 10 — contract teaching text.
 *
 * One module owns the canonical text the instruction-writer injects into
 * agent instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, .clinerules,
 * .cursor/rules/*.mdc, .github/copilot-instructions.md). Centralising
 * here keeps the per-agent writers from drifting.
 *
 * Three artifacts:
 *   - CONTRACT_TEACHING_BLOCK — the contract section (~500 tokens) that
 *     explains the four moments, the DSL vocabulary, the cite-in-plan
 *     rule, the quality bar, and the save ritual.
 *   - NOTES_SKILLS — pointer to the consolidated `unerr-memory` skill that
 *     ships in `.claude/skills/` (post-27→7 consolidation; the three prior
 *     entries were folded into one). The canonical body lives in
 *     `src/skills/local-pack.ts → MEMORY_SKILL`.
 *   - TOOL_DESCRIPTION_NUDGES — one-line additions for existing tool
 *     descriptions in src/proxy/tool-descriptions.ts.
 *
 * See ACTIVE_COGNITION_REASON_LAYER.md §14 Sprint D.
 */

import { loadContent } from "../content/loader.js";

// Source-of-truth prose lives in `src/content/instructions.json`
// (id `contract-teaching-block`); `loadContent` returns the raw text.
export const CONTRACT_TEACHING_BLOCK = loadContent("contract-teaching-block");

// The former `NOTES_SKILLS` (a single `unerr-memory` skill pointer) was removed
// in the 2026-06 usage-driven consolidation: the memory skill was invoked 0×
// across 174 sessions because the four-moment contract runs through the
// UserPromptSubmit/Stop hooks and ships in CONTRACT_TEACHING_BLOCK + the
// instruction file — never via a Skill() call. No consumer remained.

export interface ToolDescriptionNudge {
  tool: string;
  /** One short clause appended to the tool's description. */
  nudge: string;
}

export const TOOL_DESCRIPTION_NUDGES: readonly ToolDescriptionNudge[] = [
  {
    tool: "search_code",
    nudge: "Contract surprise? emit unerr-save: note fct|e:<key>|~|<line>.",
  },
  {
    tool: "file_read",
    nudge:
      "file_read auto-injects rule-notes, conventions, and drift for the file inline — read them before editing.",
  },
  {
    tool: "get_references",
    nudge:
      "If fan_in≥10, emit unerr-save: note wrn|e:<entity_key>|-|<chokepoint reason> in your closing message.",
  },
  // get_entity merged into search_code({detail:true}) 2026-06 — its
  // contract-surprise nudge moved onto search_code above.
];

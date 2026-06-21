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

export interface SkillSpec {
  /** Filename written into .claude/skills/ (without .md extension). */
  slug: string;
  /** Short label for tool/menu rendering. */
  title: string;
  /** Full skill body — markdown with frontmatter. */
  body: string;
}

// Post-consolidation (27→7): the prior `unerr-prompt-receipt`,
// `unerr-anchor-query`, and `unerr-save-at-end` skills are folded into the
// single `unerr-memory` skill defined in src/skills/local-pack.ts. The
// canonical skill body ships from `local-pack.ts → MEMORY_SKILL`. This
// re-export is a slim pointer so consumers that historically iterated
// NOTES_SKILLS still see a single coherent entry.
export const NOTES_SKILLS: readonly SkillSpec[] = [
  {
    slug: "unerr-memory",
    title: "unerr: memory (four-moment contract + user-fed capture)",
    body: `---
title: unerr: memory (four-moment contract + user-fed capture)
description: Use on every user prompt (Moment 1 recall) and when the user says remember / always / never. Persist anchored notes at task close.
---

# unerr: memory

The full body ships from \`src/skills/local-pack.ts → MEMORY_SKILL\`.
See \`.claude/skills/unerr-memory/SKILL.md\` after install.

The four moments:

1. **Prompt receipt** — the UserPromptSubmit hook injects relevant anchored notes into context automatically. Read the injected notes; no recall call.
2. **Anchor query** — once files/entities are known, call \`unerr_context({prompt: "<what you are about to do>"})\` for the anchored notes + entities + callers + conventions bundle.
3. **Cite in plan** — cite returned notes by \`kind + anchor\`.
4. **Save at task end** — emit \`unerr-save: note <DSL wire>\` in your closing message (Stop hook persists; zero round-trip) only if non-obvious + useful next session + anchorable.

User-fed capture: when the user says "remember", "always", "from now on", or
"never", the UserPromptSubmit hook captures the directive automatically —
no tool call. Ambiguous captures surface for confirmation on the next turn.
`,
  },
];

export interface ToolDescriptionNudge {
  tool: string;
  /** One short clause appended to the tool's description. */
  nudge: string;
}

export const TOOL_DESCRIPTION_NUDGES: readonly ToolDescriptionNudge[] = [
  {
    tool: "search_code",
    nudge:
      "If an entity's contract surprises you, emit unerr-save: note fct|e:<entity_key>|~|<one-line> in your closing message.",
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

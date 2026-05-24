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

export const CONTRACT_TEACHING_BLOCK = `### Active-cognition: four-moment contract (REQUIRED)

unerr's Layer B notes are anchored prose attached to graph nodes. The contract
is **agent-pull**, not unerr-push: you call unerr at four moments, every task.

**Moment 1 — Prompt receipt.** When a user prompt arrives, before drafting:
\`unerr_recall_notes({prompt: <verbatim prompt>})\`. Empty result is fine; the
call itself is the contract.

**Moment 2 — Anchor query.** Once you've identified the files/entities you'll
touch, query for anchored notes: \`unerr_recall_notes({anchors: ["f:src/x.ts",
"e:fooBar"]})\`. Reads return active (non-superseded) notes; topic-shift and
co-change groups ride along.

**Moment 3 — Cite in plan.** When you draft a plan, cite returned notes by
kind + anchor inline. Example: *"Per the wrn on src/proxy/proxy.ts, both
stdio and UDS sites must mirror."* No citation = the note wasn't load-bearing.

**Moment 4 — Save at task end.** When the task closes and you learned
something non-obvious + likely useful next session + anchorable, write it:
\`unerr_remember({type:"note", note:"<DSL wire>", session_id:<sid>})\`.

### DSL vocabulary

Wire format: \`kind|anchor|polarity|content\`

| Field | Values | Notes |
|---|---|---|
| kind | cnv (convention), rul (rule), wrn (warn), dec (decision), blk (blocker), fct (fact) | Pick the strongest fit. |
| anchor | f:<path> · e:<entity> · g:<glob> · p: | \`p:\` is project-wide. **Discouraged** — pollutes prompt-receipt query. Prefer file/entity. |
| polarity | + (do) / - (don't) / ~ (mixed) | \`~\` for ambiguous; future agent surfaces both sides. |
| content | single line of prose | May contain \`|\` — only the first three are field separators. |

Examples:
- \`rul|f:src/proxy/bridge.ts|-|no intelligence imports\`
- \`wrn|g:*.test.ts|-|don't mock cozo db\`
- \`dec|e:TURN_OPEN_GAP_MS|+|15s avoids RTT misclassification\`

### Quality bar (per save)

A save is justified only if all three hold: (a) non-obvious from the code,
(b) likely useful next session, (c) anchorable. If any miss — don't save.

Session save cap: 15. Over the cap, \`unerr_remember\` returns
\`outcome:"rate_limited"\` with reinforcement candidates; reinforce instead
of writing a new row.

### Conflict + supersession

When you write a note that opposes an existing one (same kind+anchor,
opposite polarity), \`unerr_remember\` returns \`outcome:"conflict"\` with a
\`conflict_group_id\` — surface both sides in your plan.

When you intentionally replace an older note, pass
\`supersedes_note_id:"<old>"\` — the old row flips to inactive (kept for
audit, excluded from queries).
`;

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

1. **Prompt receipt** — first tool call is \`unerr_recall_notes({prompt: "<verbatim>"})\`.
2. **Anchor query** — once files/entities are known, \`unerr_recall_notes({anchors: ["f:...","e:..."]})\`.
3. **Cite in plan** — cite returned notes by \`kind + anchor\`.
4. **Save at task end** — \`unerr_remember({type: "note", note: "<DSL>", session_id})\` only if non-obvious + useful next session + anchorable.

User-fed capture: when the user says "remember", "always", "from now on", or
"never", call \`unerr_remember({source_quote, content, fact_type, scope, subject, confidence})\` BEFORE replying.
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
      "Then call unerr_recall_notes({anchors:['e:<top_hit_key>']}) for notes on the top result.",
  },
  {
    tool: "file_read",
    nudge:
      "Before editing, call unerr_recall_notes({anchors:['f:<file_path>']}) for rule-notes.",
  },
  {
    tool: "get_references",
    nudge:
      "If fan_in≥10, call unerr_remember({type:'note', note:'wrn|e:<entity_key>|-|<chokepoint reason>'}).",
  },
  {
    tool: "get_entity",
    nudge:
      "If contract surprises you, call unerr_remember({type:'note', note:'fct|e:<entity_key>|~|<one-line>'}).",
  },
];

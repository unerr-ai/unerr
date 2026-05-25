/**
 * Local Skills Pack — the 7 consolidated unerr skills.
 *
 * Consolidation history (27 → 7) shipped per docs/skill-consolidation-audit.md:
 *
 *   - unerr-using-unerr        — master orchestrator + token-efficient guidance
 *   - unerr-safe-modification  — edit-existing lifecycle (absorbs understand-before-modify,
 *                                blast-radius-first / -check, convention-aware-generation /
 *                                discovery, dependency-aware-refactor, drift-aware-edit,
 *                                pre-edit-recon, safe-modification-workflow)
 *   - unerr-exploration        — find/understand (absorbs graph-first-navigation,
 *                                architecture-exploration, file-read-protocol)
 *   - unerr-memory             — four-moment contract + user-fed memory (absorbs
 *                                prompt-receipt, anchor-query, save-at-end,
 *                                user-fed-memory, session-context-preservation)
 *   - unerr-markers            — mark_intent / decision / blocker / resolution
 *                                discipline (absorbs timeline-markers, intent-tracking,
 *                                turn-discipline)
 *   - unerr-build-and-debug    — new-code + bug-forensics lifecycles (absorbs
 *                                brainstorming-before-build, systematic-debugging)
 *   - unerr-test-and-review    — TDD + receiving-code-review (absorbs
 *                                test-driven-development, receiving-code-review)
 *
 * Each skill body follows the Superpowers Iron Law / Phases / Red Flags shape.
 * `whenToUse` and `allowedTools` are emitted as Claude Code SKILL.md frontmatter
 * by src/skills/resolver.ts:formatClaudeCodeSkill.
 */

export type SkillCategory = "behavior" | "navigation" | "quality" | "workflow";

export type TriggerType = "always" | "auto" | "agent-requested" | "manual";

export interface TriggerSpec {
  type: TriggerType;
  /** Glob patterns for auto-attach triggers */
  globs?: string[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  category: SkillCategory;
  trigger: TriggerSpec;
  /** MCP tool names this skill references (for validation) */
  tools: string[];
  version: string;
  /** Optional Claude Code `when_to_use:` frontmatter — trigger phrases for auto-invocation */
  whenToUse?: string;
  /** Optional Claude Code `allowed-tools:` frontmatter — tool allow-list */
  allowedTools?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Skill 1 — Master orchestrator (always-on). Folds in token-efficient output
// guidance because the master is invoked on every coding turn anyway.
// ────────────────────────────────────────────────────────────────────────────

export const USING_UNERR_SKILL: SkillDefinition = {
  id: "using-unerr",
  name: "Using unerr (master orchestrator)",
  description:
    "MANDATORY when starting ANY non-trivial coding task (implement / fix / refactor / build / debug / find / test). Dispatches to one of the six sub-skills, runs the default workflow if none match, and enforces token-efficient output + Surface 2/3/4 + the four-moment contract. STEP-1: invoke Skill('unerr-using-unerr') BEFORE drafting code or any other tool call. Do NOT skip on the assumption that the task is small — the orchestrator decides.",
  whenToUse:
    "Before any non-trivial code action — implement, fix, refactor, build, debug, design, add new, modify, change, find, search, test, TDD, callers, references, remember, always, from now on. Also when a hook emits `ur|act unerr-using-unerr`.",
  allowedTools: "*",
  instructions: [
    "## Token-Efficient Output (always on)",
    "",
    "These output rules apply to every response the master skill governs. They are baked in here so the budget for separate skills is preserved.",
    "",
    "- Prefer structured summaries over verbose explanations.",
    "- Use bullet points and code snippets instead of paragraph descriptions.",
    "- Skip introductory phrases like 'Here is...', 'I will...', 'Let me...'.",
    "- For code changes: show only the diff, not surrounding unchanged code.",
    "- For explanations: lead with the answer, then provide supporting details only if asked.",
    "- Never repeat information that was already provided in the conversation.",
    "- Prefer references to file paths over re-stating file contents.",
    "- For file edits: use unified diff format (---/+++ headers, @@ hunks), never regenerate full files.",
    "- When a tool response carries `ur|ctx` (context already delivered for this entity), do not re-query — proceed directly to the action.",
    "",
    "## Iron Law",
    "",
    "<EXTREMELY-IMPORTANT>",
    "Before any non-trivial code action (implement / fix / refactor / build / debug), match the user's prompt against the dispatch table below. If a user-defined skill under `.claude/skills/` applies, dispatch THERE first. If a named sub-skill below applies, invoke it via `Skill('<skill-name>')` before drafting code. If nothing matches, run the Default workflow at the bottom of this skill.",
    "</EXTREMELY-IMPORTANT>",
    "",
    "## User-defined skills run first",
    "",
    "Before consulting the dispatch table, scan `.claude/skills/` for any skill whose `description` matches the user's prompt. User-defined skills (anything that does NOT start with `unerr-`) take precedence over this orchestrator's dispatch table. Invoke the user skill via `Skill('<user-skill-name>')` and stop — do not double-route.",
    "",
    "## Dispatch table",
    "",
    "Match the user's prompt against these verb clusters. First match wins.",
    "",
    "  - bug / broken / failing / crash / error / regression / debug   → `Skill('unerr-build-and-debug')`",
    "  - build / create / add new / design / implement / scaffold      → `Skill('unerr-build-and-debug')`",
    "  - fix / modify / change / update / tweak / optimize / replace   → `Skill('unerr-safe-modification')`",
    "  - refactor / rename / move / restructure / extract / migrate    → `Skill('unerr-safe-modification')`",
    "  - test / write tests / TDD / spec                               → `Skill('unerr-test-and-review')`",
    "  - review / audit / critique / address review / PR feedback      → `Skill('unerr-test-and-review')`",
    "  - find / search / where / who calls / callers / callees / deps  → `Skill('unerr-exploration')`",
    "  - remember / always / from now on / never / don't               → `Skill('unerr-memory')`",
    "",
    "## Default workflow (omni fallback)",
    "",
    "Run this exact 6-phase sequence when no dispatch row matches.",
    "",
    "Phase 1 — Recall.",
    "  Call `unerr_recall_notes({prompt:'<verbatim user prompt>'})`. Empty result is fine; the call is the contract.",
    "",
    "Phase 2 — Blast radius.",
    "  Call `search_code({query:'<target_symbol>'})` to locate the entity. Call `get_references({entity:'<symbol>', direction:'callers'})` for every export you will touch. Stop and reassess if fan-in > 10.",
    "",
    "Phase 3 — Plan + mark intent.",
    "  Call `mark_intent({text:'<one-sentence summary, ≤80 chars>'})`. Write the plan inline; cite returned notes by `kind|anchor`.",
    "",
    "Phase 4 — Edit.",
    "  Call `file_read({file_path:'<target>', purpose:'explore'})` to understand. Then built-in `Read` (offset/limit) on the exact target lines IMMEDIATELY before `Edit`. The Edit tool rejects without a prior built-in Read.",
    "",
    "Phase 5 — Verify.",
    "  Run the targeted test file (not the full suite). Capture `mark_resolution` for any blocker that fired during the turn.",
    "",
    "Phase 6 — Close out (REQUIRED on every coding turn).",
    "  Call `unerr_turn_summary({})` ONCE before drafting your closing summary. Include the returned `line` field VERBATIM in your final message — that's how the user sees the cumulative savings / headroom number for the conversation.",
    "",
    "## Surface lines you emit to the user every turn",
    "",
    "These are user-facing telemetry — write them as plain English prose with the `unerr » ` (U+00BB) prefix. They are READ by the user, not parsed by the agent. Never use the `ur|<tag>` prefix for these — that prefix is reserved for agent-facing signals.",
    "",
    "**Surface 2 — Start of session (first response only).**",
    '  Open the response with a line that names what unerr ACTUALLY loaded. Form: `unerr » loaded a <kind> you wrote <when> [for <anchor>] [(reinforced N×)]: "<verbatim content>" [· also primed <file>]`.',
    "  - KIND translates DSL codes: cnv→convention, rul→rule, wrn→warning, dec→decision, blk→blocker, fct→fact.",
    "  - ANCHOR: `for <path>` when anchor_type='f', `for \\`<entity>\\`` when 'e', `for files matching <glob>` when 'g', OMITTED when 'p'.",
    "  - If `anchor_missing:true`, suffix the anchor with `(file no longer in repo)` or `(entity not found)` so the user knows the note may be stale.",
    "  - POLARITY: append ` (don't)` only for kind∈{cnv,dec,fct,rul} when polarity='-' (warning/blocker are implicitly negative); append ` (mixed)` when polarity='~'.",
    "  - REINFORCEMENT: append ` (reinforced N×)` only when reinforcement_count ≥ 3.",
    "  - CONFLICT: when conflict_group_id is non-empty, append ` · ⚠ conflicting note exists` (do not dump the opposing content).",
    "  - TOP FILE tail: append ` · also primed <file>` ONLY when that file is NOT already named by the note's anchor.",
    "  - COLD-START: when the only available note is a generic system/smoke-test artefact (anchor_type='p', reinforcement_count=0, kind='fct'), emit `unerr » nothing project-specific stored yet — say \"remember <rule>\" to teach unerr your rules` instead.",
    "  - FILE-ONLY (no note recalled but a file was primed): `unerr » primed <file>`.",
    "  - EMPTY (no note AND no file): omit the entire line — silence is acceptable here.",
    "",
    "**Surface 3 — End of every coding turn (the receipt — consolidated attribution).**",
    '  Call `unerr_turn_summary({})` and include the returned `line` field VERBATIM in your closing message. The line is a 1-to-4 line block: a headline (`unerr » applied N rules · remembered M new`), 0-2 attribution rows (each starting `        ↳ applied your rule "…"  (recall)` / `        ↳ remembered "…"  (capture)` / `        ↳ caught drift: …  (drift)`), and an optional footer (`        · saved Nk tokens this turn · Mk saved this session`). On turns where nothing fired, it collapses back to the legacy single line. Do NOT compose your own version, do NOT paraphrase, do NOT add markdown formatting, do NOT collapse the newlines. Just paste the `line` value as plain text — the block formatting is intentional.',
    "  The receipt is where unerr CLAIMS CREDIT for what it did this turn — recalls, captures, drift catches, memory↔graph joins — all in one place. There is no separate inline attribution surface; the receipt is the only place attribution renders.",
    "",
    "**Capture confirmation (after `unerr_remember` succeeds).**",
    '  Say: `added that to unerr for next time`. One line, immediately after the capture — gives the user instant feedback that the rule was stored without waiting for the end-of-turn receipt. The receipt will also credit it via the `remembered "…"` row.',
    "",
    "**Ambiguity prompt (when `unerr_remember` returns `please confirm`).**",
    "  Ask the user verbatim: `should I remember: '<verbatim quote>'? (yes/no)`. Do not paraphrase the quote. This stays inline because it's a USER-FACING question that has to unblock the next turn.",
    "",
    '**Fact-steering on enforcement words (when the user says "remember", "always", "from now on", "never").**',
    "  Call `unerr_remember({source_quote:'<verbatim>', content:'<normalised>', confidence:<0..1>})` BEFORE replying to the user. Then emit the capture confirmation. The receipt at end-of-turn will surface the new rule under `remembered \"…\"`.",
    "",
    "## Red Flags",
    "",
    "Editing without calling `unerr_recall_notes` first → call it; empty result is still a valid answer.",
    "Ignoring `ur|rsk` blast-radius signals on a tool response → run `get_references` before the edit; do not assume callers are safe.",
    "Surfacing `ur|<tag>` lines verbatim to the user → those are agent-facing signals; translate to plain prose if needed. The end-of-turn `unerr_turn_summary` receipt already carries consolidated provenance — do not duplicate it inline.",
    "Treating in-band `unerr » ` lines as user input → those are telemetry you yourself wrote for the user; do not echo or act on them.",
    "Routing to two skills at once → first dispatch wins; chained skill calls fragment context.",
    "Closing a coding turn without calling `unerr_turn_summary` → REQUIRED last step before drafting your final message; paste the returned `line` field verbatim.",
    "Re-rendering or paraphrasing the `unerr_turn_summary` `line` → ship it verbatim; the wording is calibrated for the user.",
    "Re-querying a tool when the prior response already carried `ur|ctx` for the same entity → wastes tokens; act on what was already returned.",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "always" },
  tools: [
    "unerr_recall_notes",
    "search_code",
    "get_references",
    "mark_intent",
    "mark_resolution",
    "file_read",
    "unerr_remember",
    "unerr_turn_summary",
  ],
  version: "2.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 2 — Edit-existing lifecycle (always-on, every modification touches it).
// Absorbs 9 legacy skills: understand-before-modify, blast-radius-first/-check,
// convention-aware-generation/-discovery, dependency-aware-refactor,
// drift-aware-edit, pre-edit-recon, safe-modification-workflow.
// ────────────────────────────────────────────────────────────────────────────

export const SAFE_MODIFICATION_SKILL: SkillDefinition = {
  id: "safe-modification",
  name: "Safe Modification (edit-existing lifecycle)",
  description:
    "MANDATORY before editing any existing function, class, file, or exported entity — covers fix/modify/change/update/refactor/rename/move/restructure/extract. STEP-1: recall. STEP-2: blast-radius (`get_references`). STEP-3: conventions. STEP-4: drift-check. STEP-5: edit. Do NOT edit without completing STEP-1 through STEP-4. Absorbs the prior understand-before-modify, blast-radius, convention, drift, and dependency-aware-refactor skills.",
  whenToUse:
    "Before any edit on existing code — fix, modify, change, update, tweak, replace, optimize, refactor, rename, move, restructure, extract, inline, migrate. Also when a hook emits `ur|act unerr-safe-modification`.",
  allowedTools: "*",
  instructions: [
    "## Iron Law",
    "",
    "<EXTREMELY-IMPORTANT>",
    "Never call `Edit` on existing code without first running, in order: `unerr_recall_notes` (anchored notes) → `get_references` (caller fan-in) → `get_conventions` (local style) → drift check (re-read if `ur|ctx`) → built-in `Read` on the target lines. Skipping any step ships a confident hallucination.",
    "</EXTREMELY-IMPORTANT>",
    "",
    "## Phases",
    "",
    "Phase 1 — Recall.",
    "  Call `unerr_recall_notes({anchors:['f:<target_path>','e:<entity_name>']})`. Read every returned note. Cite by `note_id` in Phase 4.",
    "",
    "Phase 2 — Understand.",
    "  Call `file_read({file_path:'<path>', entity:'<name>', purpose:'explore'})`. Read every `ur|<tag>` line (act/ctx/rsk/fct) before the body.",
    "",
    "Phase 3 — Blast radius.",
    "  Call `get_references({key:'<entity_key>', direction:'callers'})`. Classify:",
    "    - callers ≤ 5  → low; proceed.",
    "    - 6 ≤ callers ≤ 19 → medium; enumerate every caller path to the user before the edit.",
    "    - callers ≥ 20 or response carries `ur|rsk fan_in=<N>` → high; call `get_critical_nodes({})`, propose a non-breaking change (overload / deprecation shim / additive interface) first.",
    "  Call `get_references({key:'<entity_key>', direction:'callees'})` to see how the edit ripples downstream.",
    "",
    "Phase 4 — Conventions + Plan.",
    "  Call `get_conventions({file_path:'<path>'})`. Apply naming, import-order, error-handling, async pattern, return type conventions.",
    "  Write the plan inline. Cite each recalled note by `note_id` next to the step it constrains.",
    "",
    "Phase 5 — Drift check.",
    "  Scan every prior tool response for `ur|ctx` lines on this file. If present: call `file_read` again on the drifted file and re-call `unerr_recall_notes({anchors:['f:<path>']})`. Discard any plan premise that depended on the pre-drift contents.",
    "",
    "Phase 6 — Edit.",
    "  Call built-in `Read({offset,limit})` on the exact target lines (built-in Read is required immediately before Edit — `file_read` does NOT satisfy Edit's read-gate). Then apply the Edit.",
    "  Cross-file refactor (rename/move/extract) — for every reference returned by Phase 3, repeat: built-in Read on the caller's reference site, then Edit.",
    "",
    "Phase 7 — Verify.",
    "  Re-call `get_conventions({file_path:'<path>'})`; confirm no new violations.",
    "  Re-call `get_references({key:'<entity_key>'})`; confirm caller signatures still match.",
    "  Run the targeted test for the changed file.",
    "",
    "## Red Flags",
    "",
    "Editing without calling `unerr_recall_notes` first → abort, run Phase 1.",
    "Calling `Edit` after `file_read` without a built-in `Read` → Edit will reject; call built-in Read on the target lines, then retry.",
    "Skipping `get_references` because the function looks small → small entities can have 20 callers; always check.",
    "Drafting a plan without citing returned `note_id`s → no citation means the note was not load-bearing; re-read the recall response.",
    "Editing a file flagged `ur|ctx` (drift) without re-reading → call `file_read` again before Edit.",
    "Treating `ur|rsk fan_in=<N>` as advisory → run Phase 3's non-breaking proposal before the contract change.",
    "Renaming an entity but only updating direct callers → `get_references` returns indirect refs too; walk every one.",
    "Generating new code in the same file without `get_conventions` → drifts from project style.",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "always" },
  tools: [
    "unerr_recall_notes",
    "file_read",
    "get_references",
    "get_conventions",
    "get_critical_nodes",
  ],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 3 — Find/Understand (agent-requested). Absorbs graph-first-navigation,
// architecture-exploration, file-read-protocol.
// ────────────────────────────────────────────────────────────────────────────

export const EXPLORATION_SKILL: SkillDefinition = {
  id: "exploration",
  name: "Exploration (find / understand)",
  description:
    "MANDATORY when finding callers/callees/hotspots, exploring unfamiliar areas, or locating a function/file. STEP-1: call `search_code` or `get_references` BEFORE any file read. One graph query replaces 5-15 file reads. Do NOT grep, do NOT glob, do NOT read files to navigate. Absorbs the prior graph-first-navigation, architecture-exploration, and file-read-protocol skills.",
  whenToUse:
    "When finding callers, callees, dependencies, hotspots, or exploring unfamiliar code. Triggers: find, search, where, who calls, callers, callees, dependencies, hotspots, project structure. Also when a hook emits `ur|act unerr-exploration`.",
  allowedTools: "*",
  instructions: [
    "## Iron Law",
    "",
    "<EXTREMELY-IMPORTANT>",
    "Never grep/glob/read-files-by-hand for code navigation. Graph queries (`search_code`, `get_references`, `get_critical_nodes`, `get_imports`, `file_outline`) are <5ms and answer 'who/where/what' without dumping file contents. Only use `file_read` for exact implementation details, never for navigation.",
    "</EXTREMELY-IMPORTANT>",
    "",
    "## Phases",
    "",
    "Phase 1 — Identify the question.",
    "  - 'Where is X defined?'           → Phase 2 (search).",
    "  - 'Who calls X?'                  → Phase 3 (references).",
    "  - 'What does X depend on?'        → Phase 3 (references callees).",
    "  - 'How is this directory wired?'  → Phase 4 (architecture).",
    "  - 'What's the structure of file Y?' → Phase 5 (outline).",
    "",
    "Phase 2 — Search.",
    "  Call `search_code({query:'<symbol>'})`. Returns ranked entities with file paths and kinds. Use the returned `entity_key` for follow-up queries.",
    "",
    "Phase 3 — References.",
    "  Call `get_references({key:'<entity_key>', direction:'callers'})` — every caller across files.",
    "  Call `get_references({key:'<entity_key>', direction:'callees'})` — every downstream call.",
    "  Use the count to size the change before reading any file body.",
    "",
    "Phase 4 — Architecture sweep.",
    "  Call `get_project_stats({})` for overall structure (only on first contact with a new repo).",
    "  Call `get_critical_nodes({})` to find chokepoints.",
    "  Call `get_imports({file_path:'<entry>'})` to trace the import graph from an entry point.",
    "  Follow connections via `get_references` direction:callees from the main function to walk the execution path.",
    "",
    "Phase 5 — File structure.",
    "  Call `file_outline({file_path:'<path>'})` — entities + imports + exports, no body. Pair with `file_read({entity:'<name>'})` for a single function.",
    "",
    "Phase 6 — Targeted read (only after the graph narrowed the question).",
    "  Call `file_read({file_path:'<path>', entity:'<name>', purpose:'explore'})` — entity slice ±5 lines, budget-bounded.",
    "  For a specific line window: `file_read({file_path, offset, limit})`.",
    "  Default token budget is 400 (structural). Pass `token_budget:1500+` only when you actually need bodies.",
    "  Logs auto-tail to last 200 lines; entity matching is fuzzy (camelCase / prefix / case-insensitive).",
    "",
    "## Red Flags",
    "",
    "Using built-in Grep/Glob for code navigation → use `search_code` instead; it's graph-backed.",
    "Reading a whole file to find one function → call `file_read({entity:'<name>'})`.",
    "Asking 'who calls X' by grepping for the name → call `get_references`; grep misses indirect refs.",
    "Calling `file_read` on >5 files in a row → switch to `get_references` / `search_code`; the question is graph-shaped.",
    "Skipping `get_critical_nodes` when planning a hot-path change → chokepoints have ranked impact; check before editing.",
    "Passing `token_budget:2000` for navigation → defeats the budget; navigation is structural, default 400 is enough.",
  ].join("\n"),
  category: "navigation",
  trigger: { type: "agent-requested" },
  tools: [
    "search_code",
    "get_references",
    "get_critical_nodes",
    "get_imports",
    "get_project_stats",
    "file_outline",
    "file_read",
  ],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 4 — Memory (always-on). Four-moment contract + user-fed memory.
// Absorbs prompt-receipt, anchor-query, save-at-end, user-fed-memory,
// session-context-preservation.
// ────────────────────────────────────────────────────────────────────────────

export const MEMORY_SKILL: SkillDefinition = {
  id: "memory",
  name: "Memory (four-moment contract + user-fed capture)",
  description:
    "MANDATORY on every user prompt and at every task close — runs the four-moment contract (recall → anchor query → cite → save) and captures durable user-fed facts (remember / always / from now on / never). STEP-1: Moment 1 recall fires on EVERY prompt, no exceptions. STEP-4: save ONLY what is non-obvious + likely useful next session + anchorable. Do NOT save activity logs or generic facts.",
  whenToUse:
    "On every user prompt (Moment 1 recall is required) and whenever the user says remember, always, from now on, never, don't. Also when a hook emits `ur|act unerr-memory` or you finish a non-trivial task (Moment 4 save).",
  allowedTools: "*",
  instructions: [
    "## Iron Law",
    "",
    "<EXTREMELY-IMPORTANT>",
    "On every coding-task prompt the FIRST tool call is `unerr_recall_notes({prompt:'<verbatim user prompt>'})` (Moment 1). When the user says 'remember', 'always', 'from now on', or 'never', capture it via `unerr_remember` BEFORE replying. At task close, save anchored notes only if they pass all three quality gates (non-obvious + useful next session + anchorable).",
    "</EXTREMELY-IMPORTANT>",
    "",
    "## The four moments",
    "",
    "**Moment 1 — Prompt receipt.**",
    "  First tool call on any coding prompt: `unerr_recall_notes({prompt:'<verbatim prompt>'})`. Empty result is fine; the call is the contract.",
    "",
    "**Moment 2 — Anchor query.**",
    "  Once you've identified the files/entities the task will touch: `unerr_recall_notes({anchors:['f:src/x.ts','e:fooBar']})`. Reads return active notes only; topic-shift and co-change groups ride along.",
    "",
    "**Moment 3 — Cite in plan.**",
    "  When drafting the plan, cite returned notes by `kind + anchor` inline. Example: `Per the wrn on src/proxy/proxy.ts, both stdio and UDS sites must mirror.` No citation = the note was not load-bearing.",
    "",
    "**Moment 4 — Save at task end.**",
    "  At task close, write a note ONLY if all three hold:",
    "    1. Non-obvious — not derivable from the code itself.",
    "    2. Likely useful next session — would change a future approach.",
    "    3. Anchorable — fits a file, entity, glob, or (rarely) project-wide.",
    "  Call: `unerr_remember({type:'note', note:'<DSL wire>', session_id:<sid>})`.",
    "",
    "## DSL vocabulary",
    "",
    "Wire format: `kind|anchor|polarity|content`",
    "",
    "  - kind ∈ {cnv,rul,wrn,dec,blk,fct} — pick the strongest fit.",
    "  - anchor ∈ {f:<path>, e:<entity>, g:<glob>, p:} — `p:` is project-wide, discouraged.",
    "  - polarity ∈ {+,-,~} — `~` for ambiguous.",
    "  - content — single line of prose; may contain `|` (only the first three are field separators).",
    "",
    "Examples:",
    "  - `rul|f:src/proxy/bridge.ts|-|no intelligence imports`",
    "  - `wrn|g:*.test.ts|-|don't mock cozo db`",
    "  - `dec|e:TURN_OPEN_GAP_MS|+|15s avoids RTT misclassification`",
    "",
    "Session save cap: 15. Over the cap, `unerr_remember` returns `outcome:'rate_limited'` with reinforcement candidates — reinforce instead of writing a new row.",
    "",
    "## User-fed memory (capture rule)",
    "",
    "Watch every user turn for fact-bearing statements. Triggering phrases:",
    "  - 'remember (this/that)', 'don't forget', 'keep in mind'",
    "  - 'from now on', 'going forward', 'always', 'never'",
    "  - 'the rule is', 'the convention is', 'we use X for Y'",
    "  - direct assertion of project facts ('X is the canonical Y', 'never edit Z directly')",
    "",
    "When you see one, persist it BEFORE replying:",
    "",
    "  `unerr_remember({source_quote:'<verbatim user sentence>', content:'<normalised, ≤280 chars>', fact_type:'<procedural|semantic|negative|convention>', scope:'<file_path|entity_key|project>', subject:'<entity/topic>', confidence:<0..1>})`",
    "",
    "  - confidence < 0.5  → capture abandoned automatically; ask the user a clarifying question.",
    "  - 0.5 ≤ confidence < 0.7 → stored ambiguous; expect a follow-up.",
    "  - confidence ≥ 0.7 → stored cleanly.",
    "",
    "Use `unerr_remember` (NOT `record_fact`) whenever the source is the user. Use `record_fact` only when you auto-detected a convention from observed code.",
    "",
    "## Session resume",
    "",
    "On the first response of a session, watch for `ur|<tag>` continuity lines on early tool responses:",
    "  - `ur|ctx` — session degraded, consider starting fresh.",
    "  - `ur|ctx` — drift on previously modified files (re-read before editing).",
    "  - `ur|rsk` — prior failures on this entity (read failure modes carefully).",
    "  - `ur|fct` — episodic facts about prior modifications.",
    "",
    "Build on prior work; don't re-explore what was already understood.",
    "",
    "## Red Flags",
    "",
    "Drafting code before `unerr_recall_notes` on Moment 1 → restart the turn at recall.",
    "Treating a recalled note as a soft preference → notes are user-fed rules; they override auto-detected conventions.",
    "Emitting standalone `attribution:` rows inline → the end-of-turn `unerr_turn_summary` receipt now consolidates all attribution into its block; do not echo it inline.",
    "Saving a note that is obvious from the code → fails the quality bar; don't save.",
    "Using `p:` anchor for a fact that fits a file or entity → pollutes prompt-receipt query; use the narrower anchor.",
    "Skipping `unerr_remember` after the user said 'remember' → loses the fact; capture before replying.",
    "Using `record_fact` for a user-fed rule → wrong tool; `unerr_remember` is for user-sourced facts.",
  ].join("\n"),
  category: "behavior",
  trigger: { type: "always" },
  tools: ["unerr_recall_notes", "unerr_remember", "recall_facts"],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 5 — Markers (always-on). mark_intent / mark_decision / mark_blocker /
// mark_resolution discipline + turn-discipline.
// Absorbs timeline-markers, intent-tracking, turn-discipline.
// ────────────────────────────────────────────────────────────────────────────

export const MARKERS_SKILL: SkillDefinition = {
  id: "markers",
  name: "Session Narrative Markers + Turn Discipline",
  description:
    "MANDATORY on every coding turn — emit cheap inline markers (intent, decision, blocker, resolution) as work happens. STEP-1: `mark_intent` is the FIRST tool call after recall. Markers MUST emit at the moment they occur, not bundled into an end-of-turn summary. Do NOT yield mid-tasklist with a status paragraph; the marker IS the status update.",
  whenToUse:
    "On every coding task — implement, fix, refactor, build, debug — to mark intent, decisions, blockers, and resolutions inline. Also when a hook emits `ur|act unerr-markers` or `ur|act mark_intent`.",
  allowedTools: "*",
  instructions: [
    "## Iron Law",
    "",
    "<EXTREMELY-IMPORTANT>",
    "On every coding task (implement/fix/add/refactor/build/debug), the FIRST tool call after `unerr_recall_notes` is `mark_intent({text:'<≤80 char summary>'})`. Markers emit AT the moment they happen, never bundled into an end-of-turn summary. Never yield control mid-tasklist with a user-facing status paragraph — that ends the turn.",
    "</EXTREMELY-IMPORTANT>",
    "",
    "## Phases",
    "",
    "Phase 1 — Open.",
    "  Call `mark_intent({text:'<task summary, ≤80 chars>'})` immediately after `unerr_recall_notes`. One call per task, not per step.",
    "",
    "Phase 2 — Branch.",
    "  When choosing between approaches, call `mark_decision({text:'<choice, ≤140 chars>', alternatives:['<alt1>','<alt2>']})`. Up to 5 alternatives, each ≤80 chars.",
    "",
    "Phase 3 — Block.",
    "  When stuck on an obstacle you cannot resolve in this turn, call `mark_blocker({text:'<problem, ≤140 chars>', file_path:'<path>'})`. Save the returned `marker_id`.",
    "",
    "Phase 4 — Resolve.",
    "  When you fix a prior blocker, call `mark_resolution({blocker_ref:'<exact marker_id from mark_blocker>', text:'<fix description>'})`. Pass the verbatim marker_id, never a paraphrase.",
    "",
    "## Turn discipline",
    "",
    "While working a multi-step TaskList:",
    "  - Do NOT emit user-facing status paragraphs between sub-tasks.",
    "  - Pattern: edit → tool call → edit → tool call. No prose in between.",
    "  - Save the summary for AFTER the last task completes.",
    "  - A turn ends the moment the model emits text without an accompanying tool call. Multi-paragraph 'X done, moving to Y' updates trigger that ending.",
    "",
    "When it IS OK to narrate:",
    "  - The user explicitly asked for a status update.",
    "  - You hit a blocker that needs the user's decision before continuing.",
    "  - You finished the ENTIRE tasklist (not just one sub-task).",
    "",
    "If unsure, do one more tool call instead of writing a paragraph.",
    "",
    "## Why this matters",
    "",
    "Markers are persisted to the shadow ledger and timeline.db. They power turn titles, cross-session intent stitching, the resume strip, and loop/blocker miners. Unresolved blockers carry into the next session — emitting them prevents you from rediscovering the same dead end tomorrow. The timeline still works without these markers, but agents that mark intent + decisions make it dramatically more useful.",
    "",
    "## Red Flags",
    "",
    "Calling `mark_intent` after the third tool call → mark_intent runs FIRST on coding turns; reorder.",
    "Bundling markers into one end-of-turn message → emit each marker at the moment it happens; bundled markers lose timeline ordering.",
    "Calling `mark_intent` twice in one task → intent is once-per-task; switch to `mark_decision` for mid-task pivots.",
    "Passing a paraphrased blocker_ref to `mark_resolution` → resolution requires the exact marker_id returned by `mark_blocker`; without it the resume-strip cannot stitch.",
    "Skipping `mark_blocker` because you plan to fix it later this turn → if it carries past this turn, mark it now.",
    "Writing 'X done, now moving to Y' between TaskList items → ends the turn; the user has to re-prompt. Make another tool call instead.",
  ].join("\n"),
  category: "behavior",
  trigger: { type: "always" },
  tools: ["mark_intent", "mark_decision", "mark_blocker", "mark_resolution"],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 6 — Build + Debug (agent-requested). Two tracks: new-build greenfield
// (Track A) and bug forensics (Track B). Absorbs brainstorming-before-build
// and systematic-debugging.
// ────────────────────────────────────────────────────────────────────────────

export const BUILD_AND_DEBUG_SKILL: SkillDefinition = {
  id: "build-and-debug",
  name: "Build + Debug (new code + bug forensics)",
  description:
    "MANDATORY when building a new feature/component (Track A) or chasing a bug/test failure/regression (Track B). Track A — STEP-1: agree on shape + acceptance criteria BEFORE drafting code. Track B — STEP-1: reproduce. STEP-2: isolate. STEP-3: root-cause. Do NOT patch before STEP-3 completes. Absorbs the prior brainstorming-before-build and systematic-debugging skills.",
  whenToUse:
    "Track A (build) triggers: build, create, add new, design, implement new, scaffold, set up, introduce, new feature/component/page/endpoint. Track B (debug) triggers: bug, broken, failing, crash, error, regression, why is X not working. Also when a hook emits `ur|act unerr-build-and-debug`.",
  allowedTools: "*",
  instructions: [
    "## Two tracks — pick at Phase 0",
    "",
    "**Track A — New Build.** User wants something that does not exist yet.",
    "**Track B — Bug Forensics.** Existing code has a defect.",
    "",
    "If both apply (new feature has a bug), run Track B first to get green, then Track A for the new surface.",
    "",
    "## Track A — New Build",
    "",
    "### Iron Law A",
    "",
    "<EXTREMELY-IMPORTANT>",
    "Never start coding a new feature without first stating the shape (where it lives, what it touches, acceptance criteria) and confirming or correcting it with the user. Building blind ships features that overlap existing modules, regress conventions, or fail the acceptance check.",
    "</EXTREMELY-IMPORTANT>",
    "",
    "### Phases (A)",
    "",
    "Phase A1 — Recall.",
    "  Call `unerr_recall_notes({prompt:'<verbatim user prompt>'})`. Prior decisions, abandoned approaches, and constraints ride along.",
    "",
    "Phase A2 — Survey for overlap.",
    "  Call `search_code` for any existing entity that overlaps the proposed feature. If you find one, ask the user whether to extend or replace it. Do not silently shadow an existing module.",
    "",
    "Phase A3 — Conventions.",
    "  Call `get_conventions({file_path:'<target_path>'})` for the target directory.",
    "",
    "Phase A4 — Shape statement.",
    "  State in 3-5 bullets:",
    "    (a) entry-point module,",
    "    (b) touched modules,",
    "    (c) public interface,",
    "    (d) test surface,",
    "    (e) acceptance criteria.",
    "  Wait for user confirmation or correction.",
    "",
    "Phase A5 — Mark intent.",
    "  After confirmation, `mark_intent({text:'<one-sentence summary, ≤80 chars>'})`.",
    "",
    "Phase A6 — Build.",
    "  Implement the shape from A4. Before each `Edit`, call built-in `Read` (offset/limit).",
    "",
    "Phase A7 — Verify.",
    "  Run the targeted test for the new surface (not the full suite). `mark_resolution` for any blocker.",
    "",
    "Phase A8 — Close out.",
    "  Call `unerr_turn_summary({})` once and include the returned `line` verbatim.",
    "",
    "## Track B — Bug Forensics",
    "",
    "### Iron Law B",
    "",
    "<EXTREMELY-IMPORTANT>",
    "Never patch symptoms. Reproduce the failure first, isolate the failing component, identify the root cause, then fix. Skipping any phase ships a band-aid that re-breaks under a sibling input.",
    "</EXTREMELY-IMPORTANT>",
    "",
    "### Phases (B)",
    "",
    "Phase B1 — Recall.",
    "  Call `unerr_recall_notes({prompt:'<verbatim user prompt>'})`. Prior incidents and decisions tied to the failing entity ride along.",
    "",
    "Phase B2 — Reproduce.",
    "  Pin the exact failing input/command/test. If the user pasted a stack trace, locate the top frame via `search_code`. If a test fails, run the SINGLE test file (not the full suite) to confirm deterministic failure.",
    "",
    "Phase B3 — Mark intent.",
    "  Call `mark_intent({text:'<one-sentence summary, ≤80 chars>'})`.",
    "",
    "Phase B4 — Isolate.",
    "  Call `get_references({key:'<failing_entity>', direction:'callers'})` and `get_references({key:'<failing_entity>', direction:'callees'})`. Walk the dependency tree until the failing edge is identified. Read each suspect via `file_read({purpose:'explore'})`.",
    "",
    "Phase B5 — Root-cause.",
    "  Name the failure mode in one sentence. If you cannot, you have not isolated yet — return to B4.",
    "",
    "Phase B6 — Fix.",
    "  Edit the root-cause site only. Before `Edit`, call built-in `Read` (offset/limit) on the target lines.",
    "",
    "Phase B7 — Verify.",
    "  Run the targeted test that reproduced the failure. Add a regression test if none existed. `mark_resolution` referencing any blocker the bug raised.",
    "",
    "Phase B8 — Close out.",
    "  Call `unerr_turn_summary({})` once and include the returned `line` verbatim.",
    "",
    "## Red Flags",
    "",
    "Track A — drafting code in A1 → the brainstorm never happens; ships overlap.",
    "Track A — skipping A2 survey → builds parallel implementations of an entity that already exists.",
    "Track A — skipping A4 confirmation → user discovers shape mismatch after the diff lands; full rewrite needed.",
    "Track B — editing without B2 (reproduce) → fixes phantom bugs; re-fires.",
    "Track B — patching the caller instead of the root cause → bandaid; the next caller will hit the same fault.",
    "Track B — skipping B4 dependency walk → you fix the wrong layer.",
    "Track B — adding try/catch to swallow the error → hides the failure; doesn't fix it.",
    "Both — running the full test suite as 'verify' → wastes minutes; targeted tests are the contract.",
    "Both — closing without Phase 8 → the user never sees the close-out receipt.",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  tools: [
    "unerr_recall_notes",
    "search_code",
    "get_references",
    "get_conventions",
    "file_read",
    "mark_intent",
    "mark_resolution",
    "unerr_turn_summary",
  ],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 7 — Test + Review (agent-requested). Two tracks: TDD (Track A) and
// receiving code review (Track B). Absorbs test-driven-development and
// receiving-code-review.
// ────────────────────────────────────────────────────────────────────────────

export const TEST_AND_REVIEW_SKILL: SkillDefinition = {
  id: "test-and-review",
  name: "Test + Review (TDD + receiving review)",
  description:
    "MANDATORY when implementing with TDD (Track A) or addressing review comments / PR feedback (Track B). Track A — STEP-1: failing test. STEP-2: minimal implementation to pass. STEP-3: refactor. Track B — STEP-1: classify EVERY review comment as ACCEPT / PUSHBACK / CLARIFY. Do NOT silently drop a comment. Absorbs the prior test-driven-development and receiving-code-review skills.",
  whenToUse:
    "Track A (TDD) triggers: TDD, write tests first, test-driven, red-green-refactor, spec, tests. Track B (review) triggers: review, audit, critique, PR, pull request, address review, fix review comments. Also when a hook emits `ur|act unerr-test-and-review`.",
  allowedTools: "*",
  instructions: [
    "## Two tracks — pick at Phase 0",
    "",
    "**Track A — TDD.** User wants tests to drive the design.",
    "**Track B — Receiving Review.** User pasted review comments / PR feedback.",
    "",
    "## Track A — Test-Driven Development",
    "",
    "### Iron Law A",
    "",
    "<EXTREMELY-IMPORTANT>",
    "Write the failing test BEFORE the implementation. Confirm RED (test fails as expected) before drafting any production code. Skipping RED ships a test that may pass for the wrong reason.",
    "</EXTREMELY-IMPORTANT>",
    "",
    "### Phases (A)",
    "",
    "Phase A1 — Recall.",
    "  Call `unerr_recall_notes({prompt:'<verbatim user prompt>'})`. Prior testing conventions and decisions ride along.",
    "",
    "Phase A2 — Conventions.",
    "  Call `get_conventions({file_path:'<test_file_path>'})`. Match the project's test framework, assertion style, fixture pattern.",
    "",
    "Phase A3 — Mark intent.",
    "  Call `mark_intent({text:'TDD <feature/bug>: red → green → refactor'})`.",
    "",
    "Phase A4 — RED.",
    "  Write the smallest failing test that captures the acceptance criterion. Run the single test file — confirm it fails for the EXPECTED reason (not a typo, not a missing import).",
    "",
    "Phase A5 — GREEN.",
    "  Write the minimal production code that makes the test pass. No speculative features, no extra branches. Built-in `Read` (offset/limit) before each `Edit`.",
    "",
    "Phase A6 — Re-run.",
    "  Run the single test file again. Confirm green.",
    "",
    "Phase A7 — REFACTOR.",
    "  Improve the implementation only if the test still passes after each refactor step. If a refactor breaks the test, revert and try smaller.",
    "",
    "Phase A8 — Coverage check.",
    "  Run `get_test_coverage({entity:'<entity_key>'})` (if available) to confirm the new code is covered.",
    "",
    "Phase A9 — Close out.",
    "  Call `unerr_turn_summary({})` once and include the returned `line` verbatim.",
    "",
    "## Track B — Receiving Code Review",
    "",
    "### Iron Law B",
    "",
    "<EXTREMELY-IMPORTANT>",
    "Every review comment receives one of three responses: ACCEPT (apply the change), PUSHBACK (explain why not, with reasoning), or CLARIFY (ask the reviewer for missing context). Silently dropping a comment is a regression.",
    "</EXTREMELY-IMPORTANT>",
    "",
    "### Phases (B)",
    "",
    "Phase B1 — Recall.",
    "  Call `unerr_recall_notes({prompt:'<verbatim user prompt>'})`. Prior conventions and decisions tied to the reviewed files ride along.",
    "",
    "Phase B2 — Parse comments.",
    "  Enumerate every comment in the input. Number them. Do not skip 'nit:' comments — classify and respond.",
    "",
    "Phase B3 — Classify each.",
    "  For each comment: ACCEPT, PUSHBACK, or CLARIFY. State the classification inline before drafting any response.",
    "",
    "Phase B4 — Mark intent.",
    "  Call `mark_intent({text:'addressing N review comments on <PR>'})`.",
    "",
    "Phase B5 — Apply ACCEPTs.",
    "  For each ACCEPT: locate the entity via `search_code`, run blast-radius check (`get_references` if exported), apply the change. Built-in `Read` (offset/limit) before each `Edit`.",
    "",
    "Phase B6 — Draft PUSHBACKs.",
    "  For each PUSHBACK: cite a project convention (`get_conventions`), a prior decision (`unerr_recall_notes`), or a concrete tradeoff. Hedging ('I think', 'maybe') is not pushback.",
    "",
    "Phase B7 — Ask CLARIFYs.",
    "  For each CLARIFY: surface the specific missing context to the user. Do not assume.",
    "",
    "Phase B8 — Verify.",
    "  Run the targeted test for every changed file. `mark_resolution` for the review.",
    "",
    "Phase B9 — Close out.",
    "  Call `unerr_turn_summary({})` once and include the returned `line` verbatim.",
    "",
    "## Red Flags",
    "",
    "Track A — writing production code in A1 → skips RED; test may be tautological.",
    "Track A — test passes on first run (skipping RED) → test is tautological or import is wrong.",
    "Track A — writing more implementation than the test demands → speculative; deletes YAGNI.",
    "Track A — refactoring while the test is red → loses the safety net; revert, get green, then refactor.",
    "Track A — skipping A8 coverage check → ships untested branches.",
    "Track B — addressing 'most' comments → every comment needs ACCEPT/PUSHBACK/CLARIFY; partial coverage is a regression.",
    "Track B — hedge-pushback ('not sure', 'I think') → cite a convention or a tradeoff; otherwise it's an ACCEPT.",
    "Track B — applying a fix to a hot entity without `get_references` → review comments on exported entities cascade.",
    "Track B — skipping B8 → applied fixes regress unrelated tests.",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  tools: [
    "unerr_recall_notes",
    "search_code",
    "get_references",
    "get_conventions",
    "mark_intent",
    "mark_resolution",
    "get_test_coverage",
    "unerr_turn_summary",
  ],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Export — the 7 consolidated skills.
// ────────────────────────────────────────────────────────────────────────────

export const LOCAL_SKILLS: SkillDefinition[] = [
  USING_UNERR_SKILL,
  SAFE_MODIFICATION_SKILL,
  EXPLORATION_SKILL,
  MEMORY_SKILL,
  MARKERS_SKILL,
  BUILD_AND_DEBUG_SKILL,
  TEST_AND_REVIEW_SKILL,
];

/**
 * Get always-on skills formatted for session context injection.
 * Only injects skills with trigger.type === "always" to respect token budget.
 */
export function getSkillsContext(): Record<string, unknown> {
  const alwaysOn = LOCAL_SKILLS.filter((s) => s.trigger.type === "always");
  return {
    "dev.unerr/active_skills": alwaysOn.map((s) => ({
      id: s.id,
      name: s.name,
      instructions: s.instructions,
    })),
    "dev.unerr/available_skills": LOCAL_SKILLS.filter(
      (s) => s.trigger.type !== "always"
    ).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      trigger: s.trigger.type,
    })),
  };
}

/**
 * Get a specific skill by ID.
 */
export function getSkill(id: string): SkillDefinition | null {
  return LOCAL_SKILLS.find((s) => s.id === id) ?? null;
}

/**
 * Bundled skills in the schema-compatible format (name, description, content).
 * Used by the skill resolver for Tier 1 skill delivery.
 */
export const BUNDLED_SKILLS: Array<{
  name: string;
  description: string;
  content: string;
  version?: string;
  whenToUse?: string;
  allowedTools?: string;
}> = LOCAL_SKILLS.map((s) => ({
  name: s.id,
  description: s.description,
  content: s.instructions,
  version: s.version,
  whenToUse: s.whenToUse,
  allowedTools: s.allowedTools,
}));

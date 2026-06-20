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
 *   - unerr-markers            — intent / decision / blocker / resolution via the
 *                                `unerr-save:` closing-message sentinel (zero round-trip;
 *                                absorbs timeline-markers, intent-tracking, turn-discipline)
 *   - unerr-build-and-debug    — new-code + bug-forensics lifecycles (absorbs
 *                                brainstorming-before-build, systematic-debugging)
 *   - unerr-test-and-review    — TDD + receiving-code-review (absorbs
 *                                test-driven-development, receiving-code-review)
 *
 * Each skill body follows the Superpowers Iron Law / Phases / Red Flags shape.
 * `whenToUse` and `allowedTools` are emitted as Claude Code SKILL.md frontmatter
 * by src/skills/resolver.ts:formatClaudeCodeSkill.
 *
 * Skill instruction bodies are the single source in `src/content/skills.json`
 * (ids `skill:<id>`); `loadContent` returns the raw text, or the
 * LLMLingua-compressed variant when `UNERR_LLMLINGUA` is on (Lever B, §11.3).
 */

import { loadContent } from "../content/loader.js";

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
  instructions: loadContent("skill:using-unerr"),
  category: "workflow",
  trigger: { type: "always" },
  tools: [
    "unerr_context",
    "search_code",
    "get_references",
    "file_read",
    "unerr_track",
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
  instructions: loadContent("skill:safe-modification"),
  category: "workflow",
  trigger: { type: "always" },
  tools: ["unerr_context", "file_read", "search_code", "get_references"],
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
  instructions: loadContent("skill:exploration"),
  category: "navigation",
  trigger: { type: "agent-requested" },
  tools: ["search_code", "get_references", "file_outline", "file_read"],
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
  instructions: loadContent("skill:memory"),
  category: "behavior",
  trigger: { type: "always" },
  tools: ["unerr_context", "unerr_track"],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 5 — Markers (always-on). intent / decision / blocker / resolution
// ride a closing-message `unerr-save:` sentinel scraped by the Stop hook —
// zero MCP round-trip. + turn-discipline.
// Absorbs timeline-markers, intent-tracking, turn-discipline.
// ────────────────────────────────────────────────────────────────────────────

export const MARKERS_SKILL: SkillDefinition = {
  id: "markers",
  name: "Session Narrative Markers + Turn Discipline",
  description:
    "On every coding turn, record intent/decision/blocker/resolution with ZERO round-trip — emit `unerr-save:` lines in your closing message and the Stop hook persists them. No tool call, only output tokens. Do NOT yield mid-tasklist with a status paragraph; finish the work, then emit the markers at close.",
  whenToUse:
    "On every coding task — implement, fix, refactor, build, debug — to record intent, decisions, blockers, and resolutions for the cross-session resume strip. Also when a hook emits `ur|act unerr-markers`.",
  allowedTools: "*",
  instructions: loadContent("skill:markers"),
  category: "behavior",
  trigger: { type: "always" },
  tools: ["unerr_track"],
  version: "2.0.0",
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
  instructions: loadContent("skill:build-and-debug"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  tools: [
    "unerr_context",
    "search_code",
    "get_references",
    "file_read",
    "unerr_track",
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
  instructions: loadContent("skill:test-and-review"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  tools: [
    "unerr_context",
    "search_code",
    "get_references",
    "file_read",
    "unerr_track",
  ],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 8 — Review (agent-as-reviewer). PRODUCES a review of a diff / change
// set by driving unerr's graph tools as the evidence layer, then judging.
// Distinct from test-and-review Track B, which ADDRESSES review comments.
// ────────────────────────────────────────────────────────────────────────────

export const REVIEW_SKILL: SkillDefinition = {
  id: "review",
  name: "Review changes (agent-as-reviewer)",
  description:
    "MANDATORY when asked to review / audit your own changes or a diff before commit. " +
    "PRODUCES an evidenced review: gather graph facts per changed entity, THEN judge. " +
    "Distinct from test-and-review (that ADDRESSES review comments; this PRODUCES the review). " +
    "Catches what build + lint pass but is still wrong: breaking callers, silent contract drift, " +
    "duplicate logic, boundary breaches, intent mismatch, hallucinated APIs.",
  whenToUse:
    "review my changes, review the diff, audit this, review before commit, what did I break, " +
    "is this safe to commit, check my work, self-review, pre-commit review. " +
    "Also when a hook emits `ur|act unerr-review`. " +
    "NOT for addressing review comments someone left you — that is unerr-test-and-review Track B.",
  allowedTools: "*",
  instructions: loadContent("skill:review"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  tools: [
    "unerr_context",
    "search_code",
    "get_references",
    "file_read",
    "unerr_track",
  ],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 9 — Delegate (agent-requested). Routes a delegable task (tests / docs /
// mechanical refactor / lint) to a cheaper model in the SAME host, then reviews
// the diff. Lever C (TOKEN_ECONOMICS §11.2). Only fires when the host supports
// delegation (claude-code / codex) AND the `UNERR_DELEGATION` flag is on; on any
// other host or with the flag off it is a no-op and the normal skill runs.
// ────────────────────────────────────────────────────────────────────────────

export const DELEGATE_SKILL: SkillDefinition = {
  id: "delegate",
  name: "Delegate (cheaper-model handoff)",
  description:
    "Use when the task is a delegable class — add/improve tests, docstring + @sem maintenance, mechanical refactor (rename/extract/inline/move), or lint/format fixup — AND the host supports delegation (Claude Code / Codex) AND UNERR_DELEGATION is on. Builds a recon brief, hands the edit to a cheaper model (the unerr-junior sub-agent / `codex exec -m <mini>`), then reviews the diff. The senior NEVER enumerates the edit sites — the graph does. If the host can't delegate or the flag is off, skip this skill and run the normal lifecycle skill.",
  whenToUse:
    "A delegable task on a delegation-capable host with the flag on: add tests, write a unit/integration test, improve test coverage, add/update a docstring or @sem comment, rename/extract/inline/move a symbol, fix lint/format. Also when a hook emits `ur|act unerr-delegate`. Not for design, new features, or bug root-causing — those stay with the senior.",
  allowedTools: "*",
  instructions: loadContent("skill:delegate"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  tools: ["unerr_context", "search_code", "get_references", "file_read"],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Export — the 9 consolidated skills.
// ────────────────────────────────────────────────────────────────────────────

export const LOCAL_SKILLS: SkillDefinition[] = [
  USING_UNERR_SKILL,
  SAFE_MODIFICATION_SKILL,
  EXPLORATION_SKILL,
  MEMORY_SKILL,
  MARKERS_SKILL,
  BUILD_AND_DEBUG_SKILL,
  TEST_AND_REVIEW_SKILL,
  REVIEW_SKILL,
  DELEGATE_SKILL,
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

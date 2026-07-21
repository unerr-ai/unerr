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
 * (ids `skill:<id>`); `loadContent` returns the raw text.
 */

import { loadContent } from "../content/loader.js";
import { CODEX_JUNIOR_MODEL, CODEX_WORKER_MODEL } from "./junior-agent.js";

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
  /**
   * When true this is an OPT-IN skill: NOT installed by default and NOT
   * self-advertised. A user installs it explicitly with `unerr skill install
   * <id>`; the opt-in set is persisted per-repo (src/skills/skill-opt-in.ts) and
   * folded into the install + self-heal expected set. The rigid lifecycle skills
   * (exploration / build-and-debug / test-and-review / review / delegate) are
   * opt-in — they prescribe a multi-step workflow that suits a guarded
   * development setup, not the default loose tool-pushing posture.
   */
  optIn?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Skill 1 — Orchestrator (the ONE always-on skill). A thin dispatch table to the
// five on-demand workflow skills + the default edit workflow (recall →
// blast-radius → conventions → drift → edit, folded in from the former
// safe-modification skill). The verbose Surface 2/3/4 telemetry + token rules
// moved to the instruction file to avoid always-on duplication (2026-06).
// ────────────────────────────────────────────────────────────────────────────

export const USING_UNERR_SKILL: SkillDefinition = {
  id: "using-unerr",
  name: "Using unerr (orchestrator)",
  description:
    "Always on. For anything that reads, searches, or edits code, reach for unerr's graph tools first (search_code / get_references / file_read / file_edit), and delegate the work to unerr sub-agents by default — the main thread plans, routes, and consolidates while sub-agents run the slices in parallel (one per independent slice, no fixed cap). Guidance toward the tools and capabilities, not a workflow — there are no fixed steps to run.",
  whenToUse:
    "Any code action — read, search, edit, find callers/references, or fan the delegable slices out to sub-agents (the default execution mode, not an occasional offload). Reach for unerr's tools first; this skill points at the tools, it does not prescribe a procedure.",
  allowedTools: "*",
  instructions: loadContent("skill:using-unerr"),
  category: "workflow",
  trigger: { type: "always" },
  tools: ["search_code", "get_references", "file_read", "unerr_track"],
  version: "2.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// The edit-existing lifecycle (recall → blast-radius → conventions → drift →
// edit) is no longer a separate always-on skill: usage data (2026-06) showed it
// invoked ~6× in 174 sessions while costing ~6 KB always-on. Its discipline is
// folded into USING_UNERR_SKILL's Default edit workflow; `fix`/`refactor` verbs
// route to `unerr-using-unerr` (see VERB_CLUSTERS in src/hooks/prompt-hooks.ts).
// ────────────────────────────────────────────────────────────────────────────

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
  optIn: true,
  tools: ["search_code", "get_references", "file_outline", "file_read"],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Memory (four-moment contract) and Markers (unerr-save: sentinels) are no
// longer skills: usage data (2026-06) showed BOTH invoked 0× via Skill() across
// 174 sessions — their function runs through the UserPromptSubmit/Stop hooks and
// the instruction file's contract block, never a Skill() call. Removing them
// drops ~8 KB of always-on weight. The `remember/always` verb cluster is dropped
// from VERB_CLUSTERS (capture is automatic); markers ride the closing-message
// sentinel taught in USING_UNERR_SKILL + the instruction file.
// ────────────────────────────────────────────────────────────────────────────

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
  optIn: true,
  tools: ["search_code", "get_references", "file_read", "unerr_track"],
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
  optIn: true,
  tools: ["search_code", "get_references", "file_read", "unerr_track"],
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
  optIn: true,
  tools: ["search_code", "get_references", "file_read", "unerr_track"],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Skill 9 — Delegate (agent-requested). Routes a delegable task (tests / docs /
// mechanical refactor / lint) to a cheaper model in the SAME host, then reviews
// the diff. Only fires when the host supports delegation (claude-code / codex);
// on any other host it is a no-op and the normal skill runs.
// ────────────────────────────────────────────────────────────────────────────

export const DELEGATE_SKILL: SkillDefinition = {
  id: "delegate",
  name: "Delegate (cheaper-model handoff)",
  description: `Use when the task is a delegable class — add/improve tests, docstring + @sem maintenance, mechanical refactor (rename/extract/inline/move), lint/format fixup, read-only recon (find out / trace / investigate X), caller/import propagation (update every call site + import after a signature change), typecheck/build-error fixes (fix tsc/build errors mechanically, re-run until green), scaffold (generate a new file's skeleton from a sibling template), verify-runs (run typecheck + targeted tests + lint, return the failure list — no edits), or shell-command runs (run a sequence of build/script/migration/setup commands, report the output) — AND the host supports delegation (Claude Code / Codex / Cursor / GitHub Copilot CLI). Builds a recon brief, PARTITIONS it into disjoint groups, and spawns one cheaper-model worker per group in parallel, routed by difficulty: tests/mechanical_refactor/caller_propagation/typecheck_fix/scaffold → WORKER model (Claude \`unerr-worker\` sub-agent / \`codex exec -m ${CODEX_WORKER_MODEL}\`), lint/docs/recon/verify/shell-command → JUNIOR model (Claude \`unerr-junior\` sub-agent / \`codex exec -m ${CODEX_JUNIOR_MODEL}\`). Then reviews each diff. The senior NEVER enumerates the edit sites — the graph does. If the host can't delegate, skip this skill and run the normal lifecycle skill.`,
  whenToUse:
    "A delegable task on a delegation-capable host: add tests, write a unit/integration test, improve test coverage, add/update a docstring or @sem comment, rename/extract/inline/move a symbol, fix lint/format, propagate call-site + import changes after a signature edit, fix tsc/build errors, scaffold a new file from a sibling template, run typecheck + tests + lint and return failures (no edits), run a sequence of build/script/migration/setup commands, or a read-only investigation (find out / trace / investigate X). Also when a hook emits `ur|act unerr-delegate`. Not for design, new features, or bug root-causing — those stay with the senior.",
  allowedTools: "*",
  instructions: loadContent("skill:delegate"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  optIn: true,
  tools: ["search_code", "get_references", "file_read"],
  version: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Export — the 6 skills (2026-06 consolidation, usage-driven). ONE always-on
// orchestrator (using-unerr — dispatch table + default edit workflow) + five
// on-demand workflow skills. memory + markers + safe-modification were removed:
// their function lives in the hooks + the instruction file, and Skill()-usage
// data showed them invoked 0–6× across 174 sessions for ~19 KB of always-on cost.
// ────────────────────────────────────────────────────────────────────────────

export const LOCAL_SKILLS: SkillDefinition[] = [
  USING_UNERR_SKILL,
  EXPLORATION_SKILL,
  BUILD_AND_DEBUG_SKILL,
  TEST_AND_REVIEW_SKILL,
  REVIEW_SKILL,
  DELEGATE_SKILL,
];

/**
 * Skills installed by DEFAULT — the loose, always-on tool-pushing skill only.
 * Everything else is opt-in (see OPT_IN_SKILLS).
 */
export const DEFAULT_SKILLS: SkillDefinition[] = LOCAL_SKILLS.filter(
  (s) => !s.optIn
);

/**
 * OPT-IN skills — the rigid lifecycle workflows. NOT installed by default; a user
 * adds them per-repo with `unerr skill install <id>` (persisted in
 * src/skills/skill-opt-in.ts). They suit a guarded development setup that wants a
 * prescribed multi-step procedure, not the default loose posture.
 */
export const OPT_IN_SKILLS: SkillDefinition[] = LOCAL_SKILLS.filter(
  (s) => s.optIn
);

/** Bare ids (no `unerr-` prefix) of the opt-in skills, for command validation. */
export const OPT_IN_SKILL_IDS: string[] = OPT_IN_SKILLS.map((s) => s.id);

/** True when `id` (with or without the `unerr-` prefix) names an opt-in skill. */
export function isOptInSkill(id: string): boolean {
  const bare = id.replace(/^unerr-/, "");
  return OPT_IN_SKILLS.some((s) => s.id === bare);
}

/**
 * Always-on + available skills for first-call session-context injection
 * (query-router injects this once per session). Only `trigger:'always'` skills
 * inject their full body — post-2026-06 that is just the orchestrator; the five
 * on-demand skills inject name+description only (progressive disclosure).
 */
export function getSkillsContext(): Record<string, unknown> {
  const alwaysOn = DEFAULT_SKILLS.filter((s) => s.trigger.type === "always");
  return {
    "dev.unerr/active_skills": alwaysOn.map((s) => ({
      id: s.id,
      name: s.name,
      instructions: s.instructions,
    })),
    // Opt-in skills are deliberately NOT advertised here: self-advertising made
    // the agent auto-invoke their rigid workflows (extra tool calls). Once a user
    // opts in with `unerr skill install <id>`, the host picks the skill up from
    // its installed SKILL.md frontmatter — no MCP-injected catalog needed.
    "dev.unerr/available_skills": [],
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

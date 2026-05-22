/**
 * Local Skills Pack — bundled behavior skills injected on proxy boot.
 *
 * Q.11: "token-efficient" — constrain agent verbosity (~65% output reduction)
 * Q.12: "graph-first navigation" — instruct agent to use blast_radius/find_callers before file reads
 *
 * Skills are injected as system-level instructions via the proxy's tool descriptions
 * or as inline `ur|<tag>` prefix lines on the first tool call of a session.
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
}

export const TOKEN_EFFICIENT_SKILL: SkillDefinition = {
  id: "token-efficient",
  name: "Token-Efficient Output",
  description:
    "Constrains agent verbosity for 65% output reduction without losing critical information",
  instructions: [
    "When responding, prefer structured summaries over verbose explanations.",
    "Use bullet points and code snippets instead of paragraph descriptions.",
    "Skip introductory phrases like 'Here is...', 'I will...', 'Let me...'.",
    "For code changes: show only the diff, not surrounding unchanged code.",
    "For explanations: lead with the answer, then provide supporting details only if asked.",
    "Never repeat information that was already provided in the conversation.",
    "Prefer references to file paths over re-stating file contents.",
    "For file edits: use unified diff format (---/+++ headers, @@ hunks), never regenerate full files.",
    "When a tool response begins with `ur|ctx` (context already delivered for this entity), do not re-query or restate — proceed directly to the action.",
  ].join("\n"),
  category: "behavior",
  trigger: { type: "always" },
  tools: [],
  version: "1.1.0",
};

export const GRAPH_FIRST_NAVIGATION_SKILL: SkillDefinition = {
  id: "graph-first-navigation",
  name: "Graph-First Navigation",
  description:
    "Use graph intelligence tools before reading files to minimize exploration tokens",
  instructions: [
    "Before reading any file to understand code structure, use graph tools:",
    "  - `get_references` — find all callers/callees of a function (replaces grep+read loops)",
    "  - `get_references` with direction:callees — understand downstream dependencies",
    "  - `get_file` — get all entities, imports, exports for a file",
    "  - `get_imports` — trace the import/dependency graph",
    "  - `search_code` — find entities by name (replaces file-by-file exploration)",
    "  - `get_critical_nodes` — identify high-impact chokepoints before modifying",
    "One graph query replaces 5-15 file reads. Only read files for exact implementation details.",
  ].join("\n"),
  category: "navigation",
  trigger: { type: "always" },
  tools: [
    "get_references",
    "get_file",
    "get_imports",
    "search_code",
    "get_critical_nodes",
  ],
  version: "1.1.0",
};

export const UNDERSTAND_BEFORE_MODIFY_SKILL: SkillDefinition = {
  id: "understand-before-modify",
  name: "Understand Before Modify",
  description:
    "Read graph context before modifying any existing code to prevent confident hallucination",
  instructions: [
    "Before modifying any existing code:",
    "",
    "0. Check the response for `ur|fct` prefix lines (surfaced episodic/procedural facts about this entity)",
    "   - If present: understand the intent behind prior changes before planning yours",
    "   - Also watch for `ur|hst` (prior failures) and `ur|wrn` (negative facts / anti-patterns)",
    "",
    "1. Read the target function/class (not the whole file)",
    "2. Call `get_entity` to get graph context:",
    "   - Who calls this? (blast radius)",
    "   - What conventions apply?",
    "   - What is its health/risk level?",
    "3. If risk is HIGH or callers > 5:",
    "   - Explain the risk to the user before proceeding",
    "   - Suggest a conservative approach",
    "",
    "Never modify code you haven't understood through the graph first.",
    "The graph knows what you don't — callers, conventions, risk.",
  ].join("\n"),
  category: "quality",
  trigger: { type: "always" },
  tools: ["get_entity", "get_references"],
  version: "1.1.0",
};

export const BLAST_RADIUS_FIRST_SKILL: SkillDefinition = {
  id: "blast-radius-first",
  name: "Blast Radius First",
  description:
    "Check blast radius before modifying any function, class, or exported entity",
  instructions: [
    "Before modifying any function, class, or exported entity:",
    "",
    "1. Call `get_references` on the target entity",
    "2. If callers > 5, call `get_entity` for full context",
    "3. Watch for a `ur|rsk` prefix line in the response (e.g. `ur|rsk fan_in=24 fan_out=3`) — if present:",
    "   - List all affected callers to the user before proceeding",
    "   - Consider whether a non-breaking change is possible",
    "   - If breaking, enumerate what else needs updating",
    "4. Only then proceed with the modification",
    "",
    "Never modify a high-fan-in entity without understanding its blast radius first.",
  ].join("\n"),
  category: "navigation",
  trigger: {
    type: "auto",
    globs: ["**/*.ts", "**/*.js", "**/*.py", "**/*.go"],
  },
  tools: ["get_references", "get_entity"],
  version: "1.0.0",
};

export const CONVENTION_AWARE_GENERATION_SKILL: SkillDefinition = {
  id: "convention-aware-generation",
  name: "Convention-Aware Generation",
  description:
    "Follow project conventions when creating new files or functions",
  instructions: [
    "Before writing new code in this project:",
    "",
    "1. Call `get_conventions` with the target file path",
    "2. Follow the conventions returned:",
    "   - Naming: match the project's function/variable naming style",
    "   - Imports: follow the project's import ordering and path conventions",
    "   - Structure: match the project's file organization patterns",
    "",
    "Generate code that fits the project's existing style. Don't impose external conventions.",
  ].join("\n"),
  category: "quality",
  trigger: {
    type: "auto",
    globs: ["**/*.ts", "**/*.js", "**/*.py", "**/*.go"],
  },
  tools: ["get_conventions"],
  version: "1.0.0",
};

export const DEPENDENCY_AWARE_REFACTOR_SKILL: SkillDefinition = {
  id: "dependency-aware-refactor",
  name: "Dependency-Aware Refactor",
  description:
    "Trace dependency chains before moving, renaming, or restructuring code",
  instructions: [
    "When refactoring code across files:",
    "",
    "1. Call `get_file` on each file being modified to understand its entity graph",
    "2. Call `get_imports` to trace dependency chains — never move code without knowing what depends on it",
    "3. Call `get_cross_boundary_links` to find unexpected cross-module dependencies",
    "4. For each entity being moved/renamed:",
    "   - Call `get_references` to find all references that need updating",
    "   - Update all callers before or immediately after the rename",
    "5. After refactoring, verify: call `get_references` on the new location to confirm references updated",
    "",
    "Do not refactor in isolation. The graph knows every reference — use it.",
  ].join("\n"),
  category: "navigation",
  trigger: { type: "agent-requested" },
  tools: [
    "get_file",
    "get_imports",
    "get_references",
    "get_cross_boundary_links",
  ],
  version: "1.0.0",
};

export const SAFE_MODIFICATION_WORKFLOW_SKILL: SkillDefinition = {
  id: "safe-modification-workflow",
  name: "Safe Modification Workflow",
  description:
    "4-phase workflow for non-trivial code changes: understand, plan, execute, verify",
  instructions: [
    "For any non-trivial code modification, follow this sequence:",
    "",
    "Phase 0 — History:",
    "  - Watch for `ur|fct` prefix lines in tool responses — these surface episodic/procedural facts about the target file/entity",
    "  - Also note `ur|hst` (prior failures) and `ur|dft` (drift since last seen) signals",
    "  - Understand why prior modifications were made",
    "  - Ensure your change doesn't conflict with prior intent",
    "",
    "Phase 1 — Understand:",
    "  - `get_entity` on the target",
    "  - `get_references` to know blast radius",
    "  - `get_conventions` to know the local style",
    "",
    "Phase 2 — Plan:",
    "  - If blast radius is HIGH (>5 callers), describe the change plan to the user",
    "  - If conventions would be violated, flag before writing",
    "",
    "Phase 3 — Execute:",
    "  - Make the change",
    "  - Update all callers if signatures changed",
    "",
    "Phase 4 — Verify:",
    "  - `get_conventions` — confirm no convention violations introduced",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  tools: ["get_entity", "get_references", "get_conventions"],
  version: "1.0.0",
};

export const ARCHITECTURE_EXPLORATION_SKILL: SkillDefinition = {
  id: "architecture-exploration",
  name: "Architecture Exploration",
  description:
    "Explore unfamiliar codebase areas using graph tools instead of file-by-file reading",
  instructions: [
    "When exploring an unfamiliar area of the codebase:",
    "",
    "1. Start broad: `get_project_stats` for overall structure",
    "2. Narrow: `get_file` on the entry point file",
    "3. Follow connections: `get_references` with direction:callees from the main function to trace the execution path",
    "4. Find chokepoints: `get_critical_nodes` to identify the most impactful code",
    "5. Search by intent: `search_code` to find entities by name or concept",
    "",
    "Build understanding from the graph outward, not from files inward.",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "agent-requested" },
  tools: [
    "get_project_stats",
    "get_file",
    "get_references",
    "get_critical_nodes",
    "search_code",
  ],
  version: "1.0.0",
};

export const FILE_READ_PROTOCOL_SKILL: SkillDefinition = {
  id: "file-read-protocol",
  name: "File Read Protocol (Layer 6)",
  description:
    "Use structural outlines and targeted reads instead of dumping entire files into context",
  instructions: [
    "When reading files, prefer targeted reads over full dumps:",
    '• `file_read` with `entity: "FunctionName"` — returns just that entity ±5 lines context.',
    "• `file_read` with `offset` + `limit` — returns a specific line window.",
    "• `file_outline` — returns structure (entities, imports, exports) without content.",
    "",
    "Smart behaviors (automatic):",
    "• Files >200 lines auto-return an outline unless you pass entity/offset/force_full.",
    "• Entity matching is fuzzy — camelCase segments, prefix, and case-insensitive all work.",
    "• If entity not found, response includes top-5 suggestions to pick from.",
    "• Pass `token_budget` to control response size (default 2000 tokens).",
    "• Log files auto-tail to last 200 lines.",
    "",
    'One-call pattern: `file_read(file_path, entity: "name")` works on first attempt',
    "even without calling file_outline first. No need for a two-step flow.",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "always" },
  tools: ["file_outline", "file_read"],
  version: "2.0.0",
};

export const SESSION_CONTEXT_PRESERVATION_SKILL: SkillDefinition = {
  id: "session-context-preservation",
  name: "Session Context Preservation",
  description:
    "Use prior session context on resume to avoid re-exploring what was already understood",
  instructions: [
    "At the start of each session:",
    "",
    "1. Watch for unerr session continuity signals as `ur|<tag>` prefix lines on early tool responses:",
    "   - `ur|hth` — session degraded, consider starting fresh",
    "   - `ur|dft` — drift on previously modified files (re-read before editing)",
    "   - `ur|hst` — prior failures on this entity (read failure modes carefully)",
    "2. If previous session data is available:",
    "   - Review what was changed last session",
    "   - Note any incomplete work flagged",
    "   - Check for drift alerts on previously modified files",
    "3. Build on prior work — don't re-explore what was already understood",
    "4. Watch for `ur|fct` prefix lines (episodic facts about prior modifications to files you're working on)",
    "5. If episodic facts surface, understand the 'why' behind prior changes before making new ones",
    "",
    "unerr tracks cross-session state. Use it to avoid starting from zero.",
  ].join("\n"),
  category: "behavior",
  trigger: { type: "auto" },
  tools: [],
  version: "1.0.0",
};

export const TIMELINE_MARKERS_SKILL: SkillDefinition = {
  id: "timeline-markers",
  name: "Session Narrative Markers",
  description:
    "Emit cheap inline markers (intent, decision, blocker, resolution) as you work — never as an end-of-turn summary",
  instructions: [
    "Emit session-narrative markers inline as you work. Each marker is one short string.",
    "Never bundle markers into an end-of-turn summary; emit them when the moment happens.",
    "",
    "When starting a non-trivial task:",
    "  - Call `mark_intent({text: '...'})` with one short sentence describing the task (≤80 chars).",
    "  - Call this ONCE at the start, not repeatedly.",
    "",
    "When choosing between approaches:",
    "  - Call `mark_decision({text: '...', alternatives: [...]})` with the chosen path (≤140 chars).",
    "  - List up to 5 alternatives that were considered (each ≤80 chars).",
    "",
    "When stuck on something you cannot resolve in this turn:",
    "  - Call `mark_blocker({text: '...', file_path: '...'})` (text ≤140 chars).",
    "  - Save the returned `marker_id` — you (or the next session) will pass it to mark_resolution.",
    "",
    "When you resolve a previously marked blocker:",
    "  - Call `mark_resolution({blocker_ref: <prior marker_id>, text: '...'})` describing the fix.",
    "  - Pass the EXACT marker_id returned by mark_blocker, not a free-form reference.",
    "",
    "Why this matters:",
    "  - Markers are persisted to the shadow ledger and timeline.db.",
    "  - They power turn titles, cross-session intent stitching, the resume strip, and loop/blocker miners.",
    "  - Unresolved blockers carry into the next session — emitting them prevents you from rediscovering the same dead end tomorrow.",
    "  - The timeline still works without these markers, but agents that mark intent + decisions make it dramatically more useful.",
  ].join("\n"),
  category: "behavior",
  trigger: { type: "auto" },
  tools: ["mark_intent", "mark_decision", "mark_blocker", "mark_resolution"],
  version: "1.0.0",
};

export const TURN_DISCIPLINE_SKILL: SkillDefinition = {
  id: "turn-discipline",
  name: "Don't Yield Mid-Tasklist",
  description:
    "When working a multi-step plan, do not produce mid-task status summaries — they end the turn and hand control back to the user.",
  instructions: [
    "When you are working through a TaskList with multiple pending items:",
    "  - Do NOT emit user-facing status paragraphs between sub-tasks.",
    "  - Pattern: edit → tool call → edit → tool call. No prose in between.",
    "  - Save the summary for AFTER the last task completes.",
    "",
    "Why this matters:",
    "  - A turn ends the moment the model emits text without an accompanying tool call.",
    "  - Multi-paragraph 'X done, moving to Y' updates trigger that ending.",
    "  - The user then has to re-prompt to continue — wasting their attention and turn budget.",
    "",
    "When it IS OK to narrate:",
    "  - The user explicitly asked for a status update.",
    "  - You hit a blocker that needs the user's decision before continuing.",
    "  - You finished the ENTIRE tasklist (not just one sub-task).",
    "",
    "If unsure, do one more tool call instead of writing a paragraph.",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "always" },
  tools: [],
  version: "1.0.0",
};

export const USER_FED_MEMORY_SKILL: SkillDefinition = {
  id: "user-fed-memory",
  name: "User-Fed Memory",
  description:
    "Detect user statements that should persist across sessions and call unerr_remember instead of letting them evaporate",
  instructions: [
    "Watch every user turn for fact-bearing statements. When you see ANY of these patterns, the user is teaching you a durable rule — persist it via `unerr_remember`:",
    "",
    "Triggering phrases:",
    "  - \"remember (this/that)\", \"don't forget\", \"keep in mind\"",
    "  - \"from now on\", \"going forward\", \"always\", \"never\"",
    "  - \"the rule is\", \"the convention is\", \"we use X for Y\"",
    "  - direct assertion of project facts (\"X is the canonical Y\", \"never edit Z directly\")",
    "",
    "How to call `unerr_remember`:",
    "  1. `content` — your normalised, terse statement of the rule (≤ 280 chars). Strip filler.",
    "  2. `source_quote` — the user's verbatim sentence (REQUIRED — this is the provenance the dashboard surfaces).",
    "  3. `fact_type` — pick one: procedural (how-to), semantic (architecture), negative (anti-pattern), convention (standard).",
    "  4. `scope` — file path, entity key, or the literal string `project`.",
    "  5. `subject` — the entity, file, or topic name the fact is about.",
    "  6. `confidence` — your honest [0,1] read of how sure you are you captured intent correctly.",
    "     - <0.5  → capture is abandoned automatically; ask the user a clarifying question.",
    "     - 0.5–<0.7 → stored but flagged ambiguous; expect a follow-up confirmation in the next turn.",
    "     - ≥0.7  → stored cleanly.",
    "  7. `applies_to` (optional) — paths/entities this fact governs.",
    "",
    "DO use `unerr_remember` (not `record_fact`) whenever the source is the user.",
    "DO call it inline as soon as you see the trigger — do NOT batch into an end-of-turn summary.",
    "DO NOT silently move on after the user said \"remember\" — that loses the fact.",
    "DO NOT use `unerr_remember` for facts you auto-detected from observed code; use `record_fact` for those.",
  ].join("\n"),
  category: "quality",
  trigger: { type: "always" },
  tools: ["unerr_remember", "recall_facts"],
  version: "1.0.0",
};

// ── Active-cognition four-moment contract (Sprint D item 10) ──
// Three bundled skills derived from src/intelligence/contract-teaching.ts.

export const UNERR_PROMPT_RECEIPT_SKILL: SkillDefinition = {
  id: "unerr-prompt-receipt",
  name: "Active-Cognition: Prompt-Receipt Recall",
  description:
    "First action on every user prompt — call unerr_recall_notes with the verbatim prompt",
  instructions: [
    "When a user prompt arrives, your FIRST tool call is:",
    "",
    "  unerr_recall_notes({prompt: '<verbatim prompt text>'})",
    "",
    "Empty result is fine. The call is the contract — it loads anchored notes for likely targets and a topic-shift flag.",
    "Skip this only if the prompt is trivially small-talk ('thanks', 'ok').",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "always" },
  tools: ["unerr_recall_notes"],
  version: "1.0.0",
};

export const UNERR_ANCHOR_QUERY_SKILL: SkillDefinition = {
  id: "unerr-anchor-query",
  name: "Active-Cognition: Anchor Query Before Edit",
  description:
    "After identifying files/entities the task will touch, pull their anchored notes",
  instructions: [
    "Once you've identified the files / entities the task will touch, pull their anchored notes:",
    "",
    "  unerr_recall_notes({anchors: ['f:src/x.ts', 'e:fooBar']})",
    "",
    "Use wire-format anchors (f:<path>, e:<entity>, g:<glob>, p:). Returned notes are active only; superseded rows are excluded.",
    "Cite returned notes by note_id in your plan so the reader can see what was load-bearing.",
  ].join("\n"),
  category: "navigation",
  trigger: { type: "always" },
  tools: ["unerr_recall_notes"],
  version: "1.0.0",
};

export const UNERR_SAVE_AT_END_SKILL: SkillDefinition = {
  id: "unerr-save-at-end",
  name: "Active-Cognition: Save At Task End",
  description:
    "At the close of every non-trivial task, write a note only if all three quality gates hold",
  instructions: [
    "At the close of every non-trivial task, write a note ONLY if all three hold:",
    "",
    "1. Non-obvious — not derivable from the code itself.",
    "2. Likely useful next session — would change a future approach.",
    "3. Anchorable — fits a file, entity, glob, or (rarely) project-wide.",
    "",
    "DSL: kind|anchor|polarity|content",
    "  kind ∈ {cnv,rul,wrn,dec,blk,fct}",
    "  anchor ∈ {f:<path>, e:<entity>, g:<glob>, p:}",
    "  polarity ∈ {+,-,~}",
    "",
    "  unerr_remember({",
    "    type: 'note',",
    "    note: 'rul|f:src/proxy/bridge.ts|-|no intelligence imports',",
    "    session_id: '<sid>'",
    "  })",
    "",
    "Session save cap: 15. Over the cap, you'll get reinforcement candidates back — reinforce instead of writing new.",
  ].join("\n"),
  category: "workflow",
  trigger: { type: "always" },
  tools: ["unerr_remember"],
  version: "1.0.0",
};

export const LOCAL_SKILLS: SkillDefinition[] = [
  TOKEN_EFFICIENT_SKILL,
  FILE_READ_PROTOCOL_SKILL,
  GRAPH_FIRST_NAVIGATION_SKILL,
  UNDERSTAND_BEFORE_MODIFY_SKILL,
  BLAST_RADIUS_FIRST_SKILL,
  CONVENTION_AWARE_GENERATION_SKILL,
  DEPENDENCY_AWARE_REFACTOR_SKILL,
  SAFE_MODIFICATION_WORKFLOW_SKILL,
  ARCHITECTURE_EXPLORATION_SKILL,
  SESSION_CONTEXT_PRESERVATION_SKILL,
  TIMELINE_MARKERS_SKILL,
  TURN_DISCIPLINE_SKILL,
  USER_FED_MEMORY_SKILL,
  UNERR_PROMPT_RECEIPT_SKILL,
  UNERR_ANCHOR_QUERY_SKILL,
  UNERR_SAVE_AT_END_SKILL,
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
}> = LOCAL_SKILLS.map((s) => ({
  name: s.id,
  description: s.description,
  content: s.instructions,
  version: s.version,
}));

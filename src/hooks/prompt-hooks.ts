/**
 * UserPromptSubmit hook — appends a concise unerr tool reminder to user prompt context.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Fires on every user message. Routes through:
 *   - Path A (T3.1): keyword fast path — verb cluster → named sub-skill.
 *   - Path B (T3.2): always-on skill catalog ("available skills:" block).
 *   - T3.4: cross-session stitch — surfaces prior session's last
 *     `mark_intent`, once per session.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { supportsDelegation } from "../config/agent-registry.js";
import {
  type DelegationDecision,
  shouldDelegate,
} from "../intelligence/delegation.js";
import { classifyInjectionTier } from "../intelligence/task-size.js";
import {
  readNudgeState,
  resetOneShotsOnNewConversation,
  updateNudgeState,
} from "../proxy/nudge-state.js";
import { recordPrefixStability } from "../proxy/prefix-stability.js";
import { juniorHandoff } from "../skills/junior-agent.js";
import { OPT_IN_SKILLS, isOptInSkill } from "../skills/local-pack.js";
import { readOptInSkills } from "../skills/skill-opt-in.js";
import {
  recordInjectionTelemetry,
  recordOneShotEmit,
} from "../tracking/injection-meter.js";
import type { IdeType } from "../utils/detect.js";
import {
  type AsyncHookHandler,
  type HookHandler,
  type HookResult,
  enrich,
  passthrough,
  runPromptSubmitHook,
  runPromptSubmitHookAsync,
} from "./hook-runner.js";
import {
  type ActCandidate,
  assembleInjectionBlock,
} from "./injection-policy.js";
import {
  readProxySessionId,
  recordUserPromptReceived,
} from "./prompt-capture.js";
import { type RecalledTrace, queryRecallTraces } from "./recall-client.js";
import { detectUserRule } from "./remember-client.js";

// ── Path A: keyword fast path — verb clusters → named sub-skills ─────────────
// Mirrors docs/identity-impact-redesign.md §3 Path A table. Each cluster
// owns a disjoint verb set and routes to exactly one named sub-skill.

export interface VerbCluster {
  /** Cluster id — stable, used by tests and telemetry. */
  id: string;
  /** Named sub-skill the agent should invoke. */
  skill: string;
  /** Word-boundary anchored regex matching this cluster's verbs. */
  pattern: RegExp;
}

// Post-consolidation (27→7) — multiple verb clusters intentionally route to
// the same consolidated skill. The uniqueness invariant is removed; the
// consolidated body absorbs the lifecycles of the prior individual skills.
export const VERB_CLUSTERS: VerbCluster[] = [
  {
    id: "bug",
    skill: "unerr-build-and-debug",
    pattern:
      /\b(bug|broken|failing|crash|crashed|error|errors|regression|debug)\b/i,
  },
  {
    id: "build",
    skill: "unerr-build-and-debug",
    pattern: /\b(build|create|add|implement|design|scaffold)\b/i,
  },
  // Edit verbs route to the orchestrator, which owns the default edit workflow
  // (recall → blast-radius → conventions → drift → edit) absorbed from the former
  // safe-modification skill.
  {
    id: "refactor",
    skill: "unerr-using-unerr",
    pattern:
      /\b(refactor|rename|move|restructure|extract|inline|migrate|cleanup)\b/i,
  },
  {
    id: "fix",
    skill: "unerr-using-unerr",
    pattern: /\b(fix|modify|change|update|tweak|replace|revert|optimize)\b/i,
  },
  // Review verbs split (2026-05): PRODUCING a review of your own changes →
  // unerr-review; ADDRESSING review comments someone left you → unerr-test-
  // and-review Track B. `review-comments` is checked FIRST because it is the
  // more specific case (it requires a comment / feedback / "address …" signal);
  // bare review/audit/critique falls through to the producer. "review this PR"
  // is producing a review, so it stays on the producer — only "PR feedback",
  // "review comments", or "address the review" route to the addresser.
  {
    id: "review-comments",
    skill: "unerr-test-and-review",
    pattern:
      /\b(review[- ]comments?|code[- ]review[- ]comments?|pr[- ]feedback|pull[- ]request[- ]feedback|(?:reviewer|review)[- ]feedback|address(?:ing)?[- ](?:the[- ]|these[- ]|my[- ])?(?:review|comments?|feedback))\b/i,
  },
  {
    id: "review",
    skill: "unerr-review",
    pattern:
      /\b(review|audit|critique|self[- ]review|pre[- ]commit|before[- ]commit)\b/i,
  },
  {
    id: "test",
    skill: "unerr-test-and-review",
    pattern: /\b(test|tests|tdd|spec|specs)\b/i,
  },
  {
    id: "navigation",
    skill: "unerr-exploration",
    pattern:
      /\b(find|search|where|who[- ]calls|callers|callees|dependencies|import|imports|hotspot|hotspots)\b/i,
  },
  // No `memory` cluster: "remember / always / from now on / never" rules are
  // captured automatically by the UserPromptSubmit hook (remember-client.ts) —
  // there is no `unerr-memory` skill to invoke (removed 2026-06, invoked 0×).
];

export interface VerbClusterMatch {
  cluster: string;
  skill: string;
}

/** Path A — return the FIRST verb cluster that matches, or null when
 *  no cluster fires. Order in VERB_CLUSTERS encodes precedence: bug
 *  beats fix (a crashed feature is a debug task, not a tweak); refactor
 *  beats fix (`rename` is structural, not a tweak). */
export function classifyVerbCluster(prompt: string): VerbClusterMatch | null {
  const trimmed = prompt.trim();
  if (trimmed.length < 4) return null;
  for (const c of VERB_CLUSTERS) {
    if (c.pattern.test(trimmed)) return { cluster: c.id, skill: c.skill };
  }
  return null;
}

/** Narrow imperative-verb set — matches when the prompt clearly asks
 *  for a coding task that warrants `mark_intent` (build/fix/refactor/
 *  rename/etc.). Excludes the broader navigation/discovery verbs used by
 *  `TASK_VERBS_CODE`. */
export const TASK_VERBS_NARROW =
  /\b(implement|fix|add|refactor|build|debug|update|change|modify|create|delete|remove|rewrite|migrate|wire|extract|inline|rename|split|merge|integrate|hook|register|replace|revert|optimize|cleanup|move|restructure|consolidate|tweak|audit|review)\b/i;

/** Pure-question detector — same imperative set minus the
 *  navigation/build verbs that frequently appear inside a leading
 *  question fragment. */
const TASK_VERBS_NARROW_NO_NAV =
  /\b(implement|fix|add|refactor|build|debug|update|change|modify|create|delete|remove|rewrite|migrate|replace|revert|optimize|cleanup|move|restructure|consolidate|tweak|audit|review)\b/i;

/** Broader code-context verb set — true when the prompt is "about code"
 *  even if it is a question, a navigation request, or a bug report.
 *  Decides the tool-roster phrasing, not whether `mark_intent` fires. */
export const TASK_VERBS_CODE =
  /\b(fix|bug|add|implement|refactor|debug|update|change|modify|create|delete|remove|test|find|search|where|who calls|callers|dependencies|import|replace|rename|revert|optimize|cleanup|extract|inline|move|restructure|consolidate|migrate|tweak|audit|review|broken|failing|crash|error|regression)\b/i;

/** Broader implementation-intent matcher — catches outcome-phrased prompts
 *  ("build X", "make Y work", "get Z working", "set up W", "new endpoint") that
 *  the `TASK_VERBS_CODE` word list misses but which are still code tasks. Drives
 *  both `isCodeContext` (so a bare "build X" gets the unerr tool push) and the
 *  once-per-session build-decompose nudge. The once-per-session gate keeps a rare
 *  false positive cheap (one line, not per-turn), so a loose match is acceptable. */
const BUILD_INTENT_RE =
  /\b(build|create|implement|scaffold|develop)\b|\b(set|wire)[ -]?up\b|\bmake\b[^.?!]{0,40}\bwork(?:ing)?\b|\bget\b[^.?!]{0,40}\bworking\b|\bnew\s+(feature|endpoint|component|page|service|module|integration)\b/i;

/** Coarse "this prompt implies multiple independent slices" signal — gates the
 *  stronger plan-into-tracker nudge so a single-slice fix never draws a
 *  5-task-tracker demand (the over-fire that trains ignore-behavior). Fires on
 *  broad-scope verbs (refactor/migrate/audit/rewrite/restructure/consolidate/
 *  overhaul), breadth phrasing (across the codebase / every / all callers /
 *  all these / these changes|tasks|files), or an explicit enumerated list. */
export const MULTI_SLICE_RE =
  /\b(refactor|migrate|audit|rewrite|restructure|consolidate|overhaul)\b|\b(across|throughout)\b[^.?!]{0,30}\b(codebase|repo|project|files?)\b|\b(every|all)\b[^.?!]{0,20}\b(callers?|files?|usages?|sites?|modules?)\b|\ball\s+(these|the|of\s+these)\b|\bthese\s+(changes|tasks|files|slices|edits)\b/i;

/** Explicit sequential-step phrasing — the prompt spells out an ordered plan
 *  the parallel-slice signals miss: "first … then …", "step 1 … step 2",
 *  "and then", "after that", "once X, Y", "finally". A long SEQUENTIAL task
 *  (dependent steps, not independent slices) that the user still wants
 *  externalized into the tracker. */
export const SEQUENTIAL_STEPS_RE =
  /\b(step|phase|stage)\s*\d+\b|\bstep\s+(one|two|three|four|five|first|second|third)\b|\bfirst\b[^.?!]{0,90}\b(then|next|second|after(?:wards?)?|finally|lastly|and\s+then)\b|\b(and\s+then|then\s+(also|next|we|you|i)\b|after\s+that|afterwards?\b|once\s+(that|it|you|done|complete|finished)\b|followed\s+by|finally,|lastly\b)/i;

/** Action verbs counted ONLY to size the multi-step signal — broader than
 *  `TASK_VERBS_CODE` so a real chained prompt ("broaden X and verify Y then
 *  disable Z") registers each step. Not a code-context gate: over-inclusion
 *  here only upgrades the delegate nudge to its tracker variant, never gates
 *  whether the nudge fires. Global so `match` returns every occurrence. */
const STEP_ACTION_RE =
  /\b(add|fix|implement|build|create|update|change|modify|remove|delete|refactor|rename|move|extract|inline|replace|revert|wire|gate|broaden|narrow|verify|confirm|ensure|disable|enable|check|test|review|audit|investigate|trace|document|configure|install|uninstall|run|migrate|optimize|handle|support|integrate|set\s?up|clean\s?up)\b/gi;

/** A coordinator token that joins two actions into a sequence or list. */
const STEP_COORDINATOR_RE = /\b(and|then|also|plus|next|after|afterwards)\b|;/i;

/** True when the prompt looks like a long or multi-step task — worth a
 *  plan-into-tracker nudge. Fires on: a build/create/implement intent, a
 *  broad-scope/breadth signal, an enumerated list (2+ bullets or ordinals),
 *  explicit sequential-step phrasing, OR 2+ distinct action verbs joined by a
 *  coordinator ("fix X and add Y"). Covers SEQUENTIAL multi-step work, not only
 *  independent parallel slices. */
export function isMultiSlice(prompt: string): boolean {
  const t = prompt.trim();
  if (t.length < 20) return false;
  if (MULTI_SLICE_RE.test(t) || BUILD_INTENT_RE.test(t)) return true;
  if (SEQUENTIAL_STEPS_RE.test(t)) return true;
  // Enumerated list: 2+ "- " / "* " bullets, or "1." "2." ordinal markers.
  const bullets = (t.match(/^\s*[-*]\s+/gm) ?? []).length;
  const ordinals = (t.match(/(?:^|\s)\d+[.)]\s+/g) ?? []).length;
  if (bullets >= 2 || ordinals >= 2) return true;
  // 2+ distinct action verbs joined by a coordinator → a task with multiple
  // steps ("fix the bug and add a test", "broaden A then verify B").
  const actions = t.match(STEP_ACTION_RE);
  if (actions) {
    const distinct = new Set(
      actions.map((a) => a.toLowerCase().replace(/\s+/g, ""))
    );
    if (distinct.size >= 2 && STEP_COORDINATOR_RE.test(t)) return true;
  }
  return false;
}

/** Unified classification result. */
export interface PromptClassification {
  /** True when the prompt warrants `mark_intent` (narrow imperative). */
  is_task: boolean;
  /** Path A verb-cluster match, or null when no cluster fires. */
  verb_cluster: VerbClusterMatch | null;
  /** True when the prompt is "about code" — drives tool-roster phrasing. */
  is_code: boolean;
}

/** True when the prompt is "about code" (navigation, debugging, change
 *  requests, or bug reports). Broader than `classifyAsTask`. */
export function isCodeContext(prompt: string): boolean {
  return TASK_VERBS_CODE.test(prompt) || BUILD_INTENT_RE.test(prompt);
}

/** True when `prompt` ends in "?" with no imperative/narrow verb before the
 *  mark — a pure Q&A turn ("where is X enforced?") rather than an actionable
 *  request. Shared by `classifyAsTask` and the decompose-delegate gate in
 *  `promptSubmitHandler` so both apply the exact same Q&A exclusion instead
 *  of two drifting rules. */
function isPureQuestionPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return (
    trimmed.endsWith("?") &&
    !TASK_VERBS_NARROW_NO_NAV.test(trimmed.split("?")[0] ?? "")
  );
}

/** Rule-based task classifier — detects whether a prompt is a coding
 *  task that warrants `mark_intent`. Coding-task verbs win; pure
 *  questions (ending in `?` without an imperative verb) opt out. */
function classifyAsTask(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 10) return false;
  if (!TASK_VERBS_NARROW.test(trimmed)) return false;
  // Pure question with no imperative — let it slide as a question.
  return !isPureQuestionPrompt(prompt);
}

/** Unified classifier — combines verb-cluster routing, task detection,
 *  and code-context detection into a single shape. Cheap (three regex
 *  tests over the same string) and side-effect free. */
export function classifyPrompt(prompt: string): PromptClassification {
  return {
    is_task: classifyAsTask(prompt),
    verb_cluster: classifyVerbCluster(prompt),
    is_code: isCodeContext(prompt),
  };
}

// Sprint 7 (T7.7): buildTurnSummaryLine + buildReceiptEscalationLine removed.
// The close-out economy line is now produced server-side by the Stop hook
// (stop-hooks.ts → computeTurnSummaryLine) at zero round-trip, so the agent is
// never asked to call unerr_turn_summary. The miss-accumulator they drove
// (consecutive_receipt_misses) is obsolete for hook-capable agents; the field
// survives in nudge-state for the MCP-fallback path (turn-summary-handler.ts
// still resets it when a hook-less agent calls the tool) and the dashboard.

// The stable/volatile boundary, the per-turn line/char caps, and the
// head→boundary→tail assembly now live in one place — `injection-policy.ts`
// (Issue 6). `PREFIX_VOLATILE_BOUNDARY` is re-exported there.

// ── Path A emit ──────────────────────────────────────────────────────────────
/** Emit one `ur|act` line for a matched Path A cluster (skill invocation
 *  is an action — skl folded into act on the wire 2026-05-24). Imperative,
 *  names the skill, no hedge verbs. */
function buildPathALine(match: VerbClusterMatch): string {
  return `ur|act invoke Skill('${match.skill}') before drafting code.`;
}

// ── Delegation emit ──────────────────────────────────────────────────────────
/** Emit the delegation routing line for a delegable task. Fires ONLY when
 *  `shouldDelegate` returned `delegate:true` (host supports delegation and the
 *  prompt named a delegable class). Points straight at the sub-agent handoff —
 *  the delegate WORKFLOW is now an opt-in skill, so the default nudge names the
 *  capability (the Task sub-agent / exec) as a direct command, not a Skill() to
 *  invoke; imperative ("<handoff> now"), no hedge verbs, no deictic pronouns. */
function buildDelegateLine(
  decision: DelegationDecision,
  agentId: IdeType
): string {
  // Host-specific handoff: each delegation host hands the work to a sub-agent
  // differently — Claude Code via the on-disk `unerr-junior`/`unerr-worker`
  // sub-agent, Codex / Cursor / Copilot CLI via their own non-interactive exec
  // with a model flag. The CLASS picks the tier (tests/mechanical_refactor →
  // worker, lint_format/docs/recon → junior). juniorHandoff emits ONLY the path
  // for THIS host — naming another is noise the agent can't act on.
  const handoff = juniorHandoff(agentId, decision.class);
  return `ur|act delegate — '${decision.class}' is delegable: ${handoff} now, hand it the recon brief, then review the diff. Do NOT enumerate edit sites by hand — the brief carries them.`;
}

/** True when the skill a verb cluster points at is actually on disk for this
 *  repo: default skills always; opt-in skills only when the user installed them
 *  (`unerr skill install`). Path A must NOT tell the agent to invoke a `Skill()`
 *  the default install never wrote — when it isn't installed, suppress the line
 *  and let the always-on `unerr-using-unerr` fallback take the routing slot. */
function isClusterSkillInstalled(
  skillName: string,
  optedIn: Set<string>
): boolean {
  const bare = skillName.replace(/^unerr-/, "");
  return !isOptInSkill(bare) || optedIn.has(bare);
}

/** Once-per-session decompose-and-delegate nudge for a composite build/debug
 *  prompt. Real prompts ("build the export flow", "make login work") are
 *  senior-class, so the delegable-CLASS delegate nudge never fires — yet the
 *  build implicitly contains delegable slices (tests, lint/format, docstrings,
 *  recon, caller/import propagation, typecheck/build fixes, scaffold, verify-runs,
 *  shell-command runs) the agent tends to do itself on the main thread. This
 *  points the agent at decomposing and handing those slices to sub-agents for
 *  better performance. Imperative, names the sub-agents, no hedge verbs, no cost
 *  framing.
 *
 *  Planner mode: on a MULTI-SLICE turn on a task-tracker-capable host
 *  (claude-code), returns the stronger plan-into-tracker command — externalize
 *  the plan into the built-in task tracker (TaskCreate one task per slice)
 *  BEFORE fanning out, then complete/clear the tracker at turn end. The tracker
 *  is the forcing function that turns an in-head plan into concrete, assignable,
 *  closeable slices; without it delegation stays a one-off. Single-slice work or
 *  a host with no tracker keeps the lighter fan-out line. */
function buildDecomposeDelegateLine(opts: {
  multiSlice: boolean;
  trackerCapable: boolean;
}): string {
  if (opts.multiSlice && opts.trackerCapable) {
    return "ur|act plan-then-track — multi-step task: TaskCreate one task per step before editing, TaskUpdate each to in_progress when you start it and completed as it lands; fan out one Task subagent_type:'unerr-worker'/'unerr-junior' per independent step in ONE message (disjoint files); keep design/wiring/root-cause on the main thread; clear the tracker at turn end.";
  }
  return "ur|act delegate-slices — delegation is the default: plan the change, then fan out one Task sub-agent per independent slice in parallel (worker for edits/tests/refactor/caller-propagation/build-fixes/scaffold, junior for lint/@sem/recon/verify-runs/shell); keep design/wiring/root-cause on the main thread; review each diff.";
}

// ── Path B emit (T3.2) ───────────────────────────────────────────────────────
/** Placeholder skill catalog — mirrors docs §3 Path B until the
 *  parallel `using-unerr` master skill agent lands the live frontmatter
 *  injector. Each line is one-skill-per-row, two-space indent, with the
 *  description starting at a fixed column for legibility. */
const OPT_IN_SKILL_BLURBS: Record<string, string> = {
  exploration:
    "find callers, callees, hotspots, or unfamiliar code (graph-first)",
  "build-and-debug":
    "a guarded build (Track A) or bug-forensics (Track B) workflow",
  "test-and-review":
    "a guarded TDD (Track A) or review-response (Track B) workflow",
  review:
    "produce an evidenced review of your own changes before commit — breaking callers, contract drift, duplicate logic",
  delegate:
    "partition a delegable task into disjoint groups and hand each to a sub-agent, then review the diffs",
};

export function buildSkillCatalog(cwd: string = process.cwd()): string {
  // The default install ships ONLY the loose always-on skill (its body is already
  // in context), so there is nothing on-demand to advertise by default. List the
  // rigid lifecycle skills ONLY when the user opted into them (`unerr skill
  // install <id>`) — advertising an uninstalled skill produces a Skill() the
  // agent cannot run. No opt-ins → empty catalog (caller skips it).
  const optedIn = readOptInSkills(cwd);
  const installed = OPT_IN_SKILLS.filter((s) => optedIn.has(s.id));
  if (installed.length === 0) return "";
  const header = "opt-in skills you installed — invoke if even 1% relevant:";
  const rows = installed.map(
    (s) => `  - unerr-${s.id} — ${OPT_IN_SKILL_BLURBS[s.id] ?? s.name}`
  );
  return [header, ...rows].join("\n");
}

// ── T3.4 — cross-session stitch ──────────────────────────────────────────────
/**
 * Minimal sync read of `.unerr/ledger/shadow.jsonl` to find the prior
 * session's last `mark_intent` and any unresolved `mark_blocker`
 * markers. "Unresolved" = no later `mark_resolution` ledger entry whose
 * `args_summary.blocker_ref` matches the blocker's id.
 *
 * Stays minimal: no schema changes, no async DB access from a hook
 * (Claude Code spawns the hook as a separate process; async cozo init
 * would blow the latency budget). Reads up to the last ~256 entries.
 */
export interface CrossSessionStitch {
  /** The last `mark_intent` text emitted before the current session
   *  started. Empty string when none found. */
  lastIntent: string;
  /** Texts of every unresolved `mark_blocker` from prior sessions. */
  openBlockers: string[];
}

interface RawLedgerEntry {
  id?: string;
  ts?: string;
  tool?: string;
  session_id?: string;
  args_summary?: { text?: unknown; blocker_ref?: unknown };
}

/** Read shadow ledger entries from disk synchronously. Returns [] on
 *  any read failure (hook must fail-open). */
function readShadowLedgerSync(cwd: string): RawLedgerEntry[] {
  try {
    const path = join(cwd, ".unerr", "ledger", "shadow.jsonl");
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    const out: RawLedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as RawLedgerEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Resolve marker text from a ledger entry's args_summary.text field. */
function entryText(e: RawLedgerEntry): string {
  const t = e.args_summary?.text;
  return typeof t === "string" ? t : "";
}

/** Find last intent + open blockers from all ledger entries NOT in the
 *  current session. Exported for tests. */
export function computeCrossSessionStitch(
  entries: RawLedgerEntry[],
  currentSessionId: string
): CrossSessionStitch {
  const priorEntries = entries.filter(
    (e) => typeof e.session_id === "string" && e.session_id !== currentSessionId
  );
  // Walk newest → oldest by array order (ledger is append-only, so the
  // last array element is the newest write).
  let lastIntent = "";
  const blockerById = new Map<string, string>(); // id → text (unresolved)
  // Iterate forward to track id → text, then a second pass for resolutions.
  for (const e of priorEntries) {
    if (e.tool === "mark_intent") {
      lastIntent = entryText(e); // overwrites — final value is the newest
    } else if (e.tool === "mark_blocker") {
      if (typeof e.id === "string" && e.id.length > 0) {
        blockerById.set(e.id, entryText(e));
      }
    } else if (e.tool === "mark_resolution") {
      const ref = e.args_summary?.blocker_ref;
      if (typeof ref === "string" && ref.length > 0) {
        blockerById.delete(ref);
      }
    }
  }
  return {
    lastIntent,
    openBlockers: [...blockerById.values()].filter((t) => t.length > 0),
  };
}

/**
 * One-shot cross-session stitch (T3.4). Returns the picked-up-intent
 * line on the first qualifying prompt of a session, then null forever.
 * Fails-open: any read or state failure → null (passthrough).
 */
export function buildCrossSessionStitchLine(cwd: string): string | null {
  try {
    const state = readNudgeState(cwd);
    if (state.cross_session_stitch_emitted) return null;
    const currentSessionId =
      process.env.UNERR_SESSION_ID ?? `pid-${process.pid}`;
    const entries = readShadowLedgerSync(cwd);
    if (entries.length === 0) {
      // Nothing to stitch — mark emitted anyway so we don't keep reading
      // the empty file on every prompt this session.
      updateNudgeState(cwd, (s) => {
        s.cross_session_stitch_emitted = true;
      });
      return null;
    }
    const stitch = computeCrossSessionStitch(entries, currentSessionId);
    if (stitch.lastIntent.length === 0) {
      updateNudgeState(cwd, (s) => {
        s.cross_session_stitch_emitted = true;
      });
      return null;
    }
    updateNudgeState(cwd, (s) => {
      s.cross_session_stitch_emitted = true;
    });
    // rsm → act on the wire (14→4 consolidation 2026-05-24).
    return `ur|act picking up: ${stitch.lastIntent}`;
  } catch {
    return null;
  }
}

/**
 * Agent-agnostic prompt submit handler.
 * Injects a brief tool-preference reminder into user prompt context.
 *
 * Nudge v2 (N1): when UNERR_NUDGE_V2=1, only fire on the first non-trivial
 * prompt of a session, then go silent until the next session. v1 default
 * behavior (fire on every prompt ≥10 chars) is preserved.
 */
const promptSubmitHandler: HookHandler = (normalized) => {
  // Extract the user's message to detect if it's code-related
  const raw = normalized.raw;
  const message = (raw.user_message ?? raw.prompt ?? "") as string;

  // Skip for very short messages (likely confirmations like "yes", "ok", "continue")
  if (message.length < 10) return passthrough();

  // Re-arm conversation-scoped one-shot nudges when the agent starts a NEW
  // conversation. The nudge flags file is keyed on the long-lived proxy session
  // id (one proxy serves many conversations), so without this every "once per
  // session" reminder — including the cross-session stitch line above — fires
  // once per proxy lifetime and then goes silent for every later conversation.
  // Idempotent within a conversation (no-op when the native id is unchanged).
  // Never blocks the hook.
  try {
    resetOneShotsOnNewConversation(
      process.cwd(),
      normalized.nativeSessionId ?? null
    );
  } catch {
    /* never block the hook */
  }

  // Session-history anchor for the self-referential / tampered-check
  // weak-verify shapes (Port B): stamp the turn boundary so `postBashHandler`
  // can scope `readEditLogSince` to just this turn's own edits instead of the
  // whole session. `asyncPromptSubmitHandler` calls this sync handler first,
  // so stamping here covers both entry points. Never blocks the hook.
  try {
    updateNudgeState(process.cwd(), (s) => {
      s.turn_started_ts = Date.now();
    });
  } catch {
    /* never block the hook */
  }

  // Fix J — verbatim prompt capture against {session_id, turn}. Best-effort,
  // never blocks. Honours `capture_prompts` flag in `.unerr/config.json`
  // (default false): operational metadata always written, verbatim content
  // only when opt-in. Anchored on session_id so the join into Token Flow /
  // Reasoning Quality / Logbook trace pages reaches the right turn.
  try {
    const cwd = process.cwd();
    // Key the prompt-boundary event to the LIVE proxy session id (read from
    // `.unerr/state/session.id`) so it joins Token Flow / behavior events in
    // ONE per-session timeline. The agent's own `raw.session_id` is a
    // different namespace and would never join — fall back to it only when no
    // proxy is up (file absent).
    const sessionId =
      readProxySessionId(join(cwd, ".unerr")) ??
      (raw.session_id as string | undefined) ??
      "unknown";
    const cluster = classifyVerbCluster(message);
    recordUserPromptReceived({
      unerrDir: join(cwd, ".unerr"),
      cwd,
      sessionId,
      message,
      classifiedAs: cluster?.cluster ?? null,
      hookPayloadChars:
        typeof raw === "object" ? JSON.stringify(raw).length : 0,
      agent: (raw.agent as string | undefined) ?? normalized.agentName,
      // The agent's own conversation id + label, resolved per-agent by the
      // adapter (Claude `session_id`, Cursor `conversation_id`). Written to the
      // shared sessions file so the proxy can attach it to its own rows.
      nativeSessionId: normalized.nativeSessionId ?? null,
      sessionName: normalized.sessionName ?? null,
    });
  } catch {
    /* never block the hook */
  }

  // N1 — Tier 0 one-shot session onboarding (opt-in)
  if (process.env.UNERR_NUDGE_V2 === "1") {
    try {
      const cwd = process.cwd();
      const state = readNudgeState(cwd);
      if (state.tier0_emitted) return passthrough();
      updateNudgeState(cwd, (s) => {
        s.tier0_emitted = true;
      });
    } catch {
      // State unavailable — fall through to v1 behaviour
    }
  }

  // Delegation — when the task is a delegable class AND the host
  // supports delegation, route the volatile skill slot to `unerr-delegate`
  // (hand to a cheaper model) instead of the normal lifecycle skill.
  // `shouldDelegate` is the gate; this call is the runtime trigger. Fail-open:
  // any error leaves `delegateLine` null and the normal Path A routing stands.
  let delegateLine: string | null = null;
  // feature_impl never draws the single delegate line (the decompose nudge
  // below owns it) — hoisted so the decompose gate can still fire on
  // feature_impl prompts whose wording misses isCodeContext's word list
  // ("add a --json flag", "make X configurable").
  let delegableFeatureImpl = false;
  try {
    const agentId = (normalized.agentName ?? "") as IdeType;
    const decision = shouldDelegate({ prompt: message, agentId });
    delegableFeatureImpl =
      decision.delegate && decision.class === "feature_impl";
    // feature_impl is the broad scoped-work class — it overlaps the substantive
    // decompose-and-delegate nudge below, which gives richer fan-out guidance
    // (one sub-agent per slice) and still routes to the worker tier. Let that
    // nudge own the routing slot; the single delegate line stays for the narrow
    // classes (tests / lint / codemod / caller_propagation / typecheck_fix / …).
    if (decision.delegate && decision.class !== "feature_impl") {
      delegateLine = buildDelegateLine(decision, agentId);
      // Issue 5 leak correlation — arm the pending flag. The Stop hook clears
      // it; if no `delegate` marker lands in the close-out, the master kept the
      // delegable work and the leak fires. Best-effort — never block the hook.
      try {
        updateNudgeState(process.cwd(), (s) => {
          s.delegable_nudge_pending = true;
        });
      } catch {
        /* best effort */
      }
    }
  } catch {
    // never block the hook — fall through to normal routing
  }

  // Code-task gate — computed ONCE here (was duplicated lower for the static
  // tail). Path A, its fallback, and the static roster all gate on this. A
  // non-code prompt (a question, a chat aside, "what does X do") must NOT draw
  // a skill-dispatch nudge — those misfired on loose verb matches ("add",
  // "find", "fix") in plain questions and trained the agent to ignore the slot.
  const isCodeTask = isCodeContext(message);

  // Opt-in awareness: the rigid lifecycle skills are NOT installed by default,
  // so a Path A line naming Skill('unerr-build-and-debug') etc. would point the
  // agent at a skill that does not exist. Resolve what is actually on disk once.
  const optedInSkills = (() => {
    try {
      return readOptInSkills(process.cwd());
    } catch {
      return new Set<string>();
    }
  })();

  // Path A — verb-cluster fast path. Gated on isCodeTask: a verb cluster only
  // routes to a skill on an actual code task. When Lever C delegates, the
  // delegate line OWNS the routing slot — skip Path A so the agent gets exactly
  // one skill instruction.
  const pathAMatch = classifyVerbCluster(message);

  // Build-delegate nudge — a composite build/debug prompt is senior-class (the
  // delegable-CLASS delegate nudge never fires for "build X" / "make Y work"),
  // yet it implies delegable slices (tests, lint/format, docstrings, recon) the
  // agent tends to do itself on the main thread. On a delegation-capable host,
  // when the rigid build skill is NOT opted in, remind the agent EVERY
  // substantive (code + build/bug) turn to decompose and fan those slices out to
  // sub-agents (one per independent slice, no fixed cap). Suppressed when the
  // user opted into the rigid build-and-debug
  // skill (it owns the workflow).
  let buildDecomposeLine: string | null = null;
  try {
    const agentId = (normalized.agentName ?? "") as IdeType;
    // A build/bug verb cluster, OR outcome-phrased implementation intent
    // ("make X work", "set up Y") the cluster classifier misses.
    const isBuildIntent =
      (!!pathAMatch &&
        (pathAMatch.cluster === "build" || pathAMatch.cluster === "bug")) ||
      BUILD_INTENT_RE.test(message);
    // Broaden past build-intent: any substantive code-WORK prompt (refactor,
    // migrate, restructure, consolidate, audit, move) carries delegable slices
    // too, yet most of those phrasings miss BUILD_INTENT_RE and never drew the
    // fan-out nudge. classifyAsTask is the narrow imperative-work signal that
    // ALREADY excludes pure questions / chat / design-discussion, so OR-ing it
    // in widens coverage to non-build work turns WITHOUT firing on questions.
    // Widened further: `isCodeTask` (below) already excludes non-code chatter,
    // so any code-task prompt that is NOT a pure question also qualifies — this
    // catches ordinary scoped requests and bug reports ("the retry delay is
    // broken for long sessions") that miss both BUILD_INTENT_RE and
    // classifyAsTask's narrow-verb list. `isPureQuestionPrompt` reuses
    // classifyAsTask's own Q&A rule, so a real question ("where is the idle
    // timeout enforced?") still skips the build nudge and routes to the
    // junior/recon path instead.
    const isSubstantiveTask =
      isBuildIntent ||
      classifyAsTask(message) ||
      !isPureQuestionPrompt(message);
    // Suppress only when the user opted into the rigid build-and-debug skill for
    // a build/bug cluster — that skill then owns the workflow.
    const rigidBuildOptedIn =
      !!pathAMatch &&
      (pathAMatch.cluster === "build" || pathAMatch.cluster === "bug") &&
      isClusterSkillInstalled(pathAMatch.skill, optedInSkills);
    if (
      !delegateLine &&
      (isCodeTask || delegableFeatureImpl) &&
      isSubstantiveTask &&
      !rigidBuildOptedIn &&
      supportsDelegation(agentId)
    ) {
      // Re-arm every substantive turn: delegation is the default execution mode,
      // so the decompose-and-delegate nudge fires on each build/bug code turn —
      // not once per session — to keep sub-agents fanning out per turn. The
      // line is tail-appended additionalContext (cache-safe), so per-turn firing
      // adds no prefix-cache cost.
      // Planner mode: a multi-slice turn on a task-tracker-capable host
      // (claude-code) gets the stronger plan-into-tracker command; single-slice
      // work or a host with no tracker keeps the lighter fan-out line.
      const trackerCapable = normalized.agentName === "claude-code";
      const multiSlice = isMultiSlice(message);
      buildDecomposeLine = buildDecomposeDelegateLine({
        multiSlice,
        trackerCapable,
      });
      // Arm the planner-mode leak/telemetry flags only when the tracker variant
      // fired — the Stop hook reads tracker_open_pending to emit the
      // complete/clear-the-tracker close-out reminder once per opening.
      // Best-effort, mirrors the delegable_nudge_pending arming above; never
      // blocks the hook.
      if (multiSlice && trackerCapable) {
        try {
          updateNudgeState(process.cwd(), (s) => {
            s.tracker_open_pending = true;
            s.tracker_nudge_emitted_count += 1;
          });
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    // fail-open — no build nudge, normal routing stands
  }

  // Path A only names a skill that is actually installed. For an uninstalled
  // opt-in skill the line is suppressed and the always-on `unerr-using-unerr`
  // fallback below takes the routing slot.
  const pathALine =
    delegateLine ||
    buildDecomposeLine ||
    !pathAMatch ||
    !isCodeTask ||
    !isClusterSkillInstalled(pathAMatch.skill, optedInSkills)
      ? null
      : buildPathALine(pathAMatch);

  // T3.3 — omni-skill fallback. When Path A misses/suppresses AND no delegation
  // or build-decompose nudge fired AND it is a code task, point the agent at the
  // always-on `unerr-using-unerr` skill (loose tool guidance). Skipped on
  // non-code prompts.
  const fallbackLine =
    pathALine || delegateLine || buildDecomposeLine || !isCodeTask
      ? null
      : "ur|act unerr-using-unerr — no verb-cluster match. Invoke Skill('unerr-using-unerr') and use unerr's tools before drafting code.";

  // T3.4 — cross-session stitch (one-shot per session). Not ur|act.
  let stitchPrefix = "";
  try {
    const stitchLine = buildCrossSessionStitchLine(process.cwd());
    if (stitchLine) stitchPrefix = `${stitchLine}\n`;
  } catch {
    // fail-open
  }

  // Sprint 7 (T7.7): the close-out economy line fires automatically via the
  // Stop hook (stop-hooks.ts) on every agent whose AGENT receives this hook
  // output (claude-code — promptContextInject implies a Stop channel for every
  // built+planned profile). unerr_turn_summary is therefore hidden for them
  // (agent-aware advertisement), so the old STEP-N "call unerr_turn_summary"
  // nudge + its miss-escalation are removed here — emitting them would name a
  // tool the agent can no longer see and double the close-out the Stop hook
  // already delivers. Hook-less agents keep the MCP tool advertised and learn
  // it from their alwaysApply instruction file, not this hook.

  // ── Hard gates (NUDGE_V2 plan §3.4) ─────────────────────────────────
  // Gate 1: per-turn cap of 5 ur|act lines. Order = priority high→low.
  // Lines beyond the cap are dropped to prevent context flooding.
  // Path A and fallback are mutually exclusive — only one is non-null.
  // Each candidate carries a `volatile` flag for the prefix ordering:
  // the Path A line varies per prompt (verb cluster), so it is volatile; every
  // other line is a fixed nudge template (byte-stable) and belongs in the
  // cacheable head. Order + cap semantics are unchanged from before.
  // The per-turn cap (5), per-line char cap (800), the stable/volatile split,
  // and the head→boundary→tail ordering all live in `injection-policy.ts` now.
  // Order = priority high→low; Path A and fallback are mutually exclusive (only
  // one is non-null). `volatile` drives ordering: the Path A line varies per
  // prompt so it rides the tail; every other line is a fixed template.
  const actCandidates: ActCandidate[] = [
    { text: delegateLine, volatile: true }, //       Lever C delegation routing (class-specific)
    { text: buildDecomposeLine, volatile: false }, // Build decompose+delegate (once/session, fixed)
    { text: pathALine, volatile: true }, //          Path A skill match (verb-specific)
    { text: fallbackLine, volatile: false }, //      Master orchestrator fallback (fixed)
  ];

  // Path B — static tool-roster + skill catalog. Both duplicate the cached
  // CLAUDE.md tool-routing section and the installed `.claude/skills/` menu, so
  // re-injecting them on every turn is pure uncacheable re-bill (token-tax #7).
  // Emit once per session (first enrich turn); later turns rely on the cached
  // instruction file + the per-turn Path A skill-dispatch line. The
  // prompt-specific signal (stitch, ur|act lines, and the trace-recall lines
  // the async handler appends) still rides every turn.
  let staticEmitted = false;
  try {
    staticEmitted = readNudgeState(process.cwd()).static_boilerplate_emitted;
  } catch {
    // State unavailable — treat as not-yet-emitted (fail toward emitting once).
  }

  // W6 — trivial-turn floor: defer the once-per-session roster until the first
  // CODE turn. A trivial/non-code prompt (a question, a chat aside) gets none of
  // the static boilerplate, so its injection footprint approaches the fixed
  // floor (§8). The roster still fires exactly once — on the first code turn —
  // and the cached instruction file already carries the same routing meanwhile.
  // `isCodeTask` is computed once near the top (gates Path A + fallback too).
  // Claude Code carries the SAME tool-routing section in its cached `CLAUDE.md`
  // (system prompt, always present) and lists the installed `.claude/skills/`
  // menu natively — so the roster + catalog are pure duplication for it. Skip
  // the static tail entirely for claude-code; the per-turn four-moment ur|act
  // lines + recall block (the non-duplicated product value) still ride every
  // turn. Hook-less / non-claude agents keep the roster (their instruction file
  // is not in the same cached system prompt the same way).
  const skipStaticTail = normalized.agentName === "claude-code";
  let staticTail = "";
  if (!staticEmitted && isCodeTask && !skipStaticTail) {
    // Reached only on a code turn (gated above), so the roster is always the
    // code-work phrasing.
    const toolRoster =
      "[unerr] Prefer unerr MCP tools for code work (faster, graph-backed, project-aware): " +
      "`search_code` (NOT grep/glob) · `get_references` (NOT grep for fn names) · " +
      "`file_read` (NOT built-in Read for understanding) · `file_edit` to change files — old_string+new_string to edit, or content for a whole file (no built-in Read needed) · " +
      "`file_outline` · `search_code({detail:true})` for one symbol's profile.";
    const catalog = buildSkillCatalog(process.cwd());
    staticTail = catalog ? `${toolRoster}\n\n${catalog}` : toolRoster;
    try {
      updateNudgeState(process.cwd(), (s) => {
        s.static_boilerplate_emitted = true;
      });
    } catch {
      // Best-effort — a missed write just re-emits next turn (still correct).
    }
    // Issue 6 leak — the static tail is once-per-session. A durable (session.id-
    // keyed) stamp catches a re-emit caused by the nudge-state flags-file reset,
    // recording one_shot_refire_detected. Best-effort, never blocks the hook.
    recordOneShotEmit(process.cwd(), "static_boilerplate");
  }

  // Emit ONE block ordered stable-head → boundary → volatile-tail so the
  // cacheable leading bytes stay byte-stable turn-to-turn. The cap, the char
  // cap, the stable/volatile split, and the ordering all live in
  // `assembleInjectionBlock`. Stable = fixed nudge templates + roster/catalog;
  // volatile = resume/stitch, the verb-specific Path A line, and (appended by
  // the async handler) the trace-recall lines.
  const { stableHead, ordered } = assembleInjectionBlock(
    actCandidates,
    staticTail,
    [stitchPrefix]
  );
  // prefix_stable measures the cacheable HEAD this ordering protects.
  if (stableHead.length > 0) recordPrefixStability(process.cwd(), stableHead);

  // Issue 6/7 telemetry — record what the injection brain decided this turn:
  // which route it chose (delegate / Path A / orchestrator fallback) and whether
  // it withheld the once-per-session static block. Observability only; best-
  // effort, cache-safe, never blocks the hook.
  try {
    const route = delegateLine
      ? "delegate"
      : pathALine
        ? "path-a-skill"
        : fallbackLine
          ? "orchestrator-fallback"
          : undefined;
    // The static tail is suppressed when it would otherwise be relevant (a code
    // task) but was already spent this session or is skipped as cached-duplicate
    // for claude-code. A non-code/trivial turn carries no roster, so it is not a
    // "withhold" worth recording.
    const suppressed =
      isCodeTask && staticTail.length === 0 && (staticEmitted || skipStaticTail)
        ? skipStaticTail
          ? "static-roster (cached in CLAUDE.md for claude-code)"
          : "static-roster (already emitted this session)"
        : undefined;
    recordInjectionTelemetry(process.cwd(), {
      ...(route ? { routed: route } : {}),
      ...(suppressed ? { suppressed } : {}),
    });
  } catch {
    /* best effort — telemetry never blocks the hook */
  }
  // Nothing prompt-specific to inject (all one-shots spent, no recall/drift/
  // stitch, static boilerplate already emitted) → stay passthrough rather than
  // emit an empty additionalContext.
  if (ordered.trim().length === 0) return passthrough();
  return enrich(ordered);
};

/**
 * UserPromptSubmit hook handler.
 * Returns JSON string for stdout.
 */
export function runUserPromptSubmitHook(stdinJson: string): string {
  return runPromptSubmitHook(stdinJson, promptSubmitHandler);
}

// ── Cap A-2: trace injection helpers ─────────────────────────────────────────

const MAX_SITUATION_LEN = 60;
const MAX_UNLOCK_LEN = 60;

/**
 * Format one recalled trace as a single ur|fct JOURNAL line per the nudge
 * rules: named anchor, real values, truncated long fields. Date-stamped and
 * past-tense by design — the line reports a dated journal entry ("what
 * happened then"), never asserts present truth; the agent re-verifies against
 * today's code before acting on it.
 */
function formatTraceLine(t: RecalledTrace): string {
  const dateStamp =
    t.resolved_at > 0
      ? `resolved ${new Date(t.resolved_at).toISOString().slice(0, 10)}`
      : "undated";
  const situation =
    t.situation.length > MAX_SITUATION_LEN
      ? `${t.situation.slice(0, MAX_SITUATION_LEN - 1)}…`
      : t.situation;

  let deadEndsPart = "";
  if (t.dead_ends) {
    try {
      const arr = JSON.parse(t.dead_ends) as string[];
      const parts = arr
        .slice(0, 2)
        .map((d) => d.split("/").pop() ?? d)
        .filter(Boolean);
      if (parts.length > 0) deadEndsPart = ` · dead ends: ${parts.join(", ")}`;
    } catch {
      const trimmed = t.dead_ends.slice(0, 40);
      deadEndsPart = ` · dead ends: ${trimmed}`;
    }
  }

  const unlock =
    t.unlock.length > MAX_UNLOCK_LEN
      ? `${t.unlock.slice(0, MAX_UNLOCK_LEN - 1)}…`
      : t.unlock;

  const anchorPart = t.anchor ? ` (e:${t.anchor})` : "";

  return `ur|fct past incident (${dateStamp}) — symptom then: ${situation}${deadEndsPart} · fix then: ${unlock}${anchorPart}`;
}

/** Cap A-2 output cap: at most 1 past-incident line per turn, even when the
 *  tier budget (`traceMax`) requested more from the proxy — 2+ simultaneous
 *  incidents in one turn crowd out the load-bearing signal. */
const MAX_INJECTED_TRACES = 1;

/** Terms too common to signal relevance on their own — a small, deliberately
 *  generic list; this is a cheap overlap gate, not an NLP model. */
const RECALL_STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "were",
  "will",
  "would",
  "could",
  "should",
  "about",
  "into",
  "only",
  "also",
  "then",
  "than",
  "when",
  "what",
  "where",
  "which",
  "while",
  "does",
  "doing",
  "done",
  "just",
  "them",
  "they",
  "their",
  "there",
  "here",
  "your",
  "yours",
  "some",
  "such",
  "each",
  "more",
  "most",
  "over",
  "under",
  "after",
  "before",
  "during",
  "being",
  "these",
  "those",
  "because",
  "since",
  "still",
  "even",
  "very",
  "much",
  "many",
  "both",
  "across",
  "every",
]);

/** Splits `text` into significant terms — lowercased words longer than 3
 *  chars, minus `RECALL_STOPWORDS`. Shared by the recall relevance gate. */
function extractSignificantTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (word.length > 3 && !RECALL_STOPWORDS.has(word)) terms.add(word);
  }
  return terms;
}

/**
 * True when a recalled trace is relevant enough to inject into THIS prompt's
 * context: the trace's anchor (entity key or file path) is named in the
 * prompt, or at least 2 significant terms (>3 chars, non-stopword) overlap
 * between the trace's symptom/fix text and the prompt. The server's TF-IDF
 * ranking alone lets same-repo-but-unrelated incidents through (e.g. a
 * cozo-worker memory-leak trace surfacing on an unrelated benchmark-run
 * prompt); this is the prompt-specific filter layered on top of that ranking.
 */
function isTraceRelevantToPrompt(t: RecalledTrace, prompt: string): boolean {
  const lowerPrompt = prompt.toLowerCase();
  if (t.anchor) {
    const anchorLower = t.anchor.toLowerCase();
    const base = anchorLower.split("/").pop() ?? anchorLower;
    if (
      lowerPrompt.includes(anchorLower) ||
      (base.length > 3 && lowerPrompt.includes(base))
    ) {
      return true;
    }
  }
  const promptTerms = extractSignificantTerms(prompt);
  if (promptTerms.size === 0) return false;
  const traceText = `${t.situation} ${t.unlock} ${t.dead_ends}`;
  let overlap = 0;
  for (const term of extractSignificantTerms(traceText)) {
    if (promptTerms.has(term)) {
      overlap += 1;
      if (overlap >= 2) return true;
    }
  }
  return false;
}

/** Cap on the quoted rule text in the CLAUDE.md-redirect nudge. */
const MAX_RULE_QUOTE_CHARS = 140;

/**
 * Phase 3 (active-memory strip) — on a detected user-rule directive, inject a
 * `ur|act` line telling the agent to write the rule verbatim into the repo's
 * own instruction file (CLAUDE.md / AGENTS.md), rather than persisting it to a
 * separate store. Fires on EVERY detection (no one-shot gate) and upgrades a
 * passthrough result to an enriching one so the nudge is never dropped.
 */
function injectClaudeMdRedirect(base: HookResult, rule: string): HookResult {
  const quoted =
    rule.length > MAX_RULE_QUOTE_CHARS
      ? `${rule.slice(0, MAX_RULE_QUOTE_CHARS - 1)}…`
      : rule;
  const line = `ur|act write this rule into CLAUDE.md now — the user stated a durable rule; add it verbatim to this repo's CLAUDE.md (or AGENTS.md) before continuing: "${quoted}". unerr does not store user rules — the instruction file is the only durable home.`;
  try {
    updateNudgeState(process.cwd(), (s) => {
      s.claude_md_redirect_count = (s.claude_md_redirect_count ?? 0) + 1;
    });
  } catch {
    /* best effort — emission still proceeds */
  }
  if (base.action === "enrich" && base.message) {
    return enrich(`${line}\n${base.message}`);
  }
  return enrich(line);
}

/**
 * Recall-injecting prompt-submit handler (Phase-2 Sprint 7; Phase 3
 * active-memory strip).
 *
 * Runs the same synchronous assembly as {@link promptSubmitHandler}, then two
 * additional things: (1) on a detected user-rule directive, injects the
 * CLAUDE.md-redirect nudge ({@link injectClaudeMdRedirect}) regardless of
 * whether the turn is code-context; (2) on coding-task prompts, fetches
 * matching trace-recall (past-incident journal) rows from the warm proxy over
 * UDS and appends them as `ur|fct` lines (Cap A-2).
 *
 * Strictly additive + degrade-safe: if the proxy is unreachable, the prompt is
 * non-code, or recall is empty, the result carries only the redirect nudge (if
 * any) plus the sync assembly. The UDS query never throws (recall-client
 * contract) and is time-boxed, so it can't stall the turn.
 */
const asyncPromptSubmitHandler: AsyncHookHandler = async (normalized) => {
  const base = promptSubmitHandler(normalized);

  const raw = normalized.raw;
  const message = (raw.user_message ?? raw.prompt ?? "") as string;

  // Phase 3 — CLAUDE.md redirect. Fires on EVERY detection, even on a
  // passthrough turn (a one-line "from now on, always X" must still surface
  // the nudge even though it otherwise warrants no injection).
  const rule = detectUserRule(message);
  const withRedirect = rule ? injectClaudeMdRedirect(base, rule) : base;

  // Only enrich an enrich — passthrough turns (short / one-shot-spent prompts,
  // net of the redirect above) stay passthrough. Trace recall rides only
  // code-context enrich turns.
  if (withRedirect.action !== "enrich" || !withRedirect.message) {
    return withRedirect;
  }
  if (!message || !isCodeContext(message)) {
    return withRedirect;
  }

  // Option A — gate trivial turns; the tier still scales the trace budget.
  // classifyInjectionTier classifies this prompt as skip/focused/broad.
  // inject:false → skip trace recall entirely (saves uncacheable tokens on
  // turns where a past incident adds no load-bearing signal).
  const decision = classifyInjectionTier(message);
  if (!decision.inject) {
    try {
      updateNudgeState(process.cwd(), (s) => {
        s.injection_skip_count = (s.injection_skip_count ?? 0) + 1;
      });
    } catch {
      // best-effort; never block the hook
    }
    return withRedirect;
  }
  try {
    updateNudgeState(process.cwd(), (s) => {
      if (decision.tier === "focused") {
        s.injection_focused_count = (s.injection_focused_count ?? 0) + 1;
      } else {
        s.injection_broad_count = (s.injection_broad_count ?? 0) + 1;
      }
    });
  } catch {
    // best-effort; never block the hook
  }

  // Cap A-2 trace budget: focused→1, broad→up-to-3. decision.inject is true
  // here, so only those two tiers reach this line. ur|fct lines are advisory
  // and do NOT count toward the 5-line act cap.
  const traceMax = decision.tier === "focused" ? 1 : 3;

  try {
    const traces = await queryRecallTraces(message, traceMax).catch(() => null);
    const relevant = traces?.filter((t) => isTraceRelevantToPrompt(t, message));
    const traceLines =
      relevant && relevant.length > 0
        ? relevant.slice(0, MAX_INJECTED_TRACES).map(formatTraceLine).join("\n")
        : null;

    if (traceLines) {
      return enrich(`${withRedirect.message}\n${traceLines}`);
    }
  } catch {
    // recall-client never throws, but stay defensive — fall back to the nudge.
  }
  return withRedirect;
};

/**
 * Async UserPromptSubmit entry — the default the `unerr hook prompt-submit`
 * command dispatches to. Injects warm recall when the proxy is up, falls back
 * to the static nudge otherwise.
 */
export async function runUserPromptSubmitHookAsync(
  stdinJson: string
): Promise<string> {
  return runPromptSubmitHookAsync(stdinJson, asyncPromptSubmitHandler);
}

/**
 * UserPromptSubmit hook — appends a concise unerr tool reminder to user prompt context.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Fires on every user message. Routes through:
 *   - Path A (T3.1): keyword fast path — verb cluster → named sub-skill.
 *   - Path B (T3.2): always-on skill catalog ("available skills:" block).
 *   - T3.4: cross-session stitch — surfaces prior session's last
 *     `mark_intent` and any unresolved `mark_blocker` markers, once
 *     per session.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DelegationDecision,
  shouldDelegate,
} from "../intelligence/delegation.js";
import {
  DEFAULT_RECALL_MAX,
  selectLoadBearing,
} from "../intelligence/note-ranking.js";
import { consumeAnyPendingTopicShift } from "../intelligence/topic-shift.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { recordPrefixStability } from "../proxy/prefix-stability.js";
import { juniorHandoff } from "../skills/junior-agent.js";
import type { IdeType } from "../utils/detect.js";
import {
  type AsyncHookHandler,
  type HookHandler,
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
import { queryRecallNotes, renderRecallBlock } from "./recall-client.js";
import { captureUserRule, detectUserRule } from "./remember-client.js";

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

/** Drain any pending topic-shift signal and return a `ur|fct` line, or
 *  null when no shift is pending. */
function buildTopicShiftLine(): string | null {
  const shift = consumeAnyPendingTopicShift();
  if (!shift || !shift.flag) return null;
  const pct = Math.round(shift.overlap * 100);
  // hnt → fct on the wire (14→4 consolidation 2026-05-24). Sprint 7 (T7.3):
  // recall reran for this prompt via the hook — point at the injected notes,
  // not the (now-hidden) unerr_recall_notes call.
  return `ur|fct topic-shift detected (overlap ${pct}%) — anchored-note recall reran for this prompt; read the fresh \`ur|fct\` notes injected above before drafting`;
}

/** Narrow imperative-verb set — matches when the prompt clearly asks
 *  for a coding task that warrants `mark_intent` (build/fix/refactor/
 *  rename/etc.). Excludes the broader navigation/discovery verbs used by
 *  `TASK_VERBS_CODE`. */
export const TASK_VERBS_NARROW =
  /\b(implement|fix|add|refactor|build|debug|update|change|modify|create|delete|remove|rewrite|migrate|wire|extract|inline|rename|split|merge|integrate|hook|register|replace|revert|optimize|cleanup|move|restructure|tweak|audit|review)\b/i;

/** Pure-question detector — same imperative set minus the
 *  navigation/build verbs that frequently appear inside a leading
 *  question fragment. */
const TASK_VERBS_NARROW_NO_NAV =
  /\b(implement|fix|add|refactor|build|debug|update|change|modify|create|delete|remove|rewrite|migrate|replace|revert|optimize|cleanup|move|restructure|tweak|audit|review)\b/i;

/** Broader code-context verb set — true when the prompt is "about code"
 *  even if it is a question, a navigation request, or a bug report.
 *  Decides the tool-roster phrasing, not whether `mark_intent` fires. */
export const TASK_VERBS_CODE =
  /\b(fix|bug|add|implement|refactor|debug|update|change|modify|create|delete|remove|test|find|search|where|who calls|callers|dependencies|import|replace|rename|revert|optimize|cleanup|extract|inline|move|restructure|migrate|tweak|audit|review|broken|failing|crash|error|regression)\b/i;

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
  return TASK_VERBS_CODE.test(prompt);
}

/** Rule-based task classifier — detects whether a prompt is a coding
 *  task that warrants `mark_intent`. Coding-task verbs win; pure
 *  questions (ending in `?` without an imperative verb) opt out. */
function classifyAsTask(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 10) return false;
  if (!TASK_VERBS_NARROW.test(trimmed)) return false;
  // Pure question with no imperative — let it slide as a question.
  const isPureQuestion =
    trimmed.endsWith("?") &&
    !TASK_VERBS_NARROW_NO_NAV.test(trimmed.split("?")[0] ?? "");
  return !isPureQuestion;
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

/** One-shot mark_intent reminder. Returns the line on first qualifying
 *  prompt of a session, then null forever (per #47565 — repeating the
 *  reminder makes the agent argue with the hook). Increments the
 *  session-level required counter every call so #109's compliance
 *  ratio is meaningful. */
function buildMarkIntentLine(prompt: string): string | null {
  if (!classifyAsTask(prompt)) return null;
  try {
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    updateNudgeState(cwd, (s) => {
      s.mark_intent_required_count += 1;
    });
    if (state.mark_intent_emitted) return null;
    updateNudgeState(cwd, (s) => {
      s.mark_intent_emitted = true;
    });
  } catch {
    return null;
  }
  return "ur|act record this turn's intent with zero round-trip — emit `unerr-save: intent <one-sentence summary, ≤80 chars>` anywhere in your closing message (the Stop hook persists it; no tool call). Required on every coding task (implement/fix/refactor/build/debug); skip only for a pure read-only question.";
}

// Sprint 7 (T7.7): buildTurnSummaryLine + buildReceiptEscalationLine removed.
// The close-out economy line is now produced server-side by the Stop hook
// (stop-hooks.ts → computeTurnSummaryLine) at zero round-trip, so the agent is
// never asked to call unerr_turn_summary. The miss-accumulator they drove
// (consecutive_receipt_misses) is obsolete for hook-capable agents; the field
// survives in nudge-state for the MCP-fallback path (turn-summary-handler.ts
// still resets it when a hook-less agent calls the tool) and the dashboard.

/** Lever C — Moment 1 (prompt-receipt recall) reminder. Fires on every
 *  coding-task prompt — the four-moment contract REQUIRES recall on every
 *  prompt receipt, not once per session. Token-cheap: a single line that
 *  names the tool + arg shape. The agent fills in `<verbatim>` from the
 *  prompt that just arrived. */
/** The STEP-0 recall nudge text. Exported as a constant so the async
 *  recall-injecting handler can STRIP it from the assembled output on turns
 *  where the warm proxy already injected the notes — emitting both the notes
 *  AND "call unerr_recall_notes BEFORE any other tool" forces the exact
 *  round-trip the injection eliminated (the T7.7 double-charge). The nudge
 *  survives verbatim only when injection did not happen (proxy down / empty /
 *  non-code), so removal never opens a runtime gap. */
// Sprint 7 (T7.3/T7.7): on agents that accept prompt-time context (the only
// agents whose AGENT sees this hook's output — Cursor's beforeSubmitPrompt can
// only reach the user) anchored-note recall already ran server-side and is
// injected above. The nudge no longer instructs calling unerr_recall_notes —
// that tool is hidden for these agents (advertisement is agent-aware) and the
// call would be redundant. Phrased as state + a read action, not a tool call.
const MOMENT1_RECALL_NUDGE =
  "ur|act read any `ur|fct`/anchored notes shown for this prompt before drafting — anchored-note recall already ran; no notes shown means none matched.";

// The stable/volatile boundary, the per-turn line/char caps, and the
// head→boundary→tail assembly now live in one place — `injection-policy.ts`
// (Issue 6). `PREFIX_VOLATILE_BOUNDARY` is re-exported there.

function buildMoment1Line(prompt: string): string | null {
  if (!classifyAsTask(prompt)) return null;
  try {
    updateNudgeState(process.cwd(), (s) => {
      s.moment1_emitted_count += 1;
    });
  } catch {
    /* best effort — emission still proceeds */
  }
  return MOMENT1_RECALL_NUDGE;
}

/** Lever C — Moment 3 (cite recalled notes in the plan). Fires once per
 *  session on the first coding-task prompt. Reminds the agent that when
 *  drafting a plan or implementation strategy, any anchored notes
 *  returned from `unerr_recall_notes` must be cited inline by kind +
 *  anchor — no citation means the note was not load-bearing. One-shot
 *  to avoid argue-back noise on long-running tasks (#47565). */
function buildMoment3PlanCiteLine(prompt: string): string | null {
  if (!classifyAsTask(prompt)) return null;
  try {
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    if (state.moment3_emitted) return null;
    updateNudgeState(cwd, (s) => {
      s.moment3_emitted = true;
    });
  } catch {
    return null;
  }
  return "ur|act WHEN drafting a plan or implementation strategy this session: cite every load-bearing anchored note recalled for this prompt inline by kind + anchor (e.g. `per the wrn on src/proxy/bridge.ts`). No citation = the note was not load-bearing.";
}

// ── Path A emit ──────────────────────────────────────────────────────────────
/** Emit one `ur|act` line for a matched Path A cluster (skill invocation
 *  is an action — skl folded into act on the wire 2026-05-24). Imperative,
 *  names the skill, no hedge verbs. */
function buildPathALine(match: VerbClusterMatch): string {
  return `ur|act ${match.skill} — Path A matched verb cluster '${match.cluster}'. Invoke Skill('${match.skill}') before drafting code.`;
}

// ── Delegation emit ──────────────────────────────────────────────────────────
/** Emit the `ur|act unerr-delegate` routing line for a delegable task. Fires
 *  ONLY when `shouldDelegate` returned `delegate:true` (host supports delegation
 *  and the prompt named a delegable class). Names the skill + the class so the
 *  senior routes to `unerr-delegate` instead of the normal lifecycle skill;
 *  imperative, no hedge verbs, no deictic pronouns (echoes the class string). */
function buildDelegateLine(
  decision: DelegationDecision,
  agentId: IdeType
): string {
  // Host-specific handoff: each delegation host hands the edit to a cheaper tier
  // differently — Claude Code via the on-disk `unerr-junior`/`unerr-worker`
  // sub-agent, Codex / Cursor / Copilot CLI via their own non-interactive exec
  // with a model flag. The CLASS picks the tier (tests/mechanical_refactor →
  // middle model, lint_format/docs/recon → worker model). juniorHandoff emits
  // ONLY the path for THIS host — naming another is noise the agent can't act on.
  const handoff = juniorHandoff(agentId, decision.class);
  return `ur|act unerr-delegate — delegable class '${decision.class}'. Invoke Skill('unerr-delegate') to ${handoff}, then review the diff. Do NOT enumerate edit sites by hand — the recon brief carries them.`;
}

// ── Path B emit (T3.2) ───────────────────────────────────────────────────────
/** Placeholder skill catalog — mirrors docs §3 Path B until the
 *  parallel `using-unerr` master skill agent lands the live frontmatter
 *  injector. Each line is one-skill-per-row, two-space indent, with the
 *  description starting at a fixed column for legibility. */
export function buildSkillCatalog(): string {
  // 2026-06 usage-driven consolidation (9→6): safe-modification folded into the
  // orchestrator's default workflow; memory + markers removed (run via hooks +
  // the instruction file, invoked 0× via Skill()). The catalog mirrors the 6
  // unerr-prefixed skills shipped in .claude/skills/. Order matches the dispatch
  // table in unerr-using-unerr SKILL.md.
  const entries: Array<[string, string]> = [
    [
      "unerr-using-unerr",
      "orchestrator — dispatches to a sub-skill, or runs the default edit workflow (recon → blast radius → conventions → drift → edit) when none matches",
    ],
    [
      "unerr-exploration",
      "use when finding callers, callees, hotspots, or unfamiliar code (graph-first)",
    ],
    [
      "unerr-build-and-debug",
      "use when building a new feature (Track A) or chasing a bug / failing test (Track B)",
    ],
    [
      "unerr-test-and-review",
      "use for TDD (Track A) or addressing review comments / PR feedback (Track B)",
    ],
    [
      "unerr-review",
      "use to produce a review of your own changes before commit — breaking callers, contract drift, duplicate logic (NOT for addressing review comments left by others)",
    ],
    [
      "unerr-delegate",
      "use for a delegable task (add tests, docstring/@sem, mechanical rename/extract/inline/move, lint) on a delegation-capable host (Claude Code / Codex)",
    ],
  ];
  const header = "available skills — invoke if even 1% relevant:";
  const rows = entries.map(([id, desc]) => `  - ${id} — ${desc}`);
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
 * One-shot cross-session stitch (T3.4). Returns the stitch lines on
 * the first qualifying prompt of a session, then null forever.
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
    if (stitch.lastIntent.length === 0 && stitch.openBlockers.length === 0) {
      updateNudgeState(cwd, (s) => {
        s.cross_session_stitch_emitted = true;
      });
      return null;
    }
    updateNudgeState(cwd, (s) => {
      s.cross_session_stitch_emitted = true;
    });
    const lines: string[] = [];
    if (stitch.lastIntent.length > 0) {
      // rsm → act on the wire (14→4 consolidation 2026-05-24).
      lines.push(`ur|act picking up: ${stitch.lastIntent}`);
    }
    if (stitch.openBlockers.length > 0) {
      const list = stitch.openBlockers.slice(0, 3).join("; ");
      lines.push(
        `ur|act open blockers from prior session: ${list}. Call unerr_track({op:'resolution', blocker_ref:'<id>', text:'<fix>'}) when each is fixed.`
      );
    }
    return lines.join("\n");
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
  try {
    const agentId = (normalized.agentName ?? "") as IdeType;
    const decision = shouldDelegate({ prompt: message, agentId });
    if (decision.delegate) delegateLine = buildDelegateLine(decision, agentId);
  } catch {
    // never block the hook — fall through to normal routing
  }

  // Code-task gate — computed ONCE here (was duplicated lower for the static
  // tail). Path A, its fallback, and the static roster all gate on this. A
  // non-code prompt (a question, a chat aside, "what does X do") must NOT draw
  // a skill-dispatch nudge — those misfired on loose verb matches ("add",
  // "find", "fix") in plain questions and trained the agent to ignore the slot.
  const isCodeTask = isCodeContext(message);

  // Path A — verb-cluster fast path. Gated on isCodeTask: a verb cluster only
  // routes to a skill on an actual code task. When Lever C delegates, the
  // delegate line OWNS the routing slot — skip Path A so the agent gets exactly
  // one skill instruction.
  const pathAMatch = classifyVerbCluster(message);
  const pathALine =
    delegateLine || !pathAMatch || !isCodeTask
      ? null
      : buildPathALine(pathAMatch);

  // T3.3 — omni-skill fallback. When Path A misses AND no delegation fired AND
  // it is a code task, point the agent at the `unerr-using-unerr` master
  // orchestrator so it runs the default workflow (recall → blast radius →
  // mark_intent → edit → verify). Skipped on non-code prompts.
  const fallbackLine =
    pathALine || delegateLine || !isCodeTask
      ? null
      : "ur|act unerr-using-unerr — no verb-cluster match. Invoke Skill('unerr-using-unerr') and run the default workflow before drafting code.";

  // Topic-shift signal — ur|ctx line, NOT subject to the ur|act cap.
  const topicShiftLine = buildTopicShiftLine();
  const shiftPrefix = topicShiftLine ? `${topicShiftLine}\n` : "";

  // T3.4 — cross-session stitch (one-shot per session). Not ur|act.
  let stitchPrefix = "";
  try {
    const stitchLine = buildCrossSessionStitchLine(process.cwd());
    if (stitchLine) stitchPrefix = `${stitchLine}\n`;
  } catch {
    // fail-open
  }

  // Lever C — Moment 1 (recall_notes on prompt receipt). Fires EVERY
  // coding-task prompt. Must lead so the agent calls recall before any
  // other tool. The four-moment contract depends on this firing per-turn.
  const moment1Line = buildMoment1Line(message);

  // Lever C — Moment 3 (cite recalled notes in plan). One-shot per session.
  const moment3Line = buildMoment3PlanCiteLine(message);

  // mark_intent one-shot rides ahead of the tool roster too — the agent needs
  // to know about the contract BEFORE choosing a first tool call. Fires at
  // most once per session (see buildMarkIntentLine).
  const markIntentLine = buildMarkIntentLine(message);

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
    { text: moment1Line, volatile: false }, //   Moment 1 (fixed template)
    { text: delegateLine, volatile: true }, //   Lever C delegation routing (class-specific)
    { text: pathALine, volatile: true }, //      Path A skill match (verb-specific)
    { text: fallbackLine, volatile: false }, //  Master orchestrator fallback (fixed)
    { text: markIntentLine, volatile: false }, // mark_intent one-shot (fixed)
    { text: moment3Line, volatile: false }, //   Moment 3 one-shot (fixed)
  ];

  // Path B — static tool-roster + skill catalog. Both duplicate the cached
  // CLAUDE.md tool-routing section and the installed `.claude/skills/` menu, so
  // re-injecting them on every turn is pure uncacheable re-bill (token-tax #7).
  // Emit once per session (first enrich turn); later turns rely on the cached
  // instruction file + the per-turn Path A skill-dispatch line. The
  // prompt-specific signal (stitch, ur|act four-moment lines, topic-shift, and
  // the recall block the async handler prepends) still rides every turn.
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
      "`file_outline` · `search_code({detail:true})` for one symbol's profile. " +
      "Mark progress with zero round-trip — emit `unerr-save: intent|decision|blocker|resolution <one-line>` " +
      "in your closing message; the Stop hook persists them to the cross-session timeline.";
    staticTail = `${toolRoster}\n\n${buildSkillCatalog()}`;
    try {
      updateNudgeState(process.cwd(), (s) => {
        s.static_boilerplate_emitted = true;
      });
    } catch {
      // Best-effort — a missed write just re-emits next turn (still correct).
    }
  }

  // Emit ONE block ordered stable-head → boundary → volatile-tail so the
  // cacheable leading bytes stay byte-stable turn-to-turn. The cap, the char
  // cap, the stable/volatile split, and the ordering all live in
  // `assembleInjectionBlock`. Stable = fixed nudge templates + roster/catalog;
  // volatile = resume/stitch, topic-shift, the verb-specific Path A line, and
  // (appended by the async handler) the anchored-note recall bodies.
  const { stableHead, ordered } = assembleInjectionBlock(
    actCandidates,
    staticTail,
    [stitchPrefix, shiftPrefix]
  );
  // prefix_stable measures the cacheable HEAD this ordering protects.
  if (stableHead.length > 0) recordPrefixStability(process.cwd(), stableHead);
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

/**
 * Recall-injecting prompt-submit handler (Phase-2 Sprint 7).
 *
 * Runs the same synchronous assembly as {@link promptSubmitHandler}, then — on
 * coding-task prompts — fetches the matching anchored notes from the warm proxy
 * over UDS and PREPENDS them as real context. This replaces the model
 * round-trip the `ur|act STEP-0 … call unerr_recall_notes` nudge used to force:
 * the notes arrive injected, zero round-trip.
 *
 * Strictly additive + degrade-safe: if the proxy is unreachable, the prompt is
 * non-code, or recall is empty, the result is byte-identical to the sync path
 * (the static nudge still leads). The UDS query never throws (recall-client
 * contract) and is time-boxed, so it can't stall the turn.
 */
const asyncPromptSubmitHandler: AsyncHookHandler = async (normalized) => {
  const base = promptSubmitHandler(normalized);

  const raw = normalized.raw;
  const message = (raw.user_message ?? raw.prompt ?? "") as string;

  // T7.8 — user-rule capture (fire-and-forget). Runs on EVERY turn, even
  // passthrough ones (a one-line "from now on, always X" must be captured even
  // though it warrants no nudge). We MUST await: the hook is a short-lived
  // subprocess that exits after writing stdout, so an un-awaited write may never
  // flush. It is time-boxed (≤400ms) and degrades to false, so it can't stall.
  const rule = detectUserRule(message);
  const capturePromise: Promise<boolean> = rule
    ? captureUserRule(rule)
    : Promise.resolve(false);

  // Only enrich an enrich — passthrough turns (short / one-shot-spent prompts)
  // stay passthrough. Recall injection rides only code-context enrich turns.
  if (base.action !== "enrich" || !base.message) {
    await capturePromise; // let the capture flush before the subprocess exits
    return base;
  }
  if (!message || !isCodeContext(message)) {
    await capturePromise;
    return base;
  }

  try {
    const [notes] = await Promise.all([
      queryRecallNotes(message),
      capturePromise,
    ]);
    if (notes && notes.length > 0) {
      // W2/W5 — inject only the load-bearing top slice per turn, not every
      // matched note. The proxy returns all anchored-note matches; re-injecting
      // the full set each turn re-bills uncacheable tokens for notes the turn
      // won't act on. Rank by load-bearing score (kind/anchor/polarity/prompt
      // overlap) and keep DEFAULT_RECALL_MAX; the rest stay reachable via
      // a task-shaped search_code query, which the moment-1 line already points the agent to.
      const topNotes = selectLoadBearing(notes, {
        prompt: message,
        max: DEFAULT_RECALL_MAX,
      });
      const block = renderRecallBlock(topNotes);
      if (block) {
        // The recall bodies are volatile, so APPEND them to the tail of the
        // already-ordered block (whose stable head the sync handler emitted +
        // recorded). The Moment-1 pointer stays in the stable head — it reads
        // "notes shown for this prompt", true whether they sit above or below —
        // so the cacheable head is unchanged turn to turn. No re-record here:
        // sync already recorded the head.
        return enrich(`${base.message}\n${block}`);
      }
    }
  } catch {
    // recall-client never throws, but stay defensive — fall back to the nudge.
  }
  return base;
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
